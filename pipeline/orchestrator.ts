/**
 * Pipeline orchestrator — three standalone phase functions + a combined runner.
 *
 * Phase functions are called individually by the granular IPC handlers (M6+).
 * runPipeline() keeps the full one-shot pipeline for smoke.ts / CLI usage.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cloneRepo } from "./core/ingest/repoLoader.js";
import { understandRepo } from "./core/ingest/repoUnderstanding.js";
import { crawlAndEnrich } from "./core/crawl/playwrightCrawler.js";
import { generateDemoScript } from "./core/script/demoScriptGen.js";
import { record } from "./core/record/recorder.js";
import { deriveZoomRegions } from "./core/derive/zoomDeriver.js";
import { deriveCursorTelemetry } from "./core/derive/cursorDeriver.js";
import { applySaliency } from "./core/derive/saliency.js";
import { buildProject } from "./core/assemble/projectBuilder.js";
import type { StageEvent } from "./core/schema/stageEvents.js";
import type { AppFeatureMap } from "./core/schema/appFeatureMap.js";
import type { RecordingScript } from "./core/record/types.js";
import type { InteractionTrace } from "./core/schema/interactionTrace.js";

// ── Shared option types ────────────────────────────────────────────────────────

export interface ScriptGenOpts {
  repoUrl: string;
  productionUrl: string;
  authEmail?: string;
  authPassword?: string;
  /** GitHub PAT for cloning a private repo */
  githubToken?: string;
  /** Natural-language description of which features/flows to prioritise */
  focusArea?: string;
}

export interface RecordOpts {
  outDir?: string;
}

export interface RenderOpts {
  outDir?: string;
  productionUrl?: string;
}

export interface OrchestratorOpts extends ScriptGenOpts, RecordOpts {
  outDir?: string;
  useLlm?: boolean;
}

export interface OrchestratorResult {
  projectPath: string;
  videoPath: string;
}

// ── Phase 1: Generate script ───────────────────────────────────────────────────

export interface ScriptGenResult {
  featureMap: AppFeatureMap;
  script: RecordingScript;
}

export async function generateScriptPhase(
  opts: ScriptGenOpts,
  send: (evt: StageEvent) => void,
): Promise<ScriptGenResult> {
  send({ type: "stage", stageId: "ingest", status: "running", message: "Reading repo …" });

  const { repoPath } = await cloneRepo(opts.repoUrl, { githubToken: opts.githubToken });
  const featureMap = await understandRepo(repoPath);

  send({
    type: "stage",
    stageId: "ingest",
    status: "done",
    message: `Found ${featureMap.features.length} features in ${featureMap.appName}`,
    payload: { kind: "ingest", appName: featureMap.appName, featureCount: featureMap.features.length, fileCount: 0 },
  });

  send({ type: "stage", stageId: "crawl", status: "running", message: "Crawling live app for selectors …" });

  const enriched = await crawlAndEnrich(featureMap, opts.productionUrl, {
    authEmail: opts.authEmail,
    authPassword: opts.authPassword,
  });

  send({
    type: "stage",
    stageId: "crawl",
    status: "done",
    message: `Enriched ${enriched.features.length} features with live selectors`,
    payload: { kind: "crawl", enrichedFeatures: enriched.features.length },
  });

  send({ type: "stage", stageId: "script", status: "running", message: "Generating demo script …" });

  const script = await generateDemoScript(enriched, opts.productionUrl, {
    authEmail: opts.authEmail,
    authPassword: opts.authPassword,
    focusArea: opts.focusArea ?? undefined,
  });

  send({
    type: "stage",
    stageId: "script",
    status: "done",
    message: `Generated ${script.steps.length}-step demo script`,
    payload: {
      kind: "script",
      stepCount: script.steps.length,
      preview: script.steps.slice(0, 5).map((s) => s.narration ?? s.url ?? s.selector ?? s.action),
      featureMap: enriched,
      script,
    },
  });

  return { featureMap: enriched, script };
}

// ── Phase 2: Record ────────────────────────────────────────────────────────────

export interface RecordPhaseResult {
  videoPath: string;
  traceJsonPath: string;
}

