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
      "narration": "string (one short sentence summarising the feature)",
      "narrationLines": [{ "text": "string (spoken clause, AT MOST 9 words)", "timeMs": number }],
      "importance": "\"low\" | \"medium\" | \"high\" (how demo-worthy this feature is)"
    }
  ],
  "totalDurationMs": number,
  "contentRect": {
    "x": number, "y": number, "width": number, "height": number
  },
  "garbageSegments": [
    { "startMs": number, "endMs": number, "reason": "string (short)" }
  ]
}`;

const GARBAGE_GUIDANCE = `garbageSegments: portions that should be REMOVED from the final demo video —
mistakes, wrong clicks and dead ends, error states, long loading waits, wandering or idle
exploration, repeated attempts, anything that does not contribute to demonstrating a feature.
Be decisive: a good demo is tight, and viewers should never see fumbling. Segments may overlap
feature spans. Return [] only if the whole recording is genuinely clean.`;

const NARRATION_LINES_GUIDANCE = `narrationLines: 2-4 lines per feature. Each line is a short spoken-style
clause of AT MOST 9 words, timed (timeMs) to the exact on-screen moment it describes — use the
interaction timestamps. Distribute lines across the feature span, aiming for a line every 5-10
seconds so the demo never goes silent for long. Lines are read aloud by TTS and shown as
captions, so write them the way a narrator would speak: "Type your question here", "Results
appear as a branching map". No filler like "as you can see".`;

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
${CONTENT_RECT_GUIDANCE}
${GARBAGE_GUIDANCE}
${NARRATION_LINES_GUIDANCE}`;

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
    max_tokens: 4000,
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
    // Sanitize narrationLines: drop empties, hard-trim runaway lines to 12 words
    // (the prompt asks for ≤9 — anything longer paginates badly as a caption),
    // clamp timeMs into the feature span, sort by time. Fall back to the
    // one-sentence narration at the feature start when no valid lines survive.
    const rawLines = Array.isArray(f.narrationLines) ? f.narrationLines : [];
    const lines = rawLines
      .filter((l) => l && typeof l.text === "string" && l.text.trim().length > 0)
      .map((l) => ({
        text: l.text.trim().split(/\s+/).slice(0, 12).join(" "),
        timeMs:
          typeof l.timeMs === "number" && Number.isFinite(l.timeMs)
            ? Math.min(Math.max(l.timeMs, f.startMs), f.endMs)
            : f.startMs,
      }))
      .sort((a, b) => a.timeMs - b.timeMs);
    f.narrationLines = lines.length
      ? lines
      : typeof f.narration === "string" && f.narration.trim()
        ? [{ text: f.narration.trim(), timeMs: f.startMs }]
        : [];
  }
  const garbageSegments = (Array.isArray(d.garbageSegments) ? d.garbageSegments : [])
    .filter(
      (g) =>
        g &&
        typeof g.startMs === "number" &&
        Number.isFinite(g.startMs) &&
        typeof g.endMs === "number" &&
        Number.isFinite(g.endMs) &&
        g.endMs - g.startMs >= 1500,
    )
    .map((g) => ({
      startMs: Math.max(0, g.startMs),
      endMs: g.endMs,
      reason: typeof g.reason === "string" ? g.reason : "flagged for removal",
    }));

  return {
    appName: d.appName,
    appCategory: typeof d.appCategory === "string" ? d.appCategory : "",
    features: d.features as AutoZoomAnalysis["features"],
    totalDurationMs:
      typeof d.totalDurationMs === "number" && Number.isFinite(d.totalDurationMs) ? d.totalDurationMs : 0,
    contentRect: d.contentRect,
    garbageSegments,
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

/** Speaking-rate estimate used when narration audio is disabled. */
const CAPTION_WORDS_PER_SEC = 2.6;
const CAPTION_MIN_MS = 1400;
const CAPTION_TAIL_MS = 400;

/** One short cue per narration line — cue spans match the spoken audio exactly,
 * so captions appear and disappear with the voice instead of lingering for the
 * whole feature (a ≤9-word cue renders as a single caption page; long cues get
 * chopped into mid-clause pages by the caption paginator). */
function captionsFromSegments(segments: NarrationSegment[]): Caption[] {
  const sorted = [...segments].sort((a, b) => a.startMs - b.startMs);
  return sorted.map((seg, i) => {
    const next = sorted[i + 1];
    const endMs = Math.min(seg.endMs + CAPTION_TAIL_MS, next ? next.startMs : Infinity);
    return { id: `cap-${i}`, startMs: seg.startMs, endMs, text: seg.text };
  });
}

/** Caption timing when narration audio is off: word-count duration estimate. */
function captionsFromLines(analysis: AutoZoomAnalysis): Caption[] {
  const lines = analysis.features
    .flatMap((f) => f.narrationLines ?? [])
    .sort((a, b) => a.timeMs - b.timeMs);
  const captions: Caption[] = [];
  let prevEndMs = 0;
  for (const line of lines) {
    const words = line.text.split(/\s+/).length;
    const startMs = Math.max(line.timeMs, prevEndMs + 100);
    const endMs = startMs + Math.max(CAPTION_MIN_MS, Math.round((words / CAPTION_WORDS_PER_SEC) * 1000));
    captions.push({ id: `cap-${captions.length}`, startMs, endMs, text: line.text });
    prevEndMs = endMs;
  }
  return captions;
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
 * Derives the kept segments (editor ClipRegions) from a unified cut list:
 * - dead time before the first feature / after the last (head/tail);
 * - LLM-flagged garbage segments (mistakes, error states, loading, wandering) —
 *   cut EXACTLY at the flagged boundaries, no click guard: clicking during a
 *   mistake is still a mistake, the semantic verdict wins;
 * - long (> MIN_MID_GAP_MS) click-free gaps between features, kept clear of
 *   the previous feature's narration end (an audio region must never overlap
 *   a trim — export clips it, playback skips it mid-sentence).
 * All cut ranges are merged (sort + sweep) before taking the complement, so
 * overlapping garbage/gap/head cuts collapse into clean clip boundaries.
 * The gaps between the returned clips are auto-derived as trims by the editor,
 * so playback/export jump-cut across them seamlessly; the user can further
 * split/delete/adjust the clips on the timeline.
 * Returns null when there is nothing worth cutting.
 */
function deriveKeepClips(opts: {
  analysis: AutoZoomAnalysis;
  durationMs: number;
  clickTimesMs: number[];
  /** Source-time end of each feature's narration audio (parallel to sorted features); empty when audio disabled. */
  narrationEndsMs: number[];
}): { clips: EditorClipRegion[]; cuts: Array<{ startMs: number; endMs: number }> } | null {
  const features = [...opts.analysis.features].sort((a, b) => a.startMs - b.startMs);
  if (!features.length) return null;

  const keepStartMs = Math.max(0, Math.min(opts.durationMs, features[0].startMs - CUT_PAD_MS));
  const lastEndMs = Math.max(...features.map((f) => f.endMs));
  const keepEndMs = Math.max(keepStartMs, Math.min(opts.durationMs, lastEndMs + CUT_PAD_MS));
  // Never cut down to (near) nothing — protects against bogus feature timestamps.
  if (keepEndMs - keepStartMs < MIN_CUT_MS) return null;

  const rawCuts: Array<{ startMs: number; endMs: number }> = [];

  // Head / tail.
  if (keepStartMs >= MIN_CUT_MS) rawCuts.push({ startMs: 0, endMs: keepStartMs });
  if (opts.durationMs - keepEndMs >= MIN_CUT_MS) rawCuts.push({ startMs: keepEndMs, endMs: opts.durationMs });

  // LLM-flagged garbage — exact boundaries, no click guard.
  for (const g of opts.analysis.garbageSegments ?? []) {
    const startMs = Math.max(0, Math.min(opts.durationMs, g.startMs));
    const endMs = Math.max(startMs, Math.min(opts.durationMs, g.endMs));
    if (endMs - startMs >= MIN_CUT_MS) rawCuts.push({ startMs, endMs });
  }

  // Long click-free gaps between features.
  for (let i = 0; i < features.length - 1; i++) {
    const prevEndMs = Math.max(features[i].endMs, opts.narrationEndsMs[i] ?? 0);
    const nextStartMs = features[i + 1].startMs;
    if (nextStartMs - prevEndMs < MIN_MID_GAP_MS) continue;

    const cutStartMs = prevEndMs + CUT_PAD_MS;
    const cutEndMs = nextStartMs - CUT_PAD_MS;
    if (cutEndMs - cutStartMs < MIN_CUT_MS) continue;
    if (opts.clickTimesMs.some((t) => t >= cutStartMs && t <= cutEndMs)) continue;
    rawCuts.push({ startMs: cutStartMs, endMs: cutEndMs });
  }

  if (!rawCuts.length) return null;

  // Merge overlapping/adjacent cut ranges (sort + sweep).
  rawCuts.sort((a, b) => a.startMs - b.startMs);
  const cuts: Array<{ startMs: number; endMs: number }> = [];
  for (const cut of rawCuts) {
    const last = cuts[cuts.length - 1];
    if (last && cut.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, cut.endMs);
    } else {
      cuts.push({ ...cut });
    }
  }

  // Kept clips = complement of the merged cuts within [0, durationMs].
  // Kept slivers shorter than MIN_CUT_MS are absorbed into the surrounding cut.
  const clips: EditorClipRegion[] = [];
  let cursor = 0;
  for (const cut of cuts) {
    if (cut.startMs - cursor >= MIN_CUT_MS) {
      clips.push({ id: `clip-${clips.length + 1}`, startMs: cursor, endMs: cut.startMs, speed: 1 });
    }
    cursor = Math.max(cursor, cut.endMs);
  }
  if (opts.durationMs - cursor >= MIN_CUT_MS) {
    clips.push({ id: `clip-${clips.length + 1}`, startMs: cursor, endMs: opts.durationMs, speed: 1 });
  }

  // If everything got absorbed (degenerate flags covering the whole video), bail.
  if (!clips.length) return null;

  return { clips, cuts };
}

/** Same overlap predicate the editor's manual clip-delete uses (VideoEditor handleClipDelete). */
function regionOutsideCuts(
  region: { startMs: number; endMs: number },
  cuts: Array<{ startMs: number; endMs: number }>,
): boolean {
  return cuts.every((cut) => region.endMs <= cut.startMs || region.startMs >= cut.endMs);
}

// ── macOS TTS audio (one segment per narration line) ──────────────────────────

interface NarrationSegment {
  featureIndex: number;
  /** The spoken text — reused verbatim as the matching caption cue. */
  text: string;
  audioPath: string;
  /** Source-time start/end of this narration region (after the overlap sweep). */
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

/** Bound the TTS work — a pathological analysis can't queue unbounded `say` calls. */
const MAX_NARRATION_LINES = 24;
/** Minimum breathing room between consecutive spoken lines. */
const NARRATION_GAP_MS = 250;

async function ttsLineToMp3(
  ffmpeg: string,
  outDir: string,
  index: number,
  text: string,
): Promise<{ audioPath: string; durationMs: number }> {
  const aiffPath = path.join(outDir, `narration-${String(index + 1).padStart(2, "0")}.aiff`);
  const mp3Path = path.join(outDir, `narration-${String(index + 1).padStart(2, "0")}.mp3`);
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
  return { audioPath: mp3Path, durationMs: durationMs || 2000 };
}

/**
 * One TTS clip per narration LINE, spoken at the moment it describes. Dense,
 * time-distributed lines (2-4 per feature) are what keep the demo from going
 * silent for 20s stretches; short per-line segments (instead of one long
 * track) also guarantee no audio region ever spans a trimmed gap.
 */
async function generateNarrationSegments(
  analysis: AutoZoomAnalysis,
  outDir: string,
): Promise<NarrationSegment[]> {
  if (process.platform !== "darwin") return [];
  await fsp.mkdir(outDir, { recursive: true });
  const ffmpeg = await getFfmpegBinaryPath();

  const lines = analysis.features
    .flatMap((feature, featureIndex) =>
      (feature.narrationLines ?? []).map((line) => ({ featureIndex, text: line.text, timeMs: line.timeMs })),
    )
    .sort((a, b) => a.timeMs - b.timeMs)
    .slice(0, MAX_NARRATION_LINES);
  if (!lines.length) return [];

  // TTS with small concurrency — ~18 sequential say+ffmpeg cycles would take
  // the better part of a minute; 3 workers keeps the generate step snappy.
  const rendered: Array<{ audioPath: string; durationMs: number }> = new Array(lines.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, lines.length) }, async () => {
      while (nextIndex < lines.length) {
        const i = nextIndex++;
        rendered[i] = await ttsLineToMp3(ffmpeg, outDir, i, lines[i].text);
      }
    }),
  );

  // Overlap sweep in time order: a line's audio may run past the next line's
  // timestamp — push the next start out so spoken lines never overlap.
  const segments: NarrationSegment[] = [];
  let prevEndMs = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const feature = analysis.features[line.featureIndex];
    const startMs = Math.max(line.timeMs, prevEndMs + NARRATION_GAP_MS);
    // A swept start far past the feature means narration piled up — drop the line.
    if (feature && startMs > feature.endMs + 2000) continue;
    const endMs = startMs + rendered[i].durationMs;
    segments.push({
      featureIndex: line.featureIndex,
      text: line.text,
      audioPath: rendered[i].audioPath,
      startMs,
      endMs,
    });
    prevEndMs = endMs;
  }

  return segments;
}

// ── Generated ambient bed ─────────────────────────────────────────────────────

/**
 * Synthesizes a soft ambient pad with the bundled ffmpeg (lavfi) — layered
 * detuned sines + brown noise, lowpassed, slow tremolo, ≈ -28dB RMS. No
 * bundled asset, no licensing, works on every platform (pure ffmpeg, unlike
 * the `say`-based narration). Returns null when synthesis fails — the demo
 * just ships without music.
 */
async function generateAmbientBed(outDir: string, durationMs: number): Promise<string | null> {
  await fsp.mkdir(outDir, { recursive: true });
  const ffmpeg = await getFfmpegBinaryPath();
  const mp3Path = path.join(outDir, "ambient.mp3");
  const durationSecs = Math.max(4, Math.ceil(durationMs / 1000) + 2);

  const args = [
    "-f", "lavfi", "-i", `sine=frequency=110:duration=${durationSecs}`,
    "-f", "lavfi", "-i", `sine=frequency=164.8:duration=${durationSecs}`,
    "-f", "lavfi", "-i", `sine=frequency=220.5:duration=${durationSecs}`,
    "-f", "lavfi", "-i", `anoisesrc=color=brown:duration=${durationSecs}:amplitude=0.3`,
    "-filter_complex",
    // Validated experimentally: this chain lands at ≈ -28dB RMS — a bed level
    // that sits under speech; the region volume scales it further at playback.
    "[0][1][2][3]amix=inputs=4:weights=1 0.7 0.5 0.6,lowpass=f=320,tremolo=f=0.15:d=0.3,volume=4dB,aformat=sample_rates=44100:channel_layouts=stereo",
    "-q:a", "4",
    mp3Path,
    "-y",
  ];

  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpeg, args);
      proc.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg ambient exited ${c}`))));
      proc.on("error", reject);
    });
    return mp3Path;
  } catch (err) {
    console.warn("[auto-zoom] ambient bed generation failed:", err);
    return null;
  }
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
  /** Ambient bed spanning the kept range, or null when music is off/failed. */
  musicRegion: { audioPath: string; startMs: number; endMs: number } | null;
  cropRegion: AutoZoomContentRect;
  keepClips: EditorClipRegion[] | null;
  analysis: AutoZoomAnalysis;
  outDir: string;
}): Promise<string> {
  const audioRegions = [
    ...opts.narrationSegments.map((seg, i) => ({
      id: `audio-${i + 1}`,
      startMs: seg.startMs,
      endMs: seg.endMs,
      audioPath: seg.audioPath,
      volume: 1,
      normalize: false,
      trackIndex: 0,
    })),
    // The music bed deliberately spans cuts (unlike narration): export plays it
    // continuously across trims, and preview merely skips forward at each cut —
    // both fine for structureless ambience, unlike speech which would be mangled.
    ...(opts.musicRegion
      ? [
          {
            id: "music-1",
            startMs: opts.musicRegion.startMs,
            endMs: opts.musicRegion.endMs,
            audioPath: opts.musicRegion.audioPath,
            volume: 0.5,
            normalize: false,
            trackIndex: 1,
          },
        ]
      : []),
  ];

  const editor = {
    zoomRegions: opts.zoomRegions,
    showCursor: true,
    loopCursor: false,
    ...(opts.cropRegion !== IDENTITY_CROP ? { cropRegion: opts.cropRegion } : {}),
    ...(opts.keepClips?.length ? { clipRegions: opts.keepClips } : {}),
    ...(opts.captions.length ? { autoCaptions: opts.captions } : {}),
    ...(audioRegions.length ? { audioRegions } : {}),
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

  // Generate — derive zooms, crop, captions, audio, music, assemble project
  ipcMain.handle(
    "auto-zoom:generate",
    async (
      e,
      opts: { enableCaptions: boolean; enableAudio: boolean; enableAutoCrop: boolean; enableMusic?: boolean },
    ) => {
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

        // Narration BEFORE captions and cuts — captions sync to the spoken
        // segments' real timing, and mid-gap trim boundaries must clear each
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
                ? `${narrationSegments.length} narration lines`
                : "Audio skipped (non-macOS)",
            });
          } catch (err) {
            send(wc, { stage: "audio", status: "error", message: `Audio failed: ${String(err)} — continuing without` });
          }
        }

        // Captions: one short cue per narration line, timed to the spoken audio
        // when it exists, otherwise estimated from word count.
        const captions: Caption[] = opts.enableCaptions
          ? narrationSegments.length
            ? captionsFromSegments(narrationSegments)
            : captionsFromLines(activeAnalysis)
          : [];
        if (opts.enableCaptions) {
          send(wc, { stage: "captions", status: "done", message: `${captions.length} caption cues` });
        }

        send(wc, { stage: "cuts", status: "running", message: "Trimming dead time & garbage…" });
        const featureList = activeAnalysis.features;
        const sortedFeatures = [...featureList].sort((a, b) => a.startMs - b.startMs);
        // A feature now has several narration segments — a cut boundary after the
        // feature must clear the LAST spoken line.
        const narrationEndsMs = sortedFeatures.map((f) => {
          const featureIndex = featureList.indexOf(f);
          return narrationSegments
            .filter((s) => s.featureIndex === featureIndex)
            .reduce((max, s) => Math.max(max, s.endMs), 0);
        });
        const cutResult = deriveKeepClips({
          analysis: activeAnalysis,
          durationMs,
          clickTimesMs: readClickTimesMs(activeCursorPath),
          narrationEndsMs,
        });
        const keepClips = cutResult?.clips ?? null;
        const cuts = cutResult?.cuts ?? [];
        const keptMs = keepClips ? keepClips.reduce((sum, c) => sum + (c.endMs - c.startMs), 0) : durationMs;
        const trimmedMs = Math.max(0, durationMs - keptMs);
        const garbageCount = activeAnalysis.garbageSegments?.length ?? 0;
        send(wc, {
          stage: "cuts",
          status: "done",
          message: keepClips
            ? `Removed ${cuts.length} dead segment${cuts.length === 1 ? "" : "s"} (${Math.round(trimmedMs / 1000)}s total${garbageCount ? `, ${garbageCount} flagged as garbage` : ""})`
            : "No dead time to trim",
        });

        // Match the editor's manual clip-delete semantics: regions overlapping a
        // removed range are dropped (a garbage portion must not be zoomed into or
        // narrated — and an audio region overlapping a trim breaks playback/export).
        // The music bed below is the deliberate exception to this rule.
        const keptZoomRegions = cuts.length
          ? zoomRegions.filter((r) => regionOutsideCuts(r, cuts))
          : zoomRegions;
        const keptNarrationSegments = cuts.length
          ? narrationSegments.filter((s) => regionOutsideCuts(s, cuts))
          : narrationSegments;

        // Ambient bed spanning the kept range — generated after cuts so its
        // length matches what actually survives.
        let musicRegion: { audioPath: string; startMs: number; endMs: number } | null = null;
        if (opts.enableMusic !== false) {
          send(wc, { stage: "music", status: "running", message: "Generating ambient music bed…" });
          const bedStartMs = keepClips?.[0]?.startMs ?? 0;
          const bedEndMs = keepClips?.[keepClips.length - 1]?.endMs ?? durationMs;
          const musicPath = await generateAmbientBed(outDir, bedEndMs - bedStartMs);
          musicRegion = musicPath ? { audioPath: musicPath, startMs: bedStartMs, endMs: bedEndMs } : null;
          // Soft-fail as "done": missing music is cosmetic and must not raise
          // the renderer's error banner mid-generation.
          send(wc, {
            stage: "music",
            status: "done",
            message: musicRegion ? "Ambient bed ready" : "Music generation failed — continuing without",
          });
        }

        send(wc, { stage: "assemble", status: "running", message: "Assembling project…" });
        const projectPath = await assembleProject({
          videoPath: activeVideoPath,
          zoomRegions: keptZoomRegions,
          captions,
          narrationSegments: keptNarrationSegments,
          musicRegion,
          cropRegion,
          keepClips,
          analysis: activeAnalysis,
          outDir,
        });
        await rememberApprovedLocalReadPath(projectPath);

        const summary: AutoZoomSummary = {
          appName: activeAnalysis.appName,
          autoZoomRegions: keptZoomRegions.length,
          vanillaRegions: vanillaCount,
          deepZooms: keptZoomRegions.filter((r) => r.depth >= 3).length,
          trimmedMs,
          cutSegments: cuts.length,
          garbageSegments: garbageCount,
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
