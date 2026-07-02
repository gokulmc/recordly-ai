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
import type { AutoZoomAnalysis, AutoZoomContentRect, AutoZoomProgress } from "../autoZoom/types";
import { getFfmpegBinaryPath } from "../ffmpeg/binary";
import { rememberApprovedLocalReadPath } from "../project/manager";

export type { AutoZoomAnalysis, AutoZoomFeature, AutoZoomProgress } from "../autoZoom/types";

// ── State ─────────────────────────────────────────────────────────────────────

let activeVideoPath = "";
let activeCursorPath = "";
let activeAnalysis: AutoZoomAnalysis | null = null;
let activeConversation: string[] = [];
let activeFrameDir = "";

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

/** Build cursor telemetry summary (key clicks at approximate seconds). */
function cursorSummary(cursorPath: string, totalSecs: number): string {
  try {
    const data = JSON.parse(fs.readFileSync(cursorPath, "utf-8"));
    const clicks: number[] = (data.samples ?? [])
      .filter((s: { interactionType?: string }) => s.interactionType === "click")
      .map((s: { timeMs: number }) => Math.round(s.timeMs / 1000));
    if (!clicks.length) return "No click events captured.";
    return `Click events at seconds: ${clicks.slice(0, 40).join(", ")}. Total duration: ~${totalSecs}s.`;
  } catch {
    return `Total duration: ~${totalSecs}s.`;
  }
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
    max_tokens: 2000,
    system: systemPrompt,
    messages: [{ role: "user", content: userParts }],
  });

  const raw = response.content.find((b) => b.type === "text")?.text ?? "{}";
  const clean = raw.replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, "");
  return JSON.parse(clean) as AutoZoomAnalysis;
}

/** Clamp/guard the LLM's contentRect so an over-eager crop can't eat the page. */
function normalizeContentRect(rect: AutoZoomContentRect | undefined): AutoZoomContentRect {
  if (!rect) return IDENTITY_CROP;
  const x = Math.min(1, Math.max(0, rect.x ?? 0));
  const y = Math.min(1, Math.max(0, rect.y ?? 0));
  const width = Math.min(1 - x, Math.max(0, rect.width ?? 1));
  const height = Math.min(1 - y, Math.max(0, rect.height ?? 1));
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

// ── macOS TTS audio ───────────────────────────────────────────────────────────

async function generateNarrationAudio(analysis: AutoZoomAnalysis, outDir: string): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const script = analysis.features.map((f) => f.narration).join(". ");
  const aiffPath = path.join(outDir, "narration.aiff");
  const mp3Path = path.join(outDir, "narration.mp3");
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("say", ["-o", aiffPath, script]);
    proc.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`say exited ${c}`))));
    proc.on("error", reject);
  });
  const ffmpeg = await getFfmpegBinaryPath();
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpeg, ["-i", aiffPath, "-q:a", "2", mp3Path, "-y"]);
    proc.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg audio exited ${c}`))));
    proc.on("error", reject);
  });
  await fsp.rm(aiffPath, { force: true });
  return mp3Path;
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
  audioPath: string | null;
  cropRegion: AutoZoomContentRect;
  analysis: AutoZoomAnalysis;
  outDir: string;
}): Promise<string> {
  const editor = {
    zoomRegions: opts.zoomRegions,
    showCursor: true,
    loopCursor: false,
    ...(opts.cropRegion !== IDENTITY_CROP ? { cropRegion: opts.cropRegion } : {}),
    ...(opts.captions.length ? { autoCaptions: opts.captions } : {}),
    ...(opts.audioPath
      ? {
          audioRegions: [
            {
              id: "audio-1",
              startMs: 0,
              endMs: opts.analysis.totalDurationMs,
              audioPath: opts.audioPath,
              volume: 1,
              normalize: false,
              trackIndex: 0,
            },
          ],
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
      audioPath: opts.audioPath,
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
      send(wc, { stage: "frames", status: "running", message: "Extracting frames from recording…" });
      const framePaths = await extractFrames(opts.videoPath, activeFrameDir, 2, 60);
      send(wc, { stage: "frames", status: "done", message: `Extracted ${framePaths.length} frames` });

      // Estimate video duration from frame count
      const videoDurationMs = framePaths.length * 2000;

      send(wc, { stage: "understanding", status: "running", message: "Understanding your app…" });
      const frames = await framesToBase64(framePaths, 20);
      const summary = cursorSummary(opts.cursorPath, Math.round(videoDurationMs / 1000));

      activeAnalysis = await runAnalysisLLM(frames, summary, videoDurationMs, []);
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

      const videoDurationMs = activeAnalysis.totalDurationMs || framePaths.length * 2000;
      const frames = await framesToBase64(framePaths, 20);
      const summary = cursorSummary(activeCursorPath, Math.round(videoDurationMs / 1000));

      activeAnalysis = await runAnalysisLLM(frames, summary, videoDurationMs, activeConversation);
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
        const cropRegion = opts.enableAutoCrop
          ? normalizeContentRect(activeAnalysis.contentRect)
          : IDENTITY_CROP;

        send(wc, { stage: "zooms", status: "running", message: "Deriving zoom regions…" });
        const { regions: zoomRegions, source } = await deriveZoomRegionsFromCursor({
          cursorPath: activeCursorPath,
          analysis: activeAnalysis,
          crop: cropRegion,
          totalDurationMs: activeAnalysis.totalDurationMs,
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

        let audioPath: string | null = null;
        if (opts.enableAudio) {
          try {
            send(wc, { stage: "audio", status: "running", message: "Generating narration audio…" });
            audioPath = await generateNarrationAudio(activeAnalysis, outDir);
            send(wc, { stage: "audio", status: "done", message: audioPath ? "Narration ready" : "Audio skipped (non-macOS)" });
          } catch (err) {
            send(wc, { stage: "audio", status: "error", message: `Audio failed: ${String(err)} — continuing without` });
          }
        }

        send(wc, { stage: "assemble", status: "running", message: "Assembling project…" });
        const projectPath = await assembleProject({
          videoPath: activeVideoPath,
          zoomRegions,
          captions,
          audioPath,
          cropRegion,
          analysis: activeAnalysis,
          outDir,
        });
        await rememberApprovedLocalReadPath(projectPath);
        send(wc, { stage: "assemble", status: "done", message: "Project ready", payload: { projectPath } });

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
