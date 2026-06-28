/**
 * Pipeline CLI entry point.
 *
 * When forked by Electron's autoDemo.ts, reads config from environment variables
 * and emits StageEvent objects via process.send() so the main process can relay
 * them to the Auto-demo window renderer.
 *
 * Env vars:
 *   PIPELINE_REPO_URL          GitHub URL or local path
 *   PIPELINE_PRODUCTION_URL    Live app URL
 *   PIPELINE_AUTH_EMAIL        Optional demo account email
 *   PIPELINE_AUTH_PASSWORD     Optional demo account password
 *   PIPELINE_OUT_DIR           Output directory (defaults to ~/Desktop/recordly-auto-demo)
 *   DEEPSEEK_API_KEY           DeepSeek API key
 */

import { runPipeline } from "./orchestrator.js";
import type { StageEvent } from "./core/schema/stageEvents.js";

const send = (evt: StageEvent) => {
  if (process.send) {
    process.send(evt);
  } else {
    console.log(JSON.stringify(evt));
  }
};

const repoUrl = process.env.PIPELINE_REPO_URL ?? "";
const productionUrl = process.env.PIPELINE_PRODUCTION_URL ?? "";

if (!repoUrl || !productionUrl) {
  send({
    type: "stage",
    stageId: "error",
    status: "error",
    message: "PIPELINE_REPO_URL and PIPELINE_PRODUCTION_URL are required",
    payload: { kind: "error", error: "Missing required env vars" },
  });
  process.exit(1);
}

runPipeline(
  {
    repoUrl,
    productionUrl,
    authEmail: process.env.PIPELINE_AUTH_EMAIL,
    authPassword: process.env.PIPELINE_AUTH_PASSWORD,
    outDir: process.env.PIPELINE_OUT_DIR,
    useLlm: true,
  },
  send,
)
  .then((result) => {
    console.log("[cli] done:", result.projectPath);
    process.exit(0);
  })
  .catch((err: unknown) => {
    send({
      type: "stage",
      stageId: "error",
      status: "error",
      message: String(err),
      payload: { kind: "error", error: String(err) },
    });
    process.exit(1);
  });
