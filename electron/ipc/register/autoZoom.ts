/**
 * Auto Zoom IPC handlers.
 *
 * Flow: record with Recordly's own HUD (armed handoff) → extract frames → LLM
 * vision analysis → user approves mindmap → derive zoom/crop/CC/audio →
 * assemble .recordly → open in editor.
 *
 * The LLM pass uses Claude claude-sonnet-4-6 (vision) via the Anthropic SDK, so it
 * understands the actual app on screen rather than relying on DOM extraction.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { ipcMain, type WebContents } from "electron";
import Anthropic from "@anthropic-ai/sdk";
import {
  createAutoZoomWindow,
  showAutoZoomWindow,
  setAutoZoomWindowClosedListener,
} from "../../windows";
import { setAutoZoomArmed, setAutoZoomFinalizedCallback } from "../autoZoom/handoff";
import { deriveZoomRegionsFromCursor } from "../autoZoom/zoomFromCursor";
import { IDENTITY_CROP } from "../autoZoom/types";
import type {
  AutoZoomAnalysis,
  AutoZoomContentRect,
  AutoZoomProgress,
  AutoZoomSummary,
} from "../autoZoom/types";
import { getFfmpegBinaryPath } from "../ffmpeg/binary";
import { parseFfmpegDurationSeconds, validateRecordedVideo } from "../recording/diagnostics";
import { rememberApprovedLocalReadPath } from "../project/manager";

export type { AutoZoomAnalysis, AutoZoomFeature, AutoZoomProgress, AutoZoomSummary } from "../autoZoom/types";

// ── State ─────────────────────────────────────────────────────────────────────

let activeVideoPath = "";
let activeCursorPath = "";
let activeAnalysis: AutoZoomAnalysis | null = null;
let activeConversation: string[] = [];
let activeFrameDir = "";
/** Real probed video duration (ffmpeg), not the LLM's guess — see auto-zoom:analyze. */
let activeDurationMs = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function send(wc: WebContents | null, evt: AutoZoomProgress): void {
  if (wc && !wc.isDestroyed()) wc.send("auto-zoom:progress", evt);
}

function anthropicClient(): Anthropic {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");
  return new Anthropic({ apiKey: key });
}

/** Extract one frame every `intervalSecs` seconds, up to `maxFrames`. */
async function extractFrames(videoPath: string, outDir: string, intervalSecs = 2, maxFrames = 60): Promise<string[]> {
  await fsp.mkdir(outDir, { recursive: true });
  const ffmpeg = await getFfmpegBinaryPath();
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpeg, [
      "-i", videoPath,
      "-vf", `fps=1/${intervalSecs}`,
      "-vframes", String(maxFrames),
      "-q:v", "4",
      path.join(outDir, "frame_%04d.jpg"),
      "-y",
    ]);
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
    proc.on("error", reject);
  });
  const files = (await fsp.readdir(outDir))
    .filter((f) => f.endsWith(".jpg"))
    .sort()
    .map((f) => path.join(outDir, f));
  return files;
}

/** Convert up to maxFrames evenly sampled from the frame list to base64 for the LLM. */
async function framesToBase64(framePaths: string[], maxFrames = 20): Promise<Array<{ path: string; b64: string }>> {
  const step = Math.max(1, Math.floor(framePaths.length / maxFrames));
  const selected = framePaths.filter((_, i) => i % step === 0).slice(0, maxFrames);
  return Promise.all(
    selected.map(async (fp) => ({
      path: fp,
      b64: (await fsp.readFile(fp)).toString("base64"),
    })),
  );
}

/** Click timestamps (ms) from the cursor sidecar — empty array when unreadable. */
function readClickTimesMs(cursorPath: string): number[] {
  try {
    const data = JSON.parse(fs.readFileSync(cursorPath, "utf-8"));
    return ((data.samples ?? []) as Array<{ timeMs: number; interactionType?: string }>)
      .filter((s) => s.interactionType === "click")
      .map((s) => s.timeMs);
  } catch {
    return [];
  }
}

/** Build cursor telemetry summary (key clicks at approximate seconds). */
function cursorSummary(cursorPath: string, totalSecs: number): string {
  const clicks = readClickTimesMs(cursorPath).map((ms) => Math.round(ms / 1000));
  if (!clicks.length) return `No click events captured. Total duration: ~${totalSecs}s.`;
  return `Click events at seconds: ${clicks.slice(0, 40).join(", ")}. Total duration: ~${totalSecs}s.`;
}

