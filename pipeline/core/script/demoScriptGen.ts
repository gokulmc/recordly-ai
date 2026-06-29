/**
 * Demo-script generation.
 *
 * The crawl produces, per feature, a catalog of REAL interactive elements
 * (authenticated). The LLM orders a demo by referencing catalog elements by id
 * — it never invents selectors. We then deterministically validate each step
 * against the catalog and compile a durable Target, so the recorder replays only
 * things that actually exist on the live app.
 */

import type { AppFeatureMap, AppFeature } from "../schema/appFeatureMap.js";
import type { CatalogEntry, Target } from "../schema/target.js";
import type { DemoStep, RecordingScript } from "../record/types.js";
import { chat, parseJson, DEEPSEEK_SMART_MODEL } from "../../llm/deepseek.js";

export interface ScriptGenOptions {
  authEmail?: string;
  authPassword?: string;
  focusArea?: string;
}

interface LlmStep {
  action: string;
  /** 1-based index into the presented feature list (for interactive steps) */
  feature?: number;
  /** catalog element id within that feature (for click/fill/hover/type) */
  element?: number;
  value?: string;
  key?: string;
  scrollDeltaY?: number;
  waitMs?: number;
  narration?: string;
}

const INTERACTIVE = new Set(["click", "dblclick", "hover", "fill", "type"]);

function targetMatch(t: Target): { role?: string; name?: string } {
  if (t.kind === "role") return { role: t.role, name: t.name };
  if (t.kind === "text" || t.kind === "label" || t.kind === "placeholder") return { name: t.value };
  return {};
}

function actionFitsEntry(action: string, e: CatalogEntry): boolean {
  if (action === "fill" || action === "type") {
    return e.role === "textbox" || e.role === "searchbox" || e.role === "combobox" || e.tag === "input" || e.tag === "textarea";
  }
  return true;
}

/**
 * Deterministic, captured login replay (on camera). Uses the Targets the crawl
 * verified — trigger that opens the form, email, how it advances (Enter or a
 * Next click), and password. Falls back to generic selectors only if the crawl
 * couldn't capture them. Tagged phase:"login" so the recorder flags failures.
 */
