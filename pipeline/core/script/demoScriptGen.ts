/**
 * Demo-script generation (M5).
 *
 * Takes the crawl-enriched AppFeatureMap and asks DeepSeek to produce an
 * ordered DemoStep[] that the recorder can execute directly.
 *
 * Generated steps use selectors observed during the crawl (the authority).
 * LLM-guessed selectors are used as fallback hints only.
 */

import type { AppFeatureMap } from "../schema/appFeatureMap.js";
import type { DemoStep, RecordingScript } from "../record/types.js";
import { chat, parseJson, DEEPSEEK_SMART_MODEL } from "../../llm/deepseek.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface LlmDemoStep {
  action: string;
  url?: string;
  selector?: string;
  value?: string;
  key?: string;
  scrollDeltaY?: number;
  waitMs?: number;
  narration?: string;
}

// ── Prompt ─────────────────────────────────────────────────────────────────────

const STEP_SCHEMA = `Array of step objects. Each step has:
  action: "navigate"|"click"|"fill"|"type"|"hover"|"scroll"|"wait"|"keypress"
  url?: string          (only for navigate)
  selector?: string     (CSS or Playwright role selector)
  value?: string        (for fill/type)
  key?: string          (for keypress, e.g. "Enter")
  scrollDeltaY?: number (for scroll, positive = down)
  waitMs?: number       (for wait, in ms)
  narration?: string    (what the viewer sees — shown as caption later)`;

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Generate a RecordingScript from the enriched AppFeatureMap.
 *
 * @param featureMap  Crawl-enriched feature map
 * @param productionUrl  The live URL to record against
 */
export interface ScriptGenOptions {
  authEmail?: string;
  authPassword?: string;
  /** Optional natural-language description of which features/flows to cover */
  focusArea?: string;
}

/**
 * Build a deterministic login sequence. We do NOT trust the LLM to log in —
 * instead we replay the EXACT selectors the crawl verified (incl. a Next click
 * for multi-step forms), falling back to generic selectors only if the crawl
 * couldn't capture them. Every step is tagged `phase:"login"` so the recorder
 * can detect and report login failure instead of silently skipping it.
 */
function buildLoginSteps(
  featureMap: AppFeatureMap,
  productionUrl: string,
  email: string,
  password: string,
): DemoStep[] {
  const captured = featureMap.loginSelectors;
  const loginUrl = captured?.url ?? featureMap.loginUrl ?? new URL("/login", productionUrl).href;
  const emailSel = captured?.emailSelector
    ?? 'input[type="email"], input[name="email"], input[name="username"], #signInFormUsername, input[autocomplete="username"]';
  const passSel = captured?.passwordSelector
    ?? 'input[type="password"], input[name="password"], #signInFormPassword';

  const steps: DemoStep[] = [
    { action: "navigate", url: loginUrl, narration: `Signing in to ${featureMap.appName}.`, phase: "login" },
    { action: "wait", waitMs: 1200, phase: "login" },
    { action: "fill", selector: emailSel, value: email, narration: "Entering the demo account email.", phase: "login" },
  ];
  // Multi-step (email → Next → password) forms.
  if (captured?.nextSelector) {
    steps.push(
      { action: "click", selector: captured.nextSelector, narration: "Continuing to the password step.", phase: "login" },
      { action: "wait", waitMs: 1500, phase: "login" },
    );
  }
  steps.push(
    { action: "fill", selector: passSel, value: password, narration: "Entering the password.", phase: "login" },
    { action: "keypress", key: "Enter", narration: "Logging in.", phase: "login" },
    { action: "wait", waitMs: 3000, narration: "Loading the signed-in experience.", phase: "login" },
  );
  return steps;
}