// ── LLM Analysis ─────────────────────────────────────────────────────────────

const ANALYSIS_SCHEMA = `{
  "appName": "string",
  "appCategory": "string (e.g. SaaS dashboard, e-commerce, dev tool)",
  "features": [
    {
      "name": "string",
      "description": "string (one sentence)",
      "startMs": number,
      "endMs": number,
      "interactions": [{ "label": "string", "timeMs": number }],
      "narration": "string (one short sentence for the voiceover)",
      "importance": "\"low\" | \"medium\" | \"high\" (how demo-worthy this feature is)"
    }
  ],
  "totalDurationMs": number,
  "contentRect": {
    "x": number, "y": number, "width": number, "height": number
  }
}`;

const CONTENT_RECT_GUIDANCE = `contentRect: a normalized (0-1) rectangle of the application's own content area,
excluding browser chrome (tab strip, URL/address bar, bookmarks bar). Do NOT exclude
in-app navigation, the macOS menu bar, or the dock — only literal browser chrome.
Measure precisely against the actual pixel boundary where chrome ends and page content
begins. If you are unsure of the exact boundary, err toward cropping slightly MORE —
a few extra pixels of page content is far better than leaving any sliver of chrome visible.
If no browser chrome is visible in the recording, return {"x":0,"y":0,"width":1,"height":1}.`;

async function runAnalysisLLM(
  frames: Array<{ path: string; b64: string }>,
  cursorSummaryText: string,
  videoDurationMs: number,
  priorFeedback: string[],
): Promise<AutoZoomAnalysis> {
  const client = anthropicClient();

  const frameMs = videoDurationMs / Math.max(frames.length, 1);
  const imageBlocks: Anthropic.ImageBlockParam[] = frames.map((f) => ({
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: f.b64 },
  }));
  const timeLabels = frames.map((_, i) => `Frame ${i + 1} ≈ ${Math.round((i * frameMs) / 1000)}s`).join(", ");

  const systemPrompt = `You are an expert at analysing screen recordings of web applications.
You will receive a series of JPEG frames from a recording.
Return ONLY valid JSON matching this schema — no markdown fences, no extra text:
${ANALYSIS_SCHEMA}
All time values are in milliseconds from the start of the recording.
${CONTENT_RECT_GUIDANCE}`;

  const userParts: Anthropic.MessageParam["content"] = [
    ...imageBlocks,
    {
      type: "text",
      text: `Frames in order (${frames.length} total). Frame timestamps: ${timeLabels}.
Cursor interaction summary: ${cursorSummaryText}
${priorFeedback.length ? `\nUser corrections to incorporate:\n${priorFeedback.map((f, i) => `${i + 1}. ${f}`).join("\n")}` : ""}
Analyse the recording and return the JSON schema above.`,
    },
  ];

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 3000,
    system: systemPrompt,
    messages: [{ role: "user", content: userParts }],
  });

  const raw = response.content.find((b) => b.type === "text")?.text ?? "{}";
  const clean = raw.replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, "");
  return validateAnalysis(JSON.parse(clean));
}

/**
 * Guard the LLM's JSON before it becomes `activeAnalysis` — a malformed shape
 * (missing/renamed fields, truncated response) must fail loudly here, not
 * propagate into the assembled project and crash the editor's render later
 * (there is no error boundary around the editor tree).
 */
function validateAnalysis(data: unknown): AutoZoomAnalysis {
  if (!data || typeof data !== "object") {
    throw new Error("Analysis response was not a JSON object");
  }
  const d = data as Partial<AutoZoomAnalysis>;
  if (typeof d.appName !== "string" || !Array.isArray(d.features)) {
    throw new Error("Analysis response is missing appName/features");
  }
  for (const f of d.features) {
    if (typeof f?.name !== "string" || !Array.isArray(f.interactions)) {
      throw new Error("Analysis response has a malformed feature entry");
    }
  }
  return {
    appName: d.appName,
    appCategory: typeof d.appCategory === "string" ? d.appCategory : "",
    features: d.features as AutoZoomAnalysis["features"],
    totalDurationMs:
      typeof d.totalDurationMs === "number" && Number.isFinite(d.totalDurationMs) ? d.totalDurationMs : 0,
    contentRect: d.contentRect,
  };
}