export async function recordPhase(
  script: RecordingScript,
  opts: RecordOpts,
  send: (evt: StageEvent) => void,
): Promise<RecordPhaseResult> {
  const outDir = opts.outDir ?? path.join(os.homedir(), "Desktop", "recordly-auto-demo");
  await fs.mkdir(outDir, { recursive: true });

  send({ type: "stage", stageId: "record", status: "running", message: "Recording demo …" });

  const result = await record(script, {
    videoDir: outDir,
    headless: false,
    postActionSettleMs: 200,
  });

  // Serialise trace alongside the video so render phase can deserialise it
  const traceJsonPath = result.videoPath + ".trace.json";
  await fs.writeFile(traceJsonPath, JSON.stringify(result.trace), "utf-8");

  send({
    type: "stage",
    stageId: "record",
    status: "done",
    message: `Recorded ${result.trace.events.length} events`,
    payload: {
      kind: "record",
      eventCount: result.trace.events.length,
      videoPath: result.videoPath,
      traceJsonPath,
    },
  });

  return { videoPath: result.videoPath, traceJsonPath };
}

// ── Phase 3: Render ────────────────────────────────────────────────────────────

export interface RenderPhaseResult {
  projectPath: string;
}

export async function renderPhase(
  videoPath: string,
  traceJsonPath: string,
  opts: RenderOpts,
  send: (evt: StageEvent) => void,
): Promise<RenderPhaseResult> {
  const outDir = opts.outDir ?? path.dirname(videoPath);

  send({ type: "stage", stageId: "derive", status: "running", message: "Deriving zoom & cursor …" });

  const traceRaw = await fs.readFile(traceJsonPath, "utf-8");
  const trace = JSON.parse(traceRaw) as InteractionTrace;

  const { regions: zoomRegions } = deriveZoomRegions(trace);
  const { samples, cursorVisual } = deriveCursorTelemetry(trace);

  let cursorVisualFinal = cursorVisual;
  try {
    const llm = await applySaliency(trace, opts.productionUrl ?? "");
    const { regions: llmRegions } = deriveZoomRegions(trace, { saliency: llm.saliency });
    zoomRegions.length = 0;
    zoomRegions.push(...llmRegions);
    cursorVisualFinal = llm.cursorVisual;
  } catch (err) {
    console.warn("[orchestrator] LLM saliency failed, using defaults:", err);
  }

  send({
    type: "stage",
    stageId: "derive",
    status: "done",
    message: `${zoomRegions.length} zoom region(s), cursor: ${cursorVisualFinal.style}`,
    payload: { kind: "derive", zoomRegionCount: zoomRegions.length },
  });

  send({ type: "stage", stageId: "assemble", status: "running", message: "Building .recordly project …" });

  const project = await buildProject({ videoPath, zoomRegions, samples, cursorVisual: cursorVisualFinal, outDir });

  send({
    type: "stage",
    stageId: "assemble",
    status: "done",
    message: `Project saved`,
    payload: { kind: "assemble", projectPath: project.projectPath },
  });

  send({
    type: "stage",
    stageId: "done",
    status: "done",
    message: "Pipeline complete",
    payload: { kind: "done", projectPath: project.projectPath },
  });

  return { projectPath: project.projectPath };
}

// ── Combined runner (used by smoke.ts) ────────────────────────────────────────

export async function runPipeline(
  opts: OrchestratorOpts,
  send: (evt: StageEvent) => void,
): Promise<OrchestratorResult> {
  const outDir = opts.outDir ?? path.join(os.homedir(), "Desktop", "recordly-auto-demo");
  await fs.mkdir(outDir, { recursive: true });

  const { script } = await generateScriptPhase(opts, send);
  const { videoPath, traceJsonPath } = await recordPhase(script, { outDir }, send);

  if (opts.useLlm !== false) {
    const { projectPath } = await renderPhase(videoPath, traceJsonPath, { outDir, productionUrl: opts.productionUrl }, send);
    return { projectPath, videoPath };
  }

  // No render phase — return project-less result
  return { projectPath: "", videoPath };
}