export async function generateDemoScript(
  featureMap: AppFeatureMap,
  productionUrl: string,
  opts: ScriptGenOptions = {},
): Promise<RecordingScript> {
  const { authEmail, authPassword, focusArea } = opts;
  const featureSummary = featureMap.features
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 4) // top 4 features for a concise demo
    .map(
      (f, i) => `Feature ${i + 1}: ${f.name}
  Description: ${f.description}
  URL path: ${f.entryPath}
  Selectors (from live DOM): ${(f.likelySelectors ?? []).join(", ") || "none discovered"}
  Suggested flow: ${f.suggestedFlow.join(" → ")}`,
    )
    .join("\n\n");

  // Build auth hint — pass email in prompt but NOT password (substituted post-parse)
  const authHint = authEmail && authPassword
    ? `\nDEMO USER: email="${authEmail}", password=DEMO_PASSWORD_PLACEHOLDER`
    : "";

  const prompt = `You are creating a Playwright automation script for a product demo video of "${featureMap.appName}".${authHint}

App: ${featureMap.appName}
Description: ${featureMap.appDescription}
Production URL: ${productionUrl}
Vibe: ${featureMap.appVibe ?? "productivity"}

TOP FEATURES TO DEMO:
${featureSummary}

Generate a demo script that:
1. Starts at the production URL (navigate step)
2. Demonstrates 2-3 of the top features in a logical order
3. CRITICAL: use ONLY selectors copied verbatim from the "Selectors (from live DOM)" lists above. Do NOT invent selectors or guess element text. If a feature lists no usable selector, demonstrate it with a navigate/scroll/wait step and narration instead of clicking. A wrong selector wastes the whole step.
4. Includes natural pacing: wait 1-2s after navigating, 300-500ms after clicking
5. Each meaningful interaction has a narration string (what the viewer would understand)
6. Total duration: ~30-60 seconds of interactions (not counting waits between features)
${authEmail && authPassword
  ? `7. Do NOT include any login / sign-in steps. A reliable login is performed
   automatically BEFORE your steps. Begin directly with the first authenticated
   feature, assuming the user is already signed in.`
  : `7. NO login steps — demo only public/unauthenticated features.
   If a feature requires login, navigate to it anyway and show the login gate as a feature.`}
8. Prefer fill/type + keypress(Enter) over clicking submit buttons (more natural)
${focusArea ? `\nFOCUS AREA: ${focusArea}\nPrioritise these specific features/flows above all others.` : ""}

${STEP_SCHEMA}

Return ONLY a JSON array of steps, no markdown fences, no explanation.
Example shape: [{"action":"navigate","url":"https://...","narration":"Opening forkai"},{"action":"click","selector":"...","narration":"..."}]`;

  console.log("  [script] generating demo script …");
  const raw = await chat([{ role: "user", content: prompt }], {
    model: DEEPSEEK_SMART_MODEL,
    maxTokens: 3000,
  });

  const llmSteps = parseJson<LlmDemoStep[]>(raw);

  // Validate + normalise to DemoStep
  const llmDemoSteps: DemoStep[] = llmSteps
    .filter((s) => typeof s.action === "string")
    .map((s): DemoStep => {
      // Substitute the real password for the placeholder the LLM used
      if (authPassword && s.value === "DEMO_PASSWORD_PLACEHOLDER") {
        s.value = authPassword;
      }
      const base: DemoStep = { action: s.action as DemoStep["action"] };
      if (s.url) base.url = s.url;
      if (s.selector) base.selector = s.selector;
      if (s.value) base.value = s.value;
      if (s.key) base.key = s.key;
      if (s.scrollDeltaY) base.scrollDeltaY = s.scrollDeltaY;
      if (s.waitMs) base.waitMs = s.waitMs;
      if (s.narration) base.narration = s.narration;
      return base;
    });

  // Deterministically prepend login when credentials are provided, so the demo
  // always starts signed in (rather than relying on the LLM to log in).
  const steps: DemoStep[] =
    authEmail && authPassword
      ? [...buildLoginSteps(featureMap, productionUrl, authEmail, authPassword), ...llmDemoSteps]
      : llmDemoSteps;

  console.log(`  [script] generated ${steps.length} steps`);
  if (steps.length > 0) {
    console.log("  [script] preview:");
    steps.slice(0, 5).forEach((s, i) => {
      const desc = s.narration ?? s.selector ?? s.url ?? s.value ?? s.key ?? "";
      console.log(`    ${i + 1}. ${s.action}  ${desc.slice(0, 70)}`);
    });
    if (steps.length > 5) console.log(`    … +${steps.length - 5} more`);
  }

  return {
    startUrl: productionUrl,
    steps,
    viewportWidth: 1440,
    viewportHeight: 900,
  };
}