/** Extra inward push applied to any edge the LLM identified as having chrome —
 * a bit of extra cropped page beats leaving a sliver of tab/URL bar visible. */
const CROP_SAFETY_INSET = 0.015;

/** Clamp/guard the LLM's contentRect so an over-eager crop can't eat the page. */
function normalizeContentRect(rect: AutoZoomContentRect | undefined): AutoZoomContentRect {
  if (!rect) return IDENTITY_CROP;
  let x = Math.min(1, Math.max(0, rect.x ?? 0));
  let y = Math.min(1, Math.max(0, rect.y ?? 0));
  let right = Math.min(1, x + Math.max(0, rect.width ?? 1));
  let bottom = Math.min(1, y + Math.max(0, rect.height ?? 1));

  if (x > 0) x = Math.min(1, x + CROP_SAFETY_INSET);
  if (y > 0) y = Math.min(1, y + CROP_SAFETY_INSET);
  if (right < 1) right = Math.max(0, right - CROP_SAFETY_INSET);
  if (bottom < 1) bottom = Math.max(0, bottom - CROP_SAFETY_INSET);

  const width = Math.max(0, right - x);
  const height = Math.max(0, bottom - y);
  if (width < 0.5 || height < 0.5) return IDENTITY_CROP;
  return { x, y, width, height };
}

// ── Caption generation ────────────────────────────────────────────────────────

interface Caption {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
}

function analysisToCaptions(analysis: AutoZoomAnalysis): Caption[] {
  return analysis.features.map((f, i) => ({
    id: `cap-${i}`,
    startMs: f.startMs,
    endMs: f.endMs,
    text: f.narration,
  }));
}

// ── Cuts (trim dead time, head/tail AND between features) ─────────────────────

/** Editor's ClipRegion shape at speed=1 — startMs/endMs are source-video timestamps. */
interface EditorClipRegion {
  id: string;
  startMs: number;
  endMs: number;
  speed: number;
}

/** Below this, a trim isn't worth making — avoids micro-cuts from timing noise. */
const MIN_CUT_MS = 2500;
/** Mid-recording gaps shorter than this are pacing, not dead time — keep them. */
const MIN_MID_GAP_MS = 6000;
/** Padding kept around feature boundaries so cuts never clip the action. */
const CUT_PAD_MS = 1000;

/**
 * Derives the kept segments (editor ClipRegions) from the analysis:
 * - dead time before the first feature and after the last is trimmed (v3 behavior);
 * - dead gaps BETWEEN features are also cut, but only when they're long
 *   (> MIN_MID_GAP_MS), click-free (clicks mean something happened even if the
 *   LLM didn't label it), and past the end of the previous feature's narration
 *   (an audio region must never overlap a trim — export clips it, playback
 *   skips it mid-sentence).
 * The gaps between the returned clips are auto-derived as trims by the editor,
 * so playback/export join the kept segments seamlessly; the user can further
 * split/delete/adjust the clips on the timeline.
 * Returns null when there is nothing worth cutting.
 */