function buildLoginSteps(featureMap: AppFeatureMap, productionUrl: string, email: string, password: string): DemoStep[] {
  const c = featureMap.loginSelectors;
  const loginUrl = c?.url ?? featureMap.loginUrl ?? productionUrl;
  const EMAIL_FALLBACK = 'input[type="email"], input[name="email"], input[name="username"], #signInFormUsername';
  const PASS_FALLBACK = 'input[type="password"], input[name="password"], #signInFormPassword';

  const steps: DemoStep[] = [
    { action: "navigate", url: loginUrl, narration: `Signing in to ${featureMap.appName}.`, phase: "login" },
    { action: "wait", waitMs: 1200, phase: "login" },
  ];
  if (c?.trigger) {
    steps.push(
      { action: "click", target: c.trigger, match: targetMatch(c.trigger), narration: "Opening the sign-in form.", phase: "login" },
      { action: "wait", waitMs: 1000, phase: "login" },
    );
  }
  steps.push(
    c?.email
      ? { action: "fill", target: c.email, value: email, narration: "Entering the demo account email.", phase: "login" }
      : { action: "fill", selector: EMAIL_FALLBACK, value: email, narration: "Entering the demo account email.", phase: "login" },
  );
  if (c?.advance === "click" && c.next) {
    steps.push(
      { action: "click", target: c.next, match: targetMatch(c.next), narration: "Continuing to the password step.", phase: "login" },
      { action: "wait", waitMs: 1200, phase: "login" },
    );
  } else {
    steps.push(
      { action: "keypress", key: "Enter", narration: "Continuing.", phase: "login" },
      { action: "wait", waitMs: 1200, phase: "login" },
    );
  }
  steps.push(
    c?.password
      ? { action: "fill", target: c.password, value: password, narration: "Entering the password.", phase: "login" }
      : { action: "fill", selector: PASS_FALLBACK, value: password, narration: "Entering the password.", phase: "login" },
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

  // Present the top features and their REAL element catalogs to the LLM.
  const topFeatures = [...featureMap.features].sort((a, b) => b.importance - a.importance).slice(0, 5);
  const featureSummary = topFeatures
    .map((f, i) => {
      const cat = (f.liveElements ?? [])
        .slice(0, 18)
        .map((e) => `    [${e.id}] "${e.text || "(no text)"}" — ${e.role || e.tag}${e.enabled ? "" : " (disabled)"}`)
        .join("\n");
      return `Feature ${i + 1}: ${f.name}\n  ${f.description}\n  Real elements on this page:\n${cat || "    (none captured)"}`;
    })
    .join("\n\n");

  const prompt = `You are scripting a product-demo video of "${featureMap.appName}".
Description: ${featureMap.appDescription}
Production URL: ${productionUrl}

You are given the TOP FEATURES and, for each, the REAL interactive elements found
on the live (signed-in) app, each with an id. Build a 2–4 feature demo by
choosing elements to interact with BY ID. Do NOT invent selectors or ids.

${featureSummary}

Return a JSON array of steps. Each step:
  action: "click"|"fill"|"hover"|"type"|"scroll"|"wait"
  feature: number   (the "Feature N" number, for click/fill/hover/type)
  element: number   (the [id] of the element within that feature)
  value?: string    (for fill/type)
  scrollDeltaY?: number   (for scroll)
  waitMs?: number   (for wait)
  narration: string (one short sentence the viewer hears)

Rules:
- Use ONLY (feature, element) pairs that appear above. Skip features with no elements.
- Demonstrate a coherent flow: type a query/fill an input, click a primary action, hover/scroll to reveal results.
- Pace it: a short wait (800–1500ms) after meaningful actions.
- ${authEmail ? "The user is ALREADY signed in — do NOT add login steps." : "Demo only public features."}
${focusArea ? `- Focus: ${focusArea}` : ""}

Return ONLY the JSON array.`;

  console.log("  [script] generating demo script from live catalog …");
  const raw = await chat([{ role: "user", content: prompt }], { model: DEEPSEEK_SMART_MODEL, maxTokens: 2500 });
  const llmSteps = parseJson<LlmStep[]>(raw);

  // Deterministically validate each step against the catalog.
  const body: DemoStep[] = [];
  let dropped = 0;
  for (const s of Array.isArray(llmSteps) ? llmSteps : []) {
    const action = s.action as DemoStep["action"];
    if (action === "wait") {
      body.push({ action: "wait", waitMs: s.waitMs ?? 800, narration: s.narration });
      continue;
    }
    if (action === "scroll") {
      body.push({ action: "scroll", scrollDeltaY: s.scrollDeltaY ?? 300, narration: s.narration });
      continue;
    }
    if (!INTERACTIVE.has(action)) { dropped++; continue; }

    const feat: AppFeature | undefined = typeof s.feature === "number" ? topFeatures[s.feature - 1] : undefined;
    const entry = feat?.liveElements?.find((e) => e.id === s.element);
    if (!entry || !actionFitsEntry(action, entry)) { dropped++; continue; }

    body.push({
      action,
      target: entry.target,
      match: { role: entry.role, name: entry.text },
      ...(s.value ? { value: s.value } : {}),
      narration: s.narration ?? entry.text,
    });
  }
  if (dropped) console.log(`  [script] dropped ${dropped} step(s) not grounded in the live catalog`);

  const steps: DemoStep[] =
    authEmail && authPassword
      ? [...buildLoginSteps(featureMap, productionUrl, authEmail, authPassword), ...body]
      : body;

  console.log(`  [script] generated ${steps.length} steps`);
  steps.slice(0, 6).forEach((s, i) => {
    const desc = s.narration ?? s.url ?? s.key ?? "";
    console.log(`    ${i + 1}. ${s.action}  ${String(desc).slice(0, 70)}`);
  });

  return { startUrl: productionUrl, steps, viewportWidth: 1440, viewportHeight: 900 };
}
