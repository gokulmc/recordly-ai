/**
 * Smoke test: record a demo → derive zoom+cursor → build .recordly
 *
 * Run with:
 *   cd pipeline
 *   npm run smoke
 *   npm run smoke -- --llm
 *   npm run smoke -- --llm --repo=https://github.com/webadderallorg/forkai
 *
 * The app is auto-opened via `open -a Recordly --args --open-project=<path>`.
 * Make sure `npm run dev` is running in a separate terminal first.
 */

import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { record } from "./core/record/recorder.js";
import { deriveZoomRegions } from "./core/derive/zoomDeriver.js";
import { deriveCursorTelemetry } from "./core/derive/cursorDeriver.js";
import { applySaliency } from "./core/derive/saliency.js";
import { buildProject } from "./core/assemble/projectBuilder.js";
import { cloneRepo } from "./core/ingest/repoLoader.js";
import { understandRepo } from "./core/ingest/repoUnderstanding.js";
import { crawlAndEnrich } from "./core/crawl/playwrightCrawler.js";
import { generateDemoScript } from "./core/script/demoScriptGen.js";
import type { RecordingScript } from "./core/record/types.js";

const TARGET_URL = "https://forkai.in";
const OUT_DIR = path.join(os.homedir(), "Desktop", "recordly-smoke");

// ── CLI flags ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const USE_LLM = args.includes("--llm");
const REPO_ARG = args.find((a) => a.startsWith("--repo="));
const REPO_URL = REPO_ARG?.slice("--repo=".length) ?? null;
const AUTH_ARG = args.find((a) => a.startsWith("--auth="));
// Format: --auth=email:password  (password may contain colons)
const AUTH_RAW = AUTH_ARG?.slice("--auth=".length) ?? null;
const AUTH_EMAIL = AUTH_RAW ? AUTH_RAW.split(":")[0] : null;
const AUTH_PASS = AUTH_RAW ? AUTH_RAW.split(":").slice(1).join(":") : null;

await fs.mkdir(OUT_DIR, { recursive: true });

// ── M5: repo ingest + crawl + script gen ───────────────────────────────────────
let script: RecordingScript | null = null;

if (REPO_URL) {
  console.log(`▶  M5 pipeline: ${REPO_URL} → ${TARGET_URL}`);

  // 1. Clone repo
  const { repoPath } = await cloneRepo(REPO_URL);

  // 2. LLM repo understanding → AppFeatureMap
  console.log("▶  understanding repo …");
  const featureMap = await understandRepo(repoPath);

  // 3. Crawl production URL → enrich selectors
  console.log("▶  crawling production URL …");
  const enriched = await crawlAndEnrich(featureMap, TARGET_URL);

  // 4. LLM demo-script generation → DemoStep[]
  console.log("▶  generating demo script …");
  script = await generateDemoScript(enriched, TARGET_URL, {
    authEmail: AUTH_EMAIL ?? undefined,
    authPassword: AUTH_PASS ?? undefined,
  });

  console.log(`✓  script    ${script.steps.length} steps generated`);
} else {
  // Hardcoded forkai.in demo steps (M3 baseline)
  script = {
    startUrl: TARGET_URL,
    viewportWidth: 1440,
    viewportHeight: 900,
    steps: [
      { action: "wait", waitMs: 2000 },
      { action: "click", selector: "textarea, input[type='text'], [contenteditable='true'], [role='textbox']" },
      { action: "wait", waitMs: 400 },
      { action: "type", selector: "textarea, input[type='text'], [contenteditable='true'], [role='textbox']", value: "How does AI change the way we do research?", narration: "Asking a research question" },
      { action: "wait", waitMs: 500 },
      { action: "keypress", key: "Enter" },
      { action: "wait", waitMs: 4000 },
      { action: "scroll", scrollDeltaY: 300 },
      { action: "wait", waitMs: 1000 },
      { action: "scroll", scrollDeltaY: 300 },
      { action: "wait", waitMs: 1000 },
      { action: "hover", selector: "h2, h3, [role='heading'], section > p:first-child" },
      { action: "wait", waitMs: 800 },
      { action: "scroll", scrollDeltaY: -600 },
      { action: "wait", waitMs: 800 },
    ],
  };
}

// ── Record ─────────────────────────────────────────────────────────────────────
console.log("▶  recording …");
const result = await record(script, {
  videoDir: OUT_DIR,
  headless: false,
  postActionSettleMs: 200,
});

console.log(`✓  recorded  ${result.videoPath}`);
console.log(`   events:   ${result.trace.events.length}`);
console.log(`   segments: ${result.trace.segments.length}`);

// ── Derive ─────────────────────────────────────────────────────────────────────
const { regions: zoomRegions } = deriveZoomRegions(result.trace);
console.log(`✓  derived   ${zoomRegions.length} zoom region(s)`);

const { samples, cursorVisual } = deriveCursorTelemetry(result.trace);
console.log(`✓  cursor    ${samples.length} samples, style=${cursorVisual.style}`);

// ── M4: LLM saliency ──────────────────────────────────────────────────────────
let cursorVisualFinal = cursorVisual;
if (USE_LLM) {
  console.log("▶  LLM saliency …");
  const llm = await applySaliency(result.trace, TARGET_URL);
  const { regions: llmRegions } = deriveZoomRegions(result.trace, { saliency: llm.saliency });
  zoomRegions.length = 0;
  zoomRegions.push(...llmRegions);
  cursorVisualFinal = llm.cursorVisual;
  console.log(`✓  LLM      ${zoomRegions.length} zoom region(s) after saliency`);
}

// ── Assemble ──────────────────────────────────────────────────────────────────
const project = await buildProject({
  videoPath: result.videoPath,
  zoomRegions,
  samples,
  cursorVisual: cursorVisualFinal,
  outDir: OUT_DIR,
});

console.log("");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log(`  Project: ${project.projectPath}`);
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

// ── Auto-open ─────────────────────────────────────────────────────────────────
try {
  execSync(
    `open -a "$(ls -d /Applications/Recordly.app /Applications/recordly.app 2>/dev/null | head -1 || echo 'Recordly')" --args --open-project="${project.projectPath}"`,
    { stdio: "inherit" },
  );
  console.log("  ↑ Opened in Recordly app");
} catch {
  try {
    execSync(`open "${project.projectPath}"`, { stdio: "inherit" });
  } catch {
    console.log("  Open manually: File > Open Project in the recordly app");
  }
}