function deriveKeepClips(opts: {
  analysis: AutoZoomAnalysis;
  durationMs: number;
  clickTimesMs: number[];
  /** Source-time end of each feature's narration audio (parallel to features); empty when audio disabled. */
  narrationEndsMs: number[];
}): EditorClipRegion[] | null {
  const features = [...opts.analysis.features].sort((a, b) => a.startMs - b.startMs);
  if (!features.length) return null;

  const keepStartMs = Math.max(0, Math.min(opts.durationMs, features[0].startMs - CUT_PAD_MS));
  const lastEndMs = Math.max(...features.map((f) => f.endMs));
  const keepEndMs = Math.max(keepStartMs, Math.min(opts.durationMs, lastEndMs + CUT_PAD_MS));
  // Never cut down to (near) nothing — protects against bogus feature timestamps.
  if (keepEndMs - keepStartMs < MIN_CUT_MS) return null;

  // Removed ranges between consecutive features.
  const midCuts: Array<{ startMs: number; endMs: number }> = [];
  for (let i = 0; i < features.length - 1; i++) {
    const prevEndMs = Math.max(features[i].endMs, opts.narrationEndsMs[i] ?? 0);
    const nextStartMs = features[i + 1].startMs;
    if (nextStartMs - prevEndMs < MIN_MID_GAP_MS) continue;

    const cutStartMs = prevEndMs + CUT_PAD_MS;
    const cutEndMs = nextStartMs - CUT_PAD_MS;
    if (cutEndMs - cutStartMs < MIN_CUT_MS) continue;
    if (opts.clickTimesMs.some((t) => t >= cutStartMs && t <= cutEndMs)) continue;
    midCuts.push({ startMs: cutStartMs, endMs: cutEndMs });
  }

  const headCutMs = keepStartMs;
  const tailCutMs = Math.max(0, opts.durationMs - keepEndMs);
  if (headCutMs < MIN_CUT_MS && tailCutMs < MIN_CUT_MS && midCuts.length === 0) return null;

  // Kept clips = complement of the cuts within [keepStartMs, keepEndMs].
  const clips: EditorClipRegion[] = [];
  let cursor = keepStartMs;
  for (const cut of midCuts) {
    if (cut.startMs - cursor >= MIN_CUT_MS) {
      clips.push({ id: `clip-${clips.length + 1}`, startMs: cursor, endMs: cut.startMs, speed: 1 });
      cursor = cut.endMs;
    }
    // If the kept piece would be tiny, skip this cut instead (leave cursor as-is).
  }
  if (keepEndMs - cursor >= MIN_CUT_MS || clips.length === 0) {
    clips.push({ id: `clip-${clips.length + 1}`, startMs: cursor, endMs: keepEndMs, speed: 1 });
  } else {
    // Tiny trailing remainder — extend the last clip to keepEndMs instead of a micro-clip.
    clips[clips.length - 1].endMs = keepEndMs;
  }

  return clips;
}

// ── macOS TTS audio (one segment per feature) ─────────────────────────────────

interface NarrationSegment {
  featureIndex: number;
  audioPath: string;
  /** Source-time start/end of this narration region (start = feature.startMs). */
  startMs: number;
  endMs: number;
}

/** Probe an audio file's duration via ffmpeg stderr (same parse as validateRecordedVideo). */
async function probeAudioDurationMs(audioPath: string): Promise<number> {
  const ffmpeg = await getFfmpegBinaryPath();
  const stderr = await new Promise<string>((resolve) => {
    const proc = spawn(ffmpeg, ["-hide_banner", "-i", audioPath, "-f", "null", "-"]);
    let out = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    proc.on("close", () => resolve(out));
    proc.on("error", () => resolve(out));
  });
  const seconds = parseFfmpegDurationSeconds(stderr);
  return seconds && seconds > 0 ? Math.round(seconds * 1000) : 0;
}

/**
 * One TTS clip per feature, each placed at its feature's start. Per-feature
 * segments (instead of one long track) keep narration aligned to what's on
 * screen AND guarantee no audio region ever spans a trimmed gap.
 */
async function generateNarrationSegments(
  analysis: AutoZoomAnalysis,
  outDir: string,
): Promise<NarrationSegment[]> {
  if (process.platform !== "darwin") return [];
  await fsp.mkdir(outDir, { recursive: true });
  const ffmpeg = await getFfmpegBinaryPath();
  const segments: NarrationSegment[] = [];

  for (let i = 0; i < analysis.features.length; i++) {
    const feature = analysis.features[i];
    const text = feature.narration?.trim();
    if (!text) continue;

    const aiffPath = path.join(outDir, `narration-${String(i + 1).padStart(2, "0")}.aiff`);
    const mp3Path = path.join(outDir, `narration-${String(i + 1).padStart(2, "0")}.mp3`);
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("say", ["-o", aiffPath, text]);
      proc.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`say exited ${c}`))));
      proc.on("error", reject);
    });
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpeg, ["-i", aiffPath, "-q:a", "2", mp3Path, "-y"]);
      proc.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg audio exited ${c}`))));
      proc.on("error", reject);
    });
    await fsp.rm(aiffPath, { force: true });

    const durationMs = await probeAudioDurationMs(mp3Path);
    segments.push({
      featureIndex: i,
      audioPath: mp3Path,
      startMs: feature.startMs,
      endMs: feature.startMs + (durationMs || 3000),
    });
  }

  return segments;
}

// ── Refinement (chat) ─────────────────────────────────────────────────────────

async function runRefinementLLM(
  query: string,
  currentZoomRegions: unknown[],
  analysis: AutoZoomAnalysis,
): Promise<{ zoomRegions: unknown[]; message: string }> {
  const client = anthropicClient();
  const systemPrompt = `You are a video editing assistant for Recordly.
