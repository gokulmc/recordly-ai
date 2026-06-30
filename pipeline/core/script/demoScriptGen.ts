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
import { extractFocusKeywords, textMatchesFocus, focusMatchScore } from "./focus.js";

/** Best focus-matching, actionable element across the selected features. */
function findFocusTarget(
  features: AppFeature[],
  keywords: string[],
): { featureIdx: number; entry: CatalogEntry } | null {
  if (!keywords.length) return null;
  let best: { featureIdx: number; entry: CatalogEntry } | null = null;
  let bestScore = 0;
  features.forEach((f, featureIdx) => {
    for (const e of f.liveElements ?? []) {
      const score = focusMatchScore(e.text, keywords);
      if (score <= 0) continue;
      // Prefer higher keyword overlap; tie-break toward enabled elements.
      const better = score > bestScore || (score === bestScore && best != null && !best.entry.enabled && e.enabled);
      if (better) {
        bestScore = score;
        best = { featureIdx, entry: e };
      }
    }
  });
  return best;
}

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
 * Guarantee every feature segment pans through its page: if a navigate-delimited
 * segment has interactive steps but no scroll, append a gentle scroll so the demo
 * is always scrollable (the user's explicit requirement), even if the LLM omitted one.
 */
function injectSegmentScrolls(steps: DemoStep[]): DemoStep[] {
  const out: DemoStep[] = [];
  let segHasInteractive = false;
  let segHasScroll = false;
  const flush = () => {
    if (segHasInteractive && !segHasScroll) {
      out.push({ action: "scroll", scrollDeltaY: 500, narration: "Scrolling through the page." });
    }
  };
  for (const s of steps) {
    if (s.action === "navigate") {
      flush();
      segHasInteractive = false;
      segHasScroll = false;
      out.push(s);
      continue;
    }
    if (s.action === "scroll") segHasScroll = true;
    if (INTERACTIVE.has(s.action)) segHasInteractive = true;
    out.push(s);
  }
  flush();
  return out;
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
  const keywords = extractFocusKeywords(focusArea);

  // Feature selection: PIN any feature that matches the user's refinement (by name,
  // description, or a captured element), then fill up to 5 by static importance.
  const byImportance = [...featureMap.features].sort((a, b) => b.importance - a.importance);
  const featureMatchesFocus = (f: AppFeature): boolean =>
    textMatchesFocus(f.name, keywords) ||
    textMatchesFocus(f.description, keywords) ||
    (f.liveElements ?? []).some((e) => textMatchesFocus(e.text, keywords));
  const pinned = byImportance.filter(featureMatchesFocus);
  const rest = byImportance.filter((f) => !pinned.includes(f));
  const selected = [...pinned, ...rest].slice(0, Math.max(5, pinned.length));

  if (keywords.length) {
    console.log(`  [script] focus keywords: ${keywords.join(", ")}`);
    if (pinned.length) console.log(`  [script] pinned focus features: ${pinned.map((f) => f.name).join(", ")}`);
  }

  // Present each feature's catalog, focus matches first and ⭐-marked so the LLM
  // can't rank the requested control out of the window.
  const featureSummary = selected
    .map((f, i) => {
      const els = f.liveElements ?? [];
      const matches = els.filter((e) => textMatchesFocus(e.text, keywords));
      const others = els.filter((e) => !textMatchesFocus(e.text, keywords));
      const cat = [...matches, ...others]
        .slice(0, 24)
        .map((e) => {
          const star = textMatchesFocus(e.text, keywords) ? " ⭐" : "";
          const rev = e.revealed ? " (appears after interaction)" : "";
          return `    [${e.id}] "${e.text || "(no text)"}" — ${e.role || e.tag}${e.enabled ? "" : " (disabled)"}${rev}${star}`;
        })
        .join("\n");
      return `Feature ${i + 1}: ${f.name}\n  ${f.description}\n  Real elements on this page:\n${cat || "    (none captured)"}`;
    })
    .join("\n\n");

  const priorityBlock = focusArea
    ? `\n=== PRIORITY REQUEST (must honor) ===
The user explicitly asked: "${focusArea}"
Elements that satisfy this are marked ⭐ below. You MUST include the ⭐ action(s) in
the demo, referencing the correct feature+element ids. If a ⭐ element is marked
"(appears after interaction)", first perform the steps that produce it (fill the
input, click the primary action), THEN interact with it.
=== END PRIORITY ===\n`
    : "";

  const prompt = `You are scripting a product-demo video of "${featureMap.appName}".
Description: ${featureMap.appDescription}
Production URL: ${productionUrl}
${priorityBlock}
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
- Demonstrate a coherent flow: type a query/fill an input, click a primary action, then SCROLL to reveal the results.
- After a primary action that produces output, add a "scroll" step (scrollDeltaY ~500) so the viewer sees the result; you may scroll back up after.
- Pace it: a short wait (800–1500ms) after meaningful actions.
- ${authEmail ? "The user is ALREADY signed in — do NOT add login steps." : "Demo only public features."}

Return ONLY the JSON array.`;

  console.log("  [script] generating demo script from live catalog …");
  const raw = await chat([{ role: "user", content: prompt }], { model: DEEPSEEK_SMART_MODEL, maxTokens: 2500 });
  const llmSteps = parseJson<LlmStep[]>(raw);

  // Deterministically validate + compile, grouping steps into per-feature segments.
  // Each segment is prefixed with a `navigate` to the feature's entryPath (so the
  // recorder is on the right page), and a feature's `revealSteps` are replayed
  // before the first step that touches an element only present post-interaction.
  const body: DemoStep[] = [];
  const dropReasons: string[] = [];
  let curFeatureIdx = -1;
  const revealInjected = new Set<number>();
  const usedTargets = new Set<string>();

  const targetSig = (t: Target): string =>
    t.kind === "role" ? `role/${t.role}/${t.name}` : `${t.kind}/${(t as { value?: string }).value ?? ""}`;

  const ensureFeatureNav = (idx: number): void => {
    if (idx === curFeatureIdx) return;
    const f = selected[idx]!;
    body.push({ action: "navigate", url: new URL(f.entryPath, productionUrl).href, narration: `Opening ${f.name}.` });
    body.push({ action: "wait", waitMs: 1500 });
    curFeatureIdx = idx;
    revealInjected.delete(idx); // re-entering a feature page resets its revealed state
  };

  const injectRevealIfNeeded = (idx: number): void => {
    if (revealInjected.has(idx)) return;
    revealInjected.add(idx);
    const f = selected[idx]!;
    if (f.revealSteps?.length) {
      console.log(`  [script] replaying ${f.revealSteps.length} reveal step(s) for "${f.name}"`);
      for (const rs of f.revealSteps) {
        body.push(rs);
        if (rs.target) usedTargets.add(targetSig(rs.target));
      }
    }
  };

  const pushInteractive = (idx: number, action: DemoStep["action"], entry: CatalogEntry, value?: string, narration?: string): void => {
    ensureFeatureNav(idx);
    if (entry.revealed) injectRevealIfNeeded(idx);
    body.push({
      action,
      target: entry.target,
      match: { role: entry.role, name: entry.text },
      ...(value ? { value } : {}),
      narration: narration ?? entry.text,
    });
    usedTargets.add(targetSig(entry.target));
  };

  for (const s of Array.isArray(llmSteps) ? llmSteps : []) {
    const action = s.action as DemoStep["action"];
    if (action === "wait") {
      body.push({ action: "wait", waitMs: s.waitMs ?? 800, narration: s.narration });
      continue;
    }
    if (action === "scroll") {
      body.push({ action: "scroll", scrollDeltaY: s.scrollDeltaY ?? 500, narration: s.narration });
      continue;
    }
    if (!INTERACTIVE.has(action)) {
      dropReasons.push(`${action}: unsupported action`);
      continue;
    }

    const featureIdx = typeof s.feature === "number" ? s.feature - 1 : -1;
    const feat: AppFeature | undefined = selected[featureIdx];
    if (!feat) {
      dropReasons.push(`${action}(feat ${s.feature}, el ${s.element}): feature not in presented set`);
      continue;
    }
    const entry = feat.liveElements?.find((e) => e.id === s.element);
    if (!entry) {
      dropReasons.push(`${action}(feat ${s.feature}, el ${s.element}): element id not in catalog`);
      continue;
    }
    if (!actionFitsEntry(action, entry)) {
      dropReasons.push(`${action}(feat ${s.feature}, el ${s.element} "${entry.text}"): action doesn't fit ${entry.role || entry.tag}`);
      continue;
    }
    pushInteractive(featureIdx, action, entry, s.value, s.narration);
  }

  // Honor the user's request as a HARD requirement WHEN reachable: if a focus-matched
  // element exists but the LLM left it out, inject its (reveal-path +) action. If no
  // captured element matches at all, warn rather than silently drop the request.
  let focusNotice: string | undefined;
  if (keywords.length) {
    const focus = findFocusTarget(selected, keywords);
    if (!focus) {
      focusNotice = `Couldn't find a UI control matching "${focusArea}" in the captured app. The demo was generated without it — the control may live behind a step the crawl couldn't reach, or the wording may differ on screen.`;
      console.warn(`  [script] focus "${focusArea}" matched NO captured element — ${focusNotice}`);
    } else if (usedTargets.has(targetSig(focus.entry.target))) {
      console.log(`  [script] focus honored: "${focus.entry.text}" in "${selected[focus.featureIdx]!.name}" is in the script`);
    } else {
      const fitAction: DemoStep["action"] = actionFitsEntry("fill", focus.entry) ? "fill" : "click";
      console.log(`  [script] focus "${focus.entry.text}" was omitted by the model — injecting it directly`);
      pushInteractive(
        focus.featureIdx,
        fitAction,
        focus.entry,
        undefined,
        `Now clicking ${focus.entry.text}.`,
      );
    }
  }

  if (dropReasons.length) {
    console.log(`  [script] dropped ${dropReasons.length} step(s):`);
    dropReasons.forEach((r) => console.log(`    - ${r}`));
  }

  const bodyWithScrolls = injectSegmentScrolls(body);

  const steps: DemoStep[] =
    authEmail && authPassword
      ? [...buildLoginSteps(featureMap, productionUrl, authEmail, authPassword), ...bodyWithScrolls]
      : bodyWithScrolls;

  console.log(`  [script] generated ${steps.length} steps`);
  steps.slice(0, 8).forEach((s, i) => {
    const desc = s.narration ?? s.url ?? s.key ?? "";
    console.log(`    ${i + 1}. ${s.action}  ${String(desc).slice(0, 70)}`);
  });

  return {
    startUrl: productionUrl,
    steps,
    viewportWidth: 1440,
    viewportHeight: 900,
    ...(focusNotice ? { focusNotice } : {}),
  };
}
