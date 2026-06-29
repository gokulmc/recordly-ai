/**
 * Pipeline CLI entry point.
 *
 * When forked by Electron's autoDemo.ts, reads config from environment variables
 * and emits StageEvent objects via process.send() so the main process can relay
 * them to the renderer.
 *
 * Env vars:
 *   PIPELINE_PHASE              generate-script | record | render | (empty = full pipeline)
 *   PIPELINE_REPO_URL           GitHub URL or local path  (generate-script)
 *   PIPELINE_PRODUCTION_URL     Live app URL              (generate-script)
 *   PIPELINE_AUTH_EMAIL         Optional demo account email
 *   PIPELINE_AUTH_PASSWORD      Optional demo account password
 *   PIPELINE_FOCUS_AREA         Optional natural-language focus description
 *   PIPELINE_SCRIPT_JSON        JSON-encoded RecordingScript  (record)
 *   PIPELINE_VIDEO_PATH         Path to raw .webm           (render)
 *   PIPELINE_TRACE_JSON_PATH    Path to .trace.json         (render)
 *   PIPELINE_OUT_DIR            Output directory
 *   DEEPSEEK_API_KEY            DeepSeek API key
 */

import { runPipeline, generateScriptPhase, recordPhase, renderPhase } from "./orchestrator.js";
import type { RecordingScript } from "./core/record/types.js";
import type { StageEvent } from "./core/schema/stageEvents.js";

const send = (evt: StageEvent) => {
  if (process.send) {
    process.send(evt);
  } else {
    console.log(JSON.stringify(evt));
  }
};

const phase = process.env.PIPELINE_PHASE ?? "";
const repoUrl = process.env.PIPELINE_REPO_URL ?? "";
const productionUrl = process.env.PIPELINE_PRODUCTION_URL ?? "";
const authEmail = process.env.PIPELINE_AUTH_EMAIL;
const authPassword = process.env.PIPELINE_AUTH_PASSWORD;
const githubToken = process.env.PIPELINE_GITHUB_TOKEN || undefined;
const focusArea = process.env.PIPELINE_FOCUS_AREA;
const outDir = process.env.PIPELINE_OUT_DIR;
const recordBackend = process.env.PIPELINE_RECORD_BACKEND === "native" ? "native" : undefined;
const ffmpegPath = process.env.PIPELINE_FFMPEG_PATH || undefined;
const authStatePath = process.env.PIPELINE_AUTH_STATE_PATH || undefined;
const zoomAggressiveness = process.env.PIPELINE_ZOOM_AGGRESSIVENESS
  ? Number(process.env.PIPELINE_ZOOM_AGGRESSIVENESS)
  : undefined;

function fail(msg: string): never {
  send({ type: "stage", stageId: "error", status: "error", message: msg, payload: { kind: "error", error: msg } });
  process.exit(1);
}

async function main() {
  switch (phase) {
    case "generate-script": {
      if (!repoUrl || !productionUrl) fail("PIPELINE_REPO_URL and PIPELINE_PRODUCTION_URL are required");
      const result = await generateScriptPhase({ repoUrl, productionUrl, authEmail, authPassword, githubToken, focusArea }, send);
      if (process.send) process.send({ type: "phase-result", result });
      break;
    }

    case "record": {
      const scriptJson = process.env.PIPELINE_SCRIPT_JSON;
      if (!scriptJson) fail("PIPELINE_SCRIPT_JSON is required for record phase");
      const script = JSON.parse(scriptJson) as RecordingScript;
      const result = await recordPhase(script, { outDir, backend: recordBackend, ffmpegPath, authStatePath }, send);
      if (process.send) process.send({ type: "phase-result", result });
      break;
    }

    case "render": {
      const videoPath = process.env.PIPELINE_VIDEO_PATH;
      const traceJsonPath = process.env.PIPELINE_TRACE_JSON_PATH;
      if (!videoPath || !traceJsonPath) fail("PIPELINE_VIDEO_PATH and PIPELINE_TRACE_JSON_PATH are required for render phase");
      const result = await renderPhase(videoPath, traceJsonPath, { outDir, productionUrl, zoomAggressiveness }, send);
      if (process.send) process.send({ type: "phase-result", result });
      break;
    }

    default: {
      if (!repoUrl || !productionUrl) fail("PIPELINE_REPO_URL and PIPELINE_PRODUCTION_URL are required");
      await runPipeline({ repoUrl, productionUrl, authEmail, authPassword, githubToken, focusArea, outDir, useLlm: true, backend: recordBackend, ffmpegPath, zoomAggressiveness }, send);
      break;
    }
  }
}

main().catch((err: unknown) => {
  fail(String(err));
});