The user has auto-generated zoom regions for a product demo video.
You can adjust zoom regions based on user queries.
Return ONLY JSON: { "zoomRegions": [...same schema, modified...], "message": "short explanation" }
Zoom region schema: { id, startMs, endMs, depth (1-6), focus: {cx, cy} (0-1 normalized), mode: "auto"|"manual" }
Focus coordinates are normalized to the CROPPED frame (after any auto-crop is applied), not the raw source video.`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1500,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: `Current zoom regions:\n${JSON.stringify(currentZoomRegions, null, 2)}\n\nApp analysis:\n${JSON.stringify({ appName: analysis.appName, features: analysis.features.map((f) => ({ name: f.name, startMs: f.startMs, endMs: f.endMs })) }, null, 2)}\n\nUser query: "${query}"\n\nReturn the updated zoom regions JSON.`,
      },
    ],
  });

  const raw = response.content.find((b) => b.type === "text")?.text ?? "{}";
  const clean = raw.replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, "");
  return JSON.parse(clean);
}

// ── Project assembly ──────────────────────────────────────────────────────────

async function assembleProject(opts: {
  videoPath: string;
  zoomRegions: unknown[];
  captions: Caption[];
  narrationSegments: NarrationSegment[];
  cropRegion: AutoZoomContentRect;
  keepClips: EditorClipRegion[] | null;
  analysis: AutoZoomAnalysis;
  outDir: string;
}): Promise<string> {
  const editor = {
    zoomRegions: opts.zoomRegions,
    showCursor: true,
    loopCursor: false,
    ...(opts.cropRegion !== IDENTITY_CROP ? { cropRegion: opts.cropRegion } : {}),
    ...(opts.keepClips?.length ? { clipRegions: opts.keepClips } : {}),
    ...(opts.captions.length ? { autoCaptions: opts.captions } : {}),
    ...(opts.narrationSegments.length
      ? {
          audioRegions: opts.narrationSegments.map((seg, i) => ({
            id: `audio-${i + 1}`,
            startMs: seg.startMs,
            endMs: seg.endMs,
            audioPath: seg.audioPath,
            volume: 1,
            normalize: false,
            trackIndex: 0,
          })),
        }
      : {}),
  };

  // Minimal .recordly format (version matches PROJECT_VERSION = 1 in recordly-project-format)
  const projectData = {
    version: 1,
    videoPath: opts.videoPath,
    editor,
    // Auto-zoom metadata — editor detects this and shows the refinement panel
    autoZoom: {
      source: "auto-zoom",
      analysis: opts.analysis,
      audioPaths: opts.narrationSegments.map((seg) => seg.audioPath),
    },
  };

  await fsp.mkdir(opts.outDir, { recursive: true });
  const projectPath = path.join(opts.outDir, "project.recordly");
  await fsp.writeFile(projectPath, JSON.stringify(projectData, null, 2), "utf-8");
  return projectPath;
}

// ── IPC Registration ──────────────────────────────────────────────────────────

export function registerAutoZoomHandlers(): void {
  // The armed handoff module notifies us when a HUD recording finalizes while armed.
  setAutoZoomFinalizedCallback((videoPath, cursorPath) => {
    activeVideoPath = videoPath;
    activeCursorPath = cursorPath;
    activeAnalysis = null;
    activeConversation = [];
    activeFrameDir = path.join(os.tmpdir(), `recordly-auto-zoom-${Date.now()}`);
  });

  // Open the Auto Zoom window
  ipcMain.handle("auto-zoom:open-window", () => {
    createAutoZoomWindow();
    setAutoZoomWindowClosedListener(() => setAutoZoomArmed(false));
  });

  // Step 1 arms/disarms capture handoff — while armed, the next HUD recording
  // to finalize is handed to Auto Zoom instead of opening the editor.
  ipcMain.handle("auto-zoom:set-armed", (_e, armed: boolean) => {
    setAutoZoomArmed(Boolean(armed));
    return { success: true };
  });

  // Analyze — extract frames + LLM vision pass
  ipcMain.handle("auto-zoom:analyze", async (e, opts: { videoPath: string; cursorPath: string }) => {
    const wc = e.sender;
    activeVideoPath = opts.videoPath;
    activeCursorPath = opts.cursorPath;
    activeAnalysis = null;
    activeConversation = [];
    activeFrameDir = path.join(os.tmpdir(), `recordly-auto-zoom-${Date.now()}`);

    try {
      // Probe the real duration so frame sampling and zoom clamping cover the
      // ENTIRE recording, not just an estimated first ~2 minutes.
      const { durationSeconds } = await validateRecordedVideo(opts.videoPath);
      activeDurationMs = Math.round(durationSeconds * 1000);
      const intervalSecs = Math.max(2, Math.ceil(durationSeconds / 60));

      send(wc, { stage: "frames", status: "running", message: "Extracting frames from recording…" });
      const framePaths = await extractFrames(opts.videoPath, activeFrameDir, intervalSecs, 60);
      send(wc, { stage: "frames", status: "done", message: `Extracted ${framePaths.length} frames` });

      send(wc, { stage: "understanding", status: "running", message: "Understanding your app…" });
      const frames = await framesToBase64(framePaths, 20);
      const summary = cursorSummary(opts.cursorPath, Math.round(activeDurationMs / 1000));

      activeAnalysis = await runAnalysisLLM(frames, summary, activeDurationMs, []);
      // The LLM's own duration guess is unreliable — the probed value is ground truth.
      activeAnalysis.totalDurationMs = activeDurationMs;
      send(wc, {
        stage: "understanding",
        status: "done",
        message: `Found ${activeAnalysis.features.length} features in ${activeAnalysis.appName}`,
        payload: activeAnalysis,
      });

      return { success: true };
    } catch (err) {
      send(wc, { stage: "understanding", status: "error", message: String(err) });
      return { success: false, error: String(err) };
    }
  });

  // Refine analysis with user feedback
  ipcMain.handle("auto-zoom:refine-analysis", async (e, feedback: string) => {
    const wc = e.sender;
    if (!activeAnalysis) return { success: false, error: "No analysis to refine" };

    try {
      send(wc, { stage: "understanding", status: "running", message: "Updating understanding…" });
      activeConversation.push(feedback);

      const framePaths = fs.existsSync(activeFrameDir)
        ? (await fsp.readdir(activeFrameDir))
            .filter((f) => f.endsWith(".jpg"))
            .sort()
            .map((f) => path.join(activeFrameDir, f))
        : [];

      const videoDurationMs = activeDurationMs || activeAnalysis.totalDurationMs || framePaths.length * 2000;
      const frames = await framesToBase64(framePaths, 20);
      const summary = cursorSummary(activeCursorPath, Math.round(videoDurationMs / 1000));

      activeAnalysis = await runAnalysisLLM(frames, summary, videoDurationMs, activeConversation);
      activeAnalysis.totalDurationMs = videoDurationMs;
      send(wc, {
        stage: "understanding",
        status: "done",
        message: "Updated",
        payload: activeAnalysis,
      });

      return { success: true };
    } catch (err) {
      send(wc, { stage: "understanding", status: "error", message: String(err) });
      return { success: false, error: String(err) };
    }
  });

  // Generate — derive zooms, crop, captions, audio, assemble project
  ipcMain.handle(
    "auto-zoom:generate",
    async (e, opts: { enableCaptions: boolean; enableAudio: boolean; enableAutoCrop: boolean }) => {
      const wc = e.sender;
      if (!activeAnalysis) return { success: false, error: "No analysis available" };

      try {
        const outDir = path.join(path.dirname(activeVideoPath), `auto-zoom-${Date.now()}`);
        const durationMs = activeDurationMs || activeAnalysis.totalDurationMs;
        const cropRegion = opts.enableAutoCrop
          ? normalizeContentRect(activeAnalysis.contentRect)
          : IDENTITY_CROP;

        send(wc, { stage: "zooms", status: "running", message: "Deriving zoom regions…" });
        const { regions: zoomRegions, source, vanillaCount } = await deriveZoomRegionsFromCursor({
          cursorPath: activeCursorPath,
          analysis: activeAnalysis,
          crop: cropRegion,
          totalDurationMs: durationMs,
        });
        send(wc, {
          stage: "zooms",
          status: "done",
          message: `${zoomRegions.length} zoom regions (${source === "cursor" ? "click-derived" : "fallback"})`,
        });

        const captions: Caption[] = opts.enableCaptions ? analysisToCaptions(activeAnalysis) : [];
        if (opts.enableCaptions) {
          send(wc, { stage: "captions", status: "done", message: `${captions.length} caption segments` });
        }

        // Narration BEFORE cuts — mid-gap trim boundaries must clear each
        // feature's narration end so no audio region ever overlaps a trim.
        let narrationSegments: NarrationSegment[] = [];
        if (opts.enableAudio) {
          try {
            send(wc, { stage: "audio", status: "running", message: "Generating narration audio…" });
            narrationSegments = await generateNarrationSegments(activeAnalysis, outDir);
            send(wc, {
              stage: "audio",
              status: "done",
              message: narrationSegments.length
                ? `${narrationSegments.length} narration segments`
                : "Audio skipped (non-macOS)",
            });
          } catch (err) {
            send(wc, { stage: "audio", status: "error", message: `Audio failed: ${String(err)} — continuing without` });
          }
        }

        send(wc, { stage: "cuts", status: "running", message: "Trimming dead time…" });
        const featureList = activeAnalysis.features;
        const sortedFeatures = [...featureList].sort((a, b) => a.startMs - b.startMs);
        const narrationEndsMs = sortedFeatures.map((f) => {
          const seg = narrationSegments.find((s) => featureList[s.featureIndex] === f);
          return seg ? seg.endMs : 0;
        });
        const keepClips = deriveKeepClips({
          analysis: activeAnalysis,
          durationMs,
          clickTimesMs: readClickTimesMs(activeCursorPath),
          narrationEndsMs,
        });
        const keptMs = keepClips ? keepClips.reduce((sum, c) => sum + (c.endMs - c.startMs), 0) : durationMs;
        const trimmedMs = Math.max(0, durationMs - keptMs);
        const cutSegments = keepClips
          ? (keepClips[0].startMs > 0 ? 1 : 0) +
            (keepClips[keepClips.length - 1].endMs < durationMs ? 1 : 0) +
            (keepClips.length - 1)
          : 0;
        send(wc, {
          stage: "cuts",
          status: "done",
          message: keepClips
            ? `Removed ${cutSegments} dead segment${cutSegments === 1 ? "" : "s"} (${Math.round(trimmedMs / 1000)}s total)`
            : "No dead time to trim",
        });

        send(wc, { stage: "assemble", status: "running", message: "Assembling project…" });
        const projectPath = await assembleProject({
          videoPath: activeVideoPath,
          zoomRegions,
          captions,
          narrationSegments,
          cropRegion,
          keepClips,
          analysis: activeAnalysis,
          outDir,
        });
        await rememberApprovedLocalReadPath(projectPath);

        const summary: AutoZoomSummary = {
          appName: activeAnalysis.appName,
          autoZoomRegions: zoomRegions.length,
          vanillaRegions: vanillaCount,
          deepZooms: zoomRegions.filter((r) => r.depth >= 3).length,
          trimmedMs,
          cutSegments,
          cropApplied: cropRegion !== IDENTITY_CROP,
          captions: captions.length,
          features: activeAnalysis.features.length,
        };
        send(wc, { stage: "assemble", status: "done", message: "Project ready", payload: { projectPath, summary } });

        return { projectPath };
      } catch (err) {
        send(wc, { stage: "assemble", status: "error", message: String(err) });
        return { success: false, error: String(err) };
      }
    },
  );

  // Refinement query from the editor panel
  ipcMain.handle("auto-zoom:refinement", async (_e, _query: string) => {
    if (!activeAnalysis) return { success: false, error: "No analysis context" };
    // The renderer passes current zoom regions alongside the query
    // (handled via a separate payload in the real impl; simplified here).
    return { success: true, message: "Refinement acknowledged — apply via auto-zoom:refine-regions" };
  });

  // Refinement with current zoom regions from editor
  ipcMain.handle("auto-zoom:refine-regions", async (e, opts: { query: string; zoomRegions: unknown[] }) => {
    const wc = e.sender;
    if (!activeAnalysis) return { success: false };
    try {
      const result = await runRefinementLLM(opts.query, opts.zoomRegions, activeAnalysis);
      return { success: true, ...result };
    } catch (err) {
      send(wc, { stage: "refinement", status: "error", message: String(err) });
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle("auto-zoom:cancel", () => {
    setAutoZoomArmed(false);
    showAutoZoomWindow();
  });
}
