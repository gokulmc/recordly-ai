/**
 * Pipeline orchestrator — runs all M5 stages in order and emits StageEvents.
 *
 * Called by cli.ts with a `send` callback. The callback is:
 *   - `process.send` when running as a forked child (M6 in-app window)
 *   - A local logger when called directly from smoke.ts
 */

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

export interface OrchestratorOpts {
  /** GitHub repo URL or local filesystem path */
  repoUrl: string;
  /** Live production URL to record against */
  productionUrl: string;
  /** Demo account email (optional — unlocks auth-gated features) */
  authEmail?: string;
  /** Demo account password */
  authPassword?: string;
  /** Directory for the output video + .recordly project */
  outDir?: string;
  /** Enable LLM saliency layer */
  useLlm?: boolean;
}

export interface OrchestratorResult {
  projectPath: string;
  videoPath: string;
}

export async function runPipeline(
  opts: OrchestratorOpts,
  send: (evt: StageEvent) => void,
): Promise<OrchestratorResult> {
  const outDir = opts.outDir ?? path.join(os.homedir(), "Desktop", "recordly-auto-demo");

  // ── Stage: ingest ────────────────────────────────────────────────────────────
  send({ type: "stage", stageId: "ingest", status: "running", message: "Reading repo …" });

  const { repoPath } = await cloneRepo(opts.repoUrl);
  const featureMap = await understandRepo(repoPath);

  send({
    type: "stage",
    stageId: "ingest",
    status: "done",
    message: `Found ${featureMap.features.length} features in ${featureMap.appName}`,
    payload: {
      kind: "ingest",
      appName: featureMap.appName,
      featureCount: featureMap.features.length,
      fileCount: 0,
    },
  });

  // ── Stage: crawl ─────────────────────────────────────────────────────────────
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

  // ── Stage: script ────────────────────────────────────────────────────────────
  send({ type: "stage", stageId: "script", status: "running", message: "Generating demo script …" });

  const script = await generateDemoScript(enriched, opts.productionUrl, {
    authEmail: opts.authEmail,
    authPassword: opts.authPassword,
  });

  const preview = script.steps
    .slice(0, 5)
    .map((s) => s.narration ?? s.url ?? s.selector ?? s.action);

  send({
    type: "stage",
    stageId: "script",
    status: "done",
    message: `Generated ${script.steps.length}-step demo script`,
    payload: { kind: "script", stepCount: script.steps.length, preview },
  });

  // ── Stage: record ────────────────────────────────────────────────────────────
  send({ type: "stage", stageId: "record", status: "running", message: "Recording demo …" });

  const result = await record(script, {
    videoDir: outDir,
    headless: false,
    postActionSettleMs: 200,
  });

  send({
    type: "stage",
    stageId: "record",
    status: "done",
    message: `Recorded ${result.trace.events.length} events`,
    payload: {
      kind: "record",
      eventCount: result.trace.events.length,
      videoPath: result.videoPath,
    },
  });

  // ── Stage: derive ─────────────────────────────────────────────────────────────
  send({ type: "stage", stageId: "derive", status: "running", message: "Deriving zoom & cursor …" });

  const { regions: zoomRegions } = deriveZoomRegions(result.trace);
  const { samples, cursorVisual } = deriveCursorTelemetry(result.trace);

  let cursorVisualFinal = cursorVisual;
  if (opts.useLlm !== false) {
    try {
      const llm = await applySaliency(result.trace, opts.productionUrl);
      const { regions: llmRegions } = deriveZoomRegions(result.trace, { saliency: llm.saliency });
      zoomRegions.length = 0;
      zoomRegions.push(...llmRegions);
      cursorVisualFinal = llm.cursorVisual;
    } catch (err) {
      console.warn("[orchestrator] LLM saliency failed, using defaults:", err);
    }
  }

  send({
    type: "stage",
    stageId: "derive",
    status: "done",
    message: `${zoomRegions.length} zoom region(s), cursor style: ${cursorVisualFinal.style}`,
    payload: { kind: "derive", zoomRegionCount: zoomRegions.length },
  });

  // ── Stage: assemble ───────────────────────────────────────────────────────────
  send({ type: "stage", stageId: "assemble", status: "running", message: "Building .recordly project …" });

  const project = await buildProject({
    videoPath: result.videoPath,
    zoomRegions,
    samples,
    cursorVisual: cursorVisualFinal,
    outDir,
  });

  send({
    type: "stage",
    stageId: "assemble",
    status: "done",
    message: `Project saved: ${project.projectPath}`,
    payload: { kind: "assemble", projectPath: project.projectPath },
  });

  // ── Done ──────────────────────────────────────────────────────────────────────
  send({
    type: "stage",
    stageId: "done",
    status: "done",
    message: "Pipeline complete",
    payload: { kind: "done", projectPath: project.projectPath },
  });

  return { projectPath: project.projectPath, videoPath: result.videoPath };
}
