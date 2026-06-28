/**
 * Smoke test: record a demo of forkai.in → derive zoom+cursor → build .recordly
 *
 * Run with:
 *   cd pipeline
 *   npm run smoke
 *   npm run smoke -- --llm                              # M4: LLM saliency (stub until M4 is built)
 *   npm run smoke -- --llm --repo=https://github.com/... # M5: generated script
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
import { buildProject } from "./core/assemble/projectBuilder.js";

const TARGET_URL = "https://forkai.in";
const OUT_DIR = path.join(os.homedir(), "Desktop", "recordly-smoke");

// ── CLI flags ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const USE_LLM = args.includes("--llm");
const REPO_ARG = args.find((a) => a.startsWith("--repo="));
const REPO_URL = REPO_ARG?.slice("--repo=".length) ?? null;

if (USE_LLM) {
  console.log("  --llm flag detected (M4 saliency stub — no-op until M4 is built)");
}
if (REPO_URL) {
  console.log(`  --repo=${REPO_URL} detected (M5 script gen stub — no-op until M5 is built)`);
}

await fs.mkdir(OUT_DIR, { recursive: true });

console.log("▶  recording forkai.in …");

const result = await record(
  {
    startUrl: TARGET_URL,
    viewportWidth: 1440,
    viewportHeight: 900,
    steps: [
      // Let the page fully load + any animations settle
      { action: "wait", waitMs: 2000 },

      // Focus the question input and type a demo question
      { action: "click", selector: "textarea, input[type='text'], [contenteditable='true'], [role='textbox']" },
      { action: "wait", waitMs: 400 },
      { action: "type", selector: "textarea, input[type='text'], [contenteditable='true'], [role='textbox']", value: "How does AI change the way we do research?" },
      { action: "wait", waitMs: 500 },

      // Submit (try Enter key, common for AI chat inputs)
      { action: "keypress", key: "Enter" },

      // Wait for the branching answer to stream in
      { action: "wait", waitMs: 4000 },

      // Scroll down to see the full branching answer
      { action: "scroll", scrollDeltaY: 300 },
      { action: "wait", waitMs: 1000 },
      { action: "scroll", scrollDeltaY: 300 },
      { action: "wait", waitMs: 1000 },

      // Hover over a section heading to reveal branch actions (if any)
      { action: "hover", selector: "h2, h3, [role='heading'], section > p:first-child" },
      { action: "wait", waitMs: 800 },

      // Scroll back up
      { action: "scroll", scrollDeltaY: -600 },
      { action: "wait", waitMs: 800 },
    ],
  },
  {
    videoDir: OUT_DIR,
    headless: false, // headed so you can watch it record
    postActionSettleMs: 200,
  },
);

console.log(`✓  recorded  ${result.videoPath}`);
console.log(`   events:   ${result.trace.events.length}`);
console.log(`   segments: ${result.trace.segments.length}`);

// Derive zoom regions from the trace
const zoomRegions = deriveZoomRegions(result.trace);
console.log(`✓  derived   ${zoomRegions.length} zoom region(s)`);

// Derive cursor telemetry
const { samples, visualSettings } = deriveCursorTelemetry(result.trace);
console.log(`✓  cursor    ${samples.length} samples, style=${visualSettings.style}`);

// M4 stub: LLM saliency would filter/adjust zoomRegions here
// if (USE_LLM) { zoomRegions = await applySaliency(result.trace, zoomRegions); }

// M5 stub: repo script gen would replace the hardcoded steps above
// if (REPO_URL) { /* rerun with generated DemoStep[] */ }

// Assemble into a .recordly project
const project = await buildProject({
  videoPath: result.videoPath,
  zoomRegions,
  samples,
  cursorVisual: visualSettings,
  outDir: OUT_DIR,
});

console.log("");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log(`  Project: ${project.projectPath}`);
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

// Auto-open in the running recordly app (requires `npm run dev` to be running).
// The app reads --open-project=<path> and calls loadProjectFromPath() after startup.
try {
  execSync(
    `open -a "$(ls -d /Applications/Recordly.app /Applications/recordly.app 2>/dev/null | head -1 || echo 'Recordly')" --args --open-project="${project.projectPath}"`,
    { stdio: "inherit" },
  );
  console.log("  ↑ Opened in Recordly app (or use File > Open Project if it didn't auto-open)");
} catch {
  // App might not be installed in /Applications during dev; fall back to `open`
  try {
    execSync(`open "${project.projectPath}"`, { stdio: "inherit" });
    console.log("  ↑ Opened with default app handler");
  } catch {
    console.log("  Open manually: File > Open Project in the recordly app");
  }
}
