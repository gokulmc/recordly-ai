/**
 * Playwright crawl stage.
 *
 * Logs into the live app (capturing the exact working login flow), saves the
 * authenticated session, then visits each feature's entryPath WHILE SIGNED IN
 * and records a catalog of the real interactive elements. The demo script is
 * built from this live catalog — never from repo-guessed selectors.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Locator, type Page } from "playwright";
import type { AppFeatureMap, AppFeature, LoginSelectors } from "../schema/appFeatureMap.js";
import type { CatalogEntry, Target } from "../schema/target.js";
import type { DemoStep } from "../record/types.js";
import { extractCatalog, catalogKey } from "../record/locator.js";
import { extractFocusKeywords, textMatchesFocus, focusMatchScore } from "../script/focus.js";

// ── Login field candidates ────────────────────────────────────────────────────

// Ordered candidates — tried one at a time, most-specific first, so a generic
// search box (e.g. input[name="username"]) never gets matched ahead of the real
// email field (input[type="email"]).
const EMAIL_CANDIDATES = [
  'input[type="email"]',
  '#signInFormUsername',
  'input[autocomplete="username"]',
  'input[id*="email" i]',
  'input[name="email"]',
  'input[name="username"]',
];
const PASSWORD_CANDIDATES = [
  'input[type="password"]',
  '#signInFormPassword',
  'input[autocomplete="current-password"]',
  'input[name="password"]',
];
const NEXT_CANDIDATES = [
  'button:has-text("Next")',
  'button:has-text("Continue")',
  'button[type="submit"]',
  'input[type="submit"]',
];
const LOGIN_TRIGGER_CANDIDATES = [
  'button:has-text("Login")',
  'a:has-text("Login")',
  'button:has-text("Log in")',
  'a:has-text("Log in")',
  'button:has-text("Sign in")',
  'a:has-text("Sign in")',
  'button:has-text("Sign up")',
  'a:has-text("Get started")',
];
const LOGGED_OUT_CANDIDATES = [
  'button:has-text("Login")',
  'a:has-text("Login")',
  'button:has-text("Sign in")',
  'a:has-text("Sign in")',
];
const LOGGED_IN_CANDIDATES = [
  'button:has-text("Logout")',
  'button:has-text("Sign out")',
  'a:has-text("Logout")',
  'a:has-text("Account")',
  '[aria-label*="account" i]',
  '[aria-label*="profile" i]',
];

/** Try each candidate in order; return the first whose locator is visible. */
async function firstVisibleLocator(page: Page, candidates: string[], timeoutMs = 2500): Promise<Locator | null> {
  // Give the first (most specific) candidate the bulk of the budget; probe the rest briefly.
  for (let i = 0; i < candidates.length; i++) {
    const loc = page.locator(candidates[i]!).first();
    try {
      await loc.waitFor({ state: "visible", timeout: i === 0 ? timeoutMs : Math.min(timeoutMs, 800) });
      return loc;
    } catch {
      /* next candidate */
    }
  }
  return null;
}

/** Derive the most durable Target for a visible element from its live attributes. */
async function targetFromLocator(loc: Locator): Promise<Target> {
  const a = await loc.evaluate((el) => {
    const inp = el as HTMLInputElement;
    return {
      testId: el.getAttribute("data-testid") || el.getAttribute("data-test-id") || "",
      placeholder: inp.placeholder || "",
      ariaLabel: el.getAttribute("aria-label") || "",
      role: el.getAttribute("role") || "",
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
      id: el.id || "",
    };
  });
  if (a.testId) return { kind: "testId", value: a.testId };
  if (a.placeholder) return { kind: "placeholder", value: a.placeholder };
  if (a.ariaLabel) return { kind: "label", value: a.ariaLabel };
  if (a.text && (a.tag === "button" || a.tag === "a" || a.role)) {
    return { kind: "role", role: a.role || (a.tag === "a" ? "link" : "button"), name: a.text };
  }
  if (a.id) return { kind: "css", value: `#${a.id.replace(/[^a-zA-Z0-9_-]/g, "\\$&")}` };
  return { kind: "css", value: a.tag };
}

async function verifyAuth(page: Page): Promise<boolean> {
  await page.waitForTimeout(500);
  const stillLoggedOut = await firstVisibleLocator(page, LOGGED_OUT_CANDIDATES, 1500);
  if (!stillLoggedOut) return true; // the login control disappeared → likely signed in
  const loggedIn = await firstVisibleLocator(page, LOGGED_IN_CANDIDATES, 1500);
  return Boolean(loggedIn);
}

async function dumpLoginDiagnostics(page: Page): Promise<void> {
  try {
    const info = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll("input")).map(
        (i) => `input[type=${(i as HTMLInputElement).type} name=${(i as HTMLInputElement).name} ph="${((i as HTMLInputElement).placeholder || "").slice(0, 24)}"]`,
      );
      const buttons = Array.from(document.querySelectorAll('button,a,[role="button"]'))
        .map((b) => (b.textContent || "").trim().slice(0, 24))
        .filter(Boolean)
        .slice(0, 12);
      return { url: location.href, inputs: inputs.slice(0, 8), buttons };
    });
    console.warn(`  [crawl] login diagnostics — url=${info.url}`);
    console.warn(`  [crawl]   inputs: ${info.inputs.join(" ; ") || "(none)"}`);
    console.warn(`  [crawl]   buttons: ${info.buttons.join(" ; ") || "(none)"}`);
  } catch {
    /* ignore */
  }
}

/**
 * Log in and CAPTURE the exact working flow (trigger + email + advance + password)
 * as durable Targets. Verifies success before returning.
 */
async function attemptLogin(
  page: Page,
  productionUrl: string,
  email: string,
  password: string,
): Promise<LoginSelectors | null> {
  console.log("  [crawl] attempting login …");

  const tryForm = async (url: string, trigger?: Target): Promise<LoginSelectors | null> => {
    const emailLoc = await firstVisibleLocator(page, EMAIL_CANDIDATES, 3000);
    if (!emailLoc) return null;
    const emailTarget = await targetFromLocator(emailLoc);
    await emailLoc.fill(email).catch(() => {});
    await page.waitForTimeout(400);

    // password may be on the same screen, behind Enter, or behind a Next click.
    let passLoc = await firstVisibleLocator(page, PASSWORD_CANDIDATES, 1500);
    let advance: "enter" | "click" | undefined;
    let next: Target | undefined;
    if (!passLoc) {
      await emailLoc.press("Enter").catch(() => {});
      await page.waitForTimeout(1500);
      passLoc = await firstVisibleLocator(page, PASSWORD_CANDIDATES, 2500);
      if (passLoc) advance = "enter";
    }
    if (!passLoc) {
      const nextLoc = await firstVisibleLocator(page, NEXT_CANDIDATES, 1500);
      if (nextLoc) {
        next = await targetFromLocator(nextLoc);
        await nextLoc.click().catch(() => {});
        await page.waitForTimeout(1500);
        passLoc = await firstVisibleLocator(page, PASSWORD_CANDIDATES, 2500);
        if (passLoc) advance = "click";
      }
    }
    if (!passLoc) return null;

    const passwordTarget = await targetFromLocator(passLoc);
    await passLoc.fill(password).catch(() => {});
    await page.waitForTimeout(300);
    await passLoc.press("Enter").catch(() => {});
    await page.waitForTimeout(3000);

    const ok = await verifyAuth(page);
    console.log(`  [crawl] login ${ok ? "verified" : "UNVERIFIED"} at ${url}${advance ? ` (advance:${advance})` : ""} → ${page.url()}`);
    return { url, trigger, email: emailTarget, advance, next, password: passwordTarget };
  };

  // 1. Known sign-in paths.
  for (const p of ["/login", "/signin", "/auth/signin", "/sign-in", "/auth/login"]) {
    try {
      await page.goto(new URL(p, productionUrl).href, { waitUntil: "domcontentloaded", timeout: 10_000 });
      await page.waitForTimeout(1500);
      const r = await tryForm(page.url());
      if (r) return r;
    } catch {
      /* try next */
    }
  }

  // 2. Home-page trigger that opens an inline/modal form.
  try {
    await page.goto(productionUrl, { waitUntil: "domcontentloaded", timeout: 10_000 }).catch(() => {});
    const triggerLoc = await firstVisibleLocator(page, LOGIN_TRIGGER_CANDIDATES, 3000);
    if (triggerLoc) {
      const trigger = await targetFromLocator(triggerLoc);
      await triggerLoc.click().catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(1200);
      const r = await tryForm(page.url(), trigger);
      if (r) return r;
    }
  } catch {
    /* fall through */
  }

  console.warn("  [crawl] could not complete login");
  await dumpLoginDiagnostics(page);
  return null;
}

// ── Per-feature catalog (multi-pass exploration) ────────────────────────────────

// Verbs that mark a "primary action" worth clicking to reveal result state.
const GENERATE_VERBS = [
  "generate", "create", "search", "run", "ask", "send", "submit", "go", "build",
  "analyze", "analyse", "map", "start", "try", "explore", "query", "render", "preview",
];
// Labels we must NEVER auto-click during reveal — destructive, billing, or auth/exit.
const UNSAFE_REVEAL_LABELS = [
  "logout", "log out", "sign out", "signout", "delete", "remove", "disconnect",
  "connect", "upgrade", "subscribe", "billing", "pay", "purchase", "checkout",
  "publish", "deploy", "invite", "reset", "clear all", "cancel", "unsubscribe",
  "log in", "login", "sign in", "signin", "sign up", "signup",
];
const REVEAL_INPUT_CANDIDATES = [
  "textarea",
  'input[type="text"]',
  'input[type="search"]',
  "input:not([type])",
  '[role="textbox"]',
  '[contenteditable="true"]',
];

function isSafeRevealLabel(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (!t) return false;
  return !UNSAFE_REVEAL_LABELS.some((u) => t.includes(u));
}

function revealMatch(t: Target): { role?: string; name?: string } {
  if (t.kind === "role") return { role: t.role, name: t.name };
  if (t.kind === "text" || t.kind === "label" || t.kind === "placeholder") return { name: t.value };
  return {};
}

/**
 * Merge freshly-extracted entries into the running catalog, deduping by the
 * shared catalogKey. Focus-matching entries win over weaker duplicates; entries
 * captured during the interaction pass are flagged `revealed`.
 */
function mergeCatalog(
  into: Map<string, CatalogEntry>,
  entries: CatalogEntry[],
  opts: { revealed?: boolean; keywords: string[] },
): void {
  for (const e of entries) {
    const key = catalogKey(e);
    const tagged: CatalogEntry = opts.revealed ? { ...e, revealed: true } : e;
    const existing = into.get(key);
    if (!existing) {
      into.set(key, tagged);
      continue;
    }
    // Prefer the entry that better matches the focus request; otherwise keep the
    // first (static) capture so non-revealed elements stay non-revealed.
    if (focusMatchScore(tagged.text, opts.keywords) > focusMatchScore(existing.text, opts.keywords)) {
      into.set(key, { ...tagged, revealed: existing.revealed || tagged.revealed });
    }
  }
}

/** Order + cap the merged catalog so focus matches survive the cap; re-id stably. */
function finalizeCatalog(map: Map<string, CatalogEntry>, keywords: string[], cap = 60): CatalogEntry[] {
  const all = [...map.values()];
  const matches = all.filter((e) => textMatchesFocus(e.text, keywords));
  const rest = all.filter((e) => !textMatchesFocus(e.text, keywords));
  return [...matches, ...rest].slice(0, cap).map((e, i) => ({ ...e, id: i }));
}

/** Scroll down the page in viewport steps, re-extracting at each position. */
async function scrollAndExtract(
  page: Page,
  merged: Map<string, CatalogEntry>,
  keywords: string[],
  opts: { revealed?: boolean; steps?: number } = {},
): Promise<void> {
  const vh = page.viewportSize()?.height ?? 900;
  const steps = opts.steps ?? 2;
  for (let mult = 1; mult <= steps; mult++) {
    await page.evaluate((y) => window.scrollTo(0, y), vh * mult).catch(() => {});
    await page.waitForTimeout(350);
    mergeCatalog(merged, await extractCatalog(page, 60), { revealed: opts.revealed, keywords });
  }
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.waitForTimeout(150);
}

/**
 * Derive a domain-appropriate sample query for a feature's text input.
 * We use the feature's own metadata — NOT the focus keywords — because
 * focus keywords describe which result-state button to click ("Save to Notion"),
 * not what question to ask the app. Using keywords as the query would send
 * "save notion" to an AI assistant and likely produce no usable output.
 */
/** @internal exported for tests only */
export function deriveSampleQuery(feature: AppFeature): string {
  // Prefer the first suggestedFlow step if it reads like a user input
  // (long enough, doesn't start with an action verb like "click"/"hover").
  const firstFlow = (feature.suggestedFlow?.[0] ?? "").trim();
  if (firstFlow.length > 10 && !/^(click|hover|scroll|navigate|open|go to|press|tap)/i.test(firstFlow)) {
    return firstFlow.slice(0, 200);
  }
  // Fall back to the feature description as a natural prompt.
  if (feature.description && feature.description.length > 8) {
    return `Show me: ${feature.description.slice(0, 150)}`;
  }
  return "Give me a quick overview";
}

/**
 * Poll until a focus-matching element appears in the live catalog OR the catalog
 * grows significantly (indicating results rendered), up to maxWaitMs.
 * Used instead of a fixed timeout after an AI-generation click, since generation
 * can take 3–30 s depending on the model.
 */
async function waitForCatalogChange(
  page: Page,
  merged: Map<string, CatalogEntry>,
  keywords: string[],
  maxWaitMs: number,
): Promise<void> {
  const baseSize = merged.size;
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    const fresh = await extractCatalog(page, 60).catch(() => [] as CatalogEntry[]);
    const hasFocusMatch = keywords.length > 0 && fresh.some((e) => textMatchesFocus(e.text, keywords));
    const grewSignificantly = fresh.length > baseSize + 2;
    if (hasFocusMatch || grewSignificantly) {
      console.log(
        `  [crawl] generation settled: ${fresh.length} elements` +
          (hasFocusMatch ? ` (focus match found)` : " (catalog grew)"),
      );
      return;
    }
  }
  console.warn(`  [crawl] generation wait timed out after ${maxWaitMs}ms — extracting current state`);
}

/**
 * Bounded, guarded interaction to reveal result-state controls (e.g. "Save to
 * Notion", which only renders after a result exists). Fills a text input with a
 * sample query and clicks a SAFE primary action (generate/search/submit, or a
 * focus-matching label), then re-extracts. Rolls back and returns undefined if the
 * click leaves the app (off-origin) or opens a popup. Returns the durable-Target
 * step sequence so the recorder can replay it on camera.
 */
async function revealByInteraction(
  page: Page,
  productionUrl: string,
  feature: AppFeature,
  keywords: string[],
  merged: Map<string, CatalogEntry>,
): Promise<DemoStep[] | undefined> {
  const origin = new URL(productionUrl).origin;
  const steps: DemoStep[] = [];

  // 1. Fill a text input, if one exists.
  const inputLoc = await firstVisibleLocator(page, REVEAL_INPUT_CANDIDATES, 1500);
  if (inputLoc) {
    // Use a domain-appropriate query derived from the feature, NOT the focus keywords.
    // Focus keywords describe which button to click ("Save to Notion"), not what topic to research.
    const sampleQuery = deriveSampleQuery(feature);
    const inputTarget = await targetFromLocator(inputLoc);
    await inputLoc.fill(sampleQuery).catch(() => {});
    await page.waitForTimeout(400);
    steps.push({ action: "fill", target: inputTarget, match: revealMatch(inputTarget), value: sampleQuery, narration: `Trying out ${feature.name}.` });
  }

  // 2. Pick a SAFE primary action: focus-matching label first, else a generate verb.
  let best: { loc: Locator; text: string } | null = null;
  let bestScore = -1;
  const buttons = await page.locator('button, [role="button"], input[type="submit"]').all();
  for (const loc of buttons.slice(0, 30)) {
    let text = "";
    try {
      if (!(await loc.isVisible())) continue;
      if (!(await loc.isEnabled())) continue;
      text = ((await loc.getAttribute("aria-label")) || (await loc.innerText()) || (await loc.getAttribute("value")) || "")
        .replace(/\s+/g, " ")
        .trim();
    } catch {
      continue;
    }
    if (!text || !isSafeRevealLabel(text)) continue;
    const tl = text.toLowerCase();
    let score = focusMatchScore(text, keywords) * 5;
    if (GENERATE_VERBS.some((v) => tl.includes(v))) score += 2;
    if (score <= 0) continue; // only click a plausible primary action, never a random button
    if (score > bestScore) {
      bestScore = score;
      best = { loc, text };
    }
  }

  if (!best && !inputLoc) return undefined; // nothing safe to do here

  if (best) {
    const btnTarget = await targetFromLocator(best.loc);
    const ctx = page.context();
    let popup: Page | null = null;
    const onPage = (p: Page) => {
      popup = p;
    };
    ctx.on("page", onPage);
    await best.loc.click({ timeout: 3000 }).catch(() => {});
    await waitForCatalogChange(page, merged, keywords, 15_000);
    ctx.off("page", onPage);

    const offOrigin = (() => {
      try {
        return new URL(page.url()).origin !== origin;
      } catch {
        return false;
      }
    })();
    if (popup || offOrigin) {
      if (popup) await (popup as Page).close().catch(() => {});
      await page.goto(new URL(feature.entryPath, productionUrl).href, { waitUntil: "domcontentloaded", timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(800);
      console.warn(`  [crawl] ${feature.name}: reveal click left the app — rolled back`);
      return undefined;
    }
    steps.push({ action: "click", target: btnTarget, match: revealMatch(btnTarget), narration: `${best.text}.` });
  } else if (inputLoc) {
    // Filled an input but found no generate button — submit search-style UIs with Enter.
    await inputLoc.press("Enter").catch(() => {});
    steps.push({ action: "keypress", key: "Enter", narration: "Running it." });
    await waitForCatalogChange(page, merged, keywords, 15_000);
  }

  steps.push({ action: "wait", waitMs: 2500, narration: "Waiting for the result to load." });

  // 3. Catalog the revealed result state (including below-the-fold result controls).
  mergeCatalog(merged, await extractCatalog(page, 60), { revealed: true, keywords });
  await scrollAndExtract(page, merged, keywords, { revealed: true, steps: 2 });

  return steps.length ? steps : undefined;
}

/** Visit one feature's page (authenticated) and capture its live element catalog. */
async function crawlFeaturePage(
  page: Page,
  productionUrl: string,
  feature: AppFeature,
  keywords: string[],
): Promise<AppFeature> {
  const url = new URL(feature.entryPath, productionUrl).href;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.waitForTimeout(1500); // let client-side render settle
  } catch {
    console.warn(`  [crawl] ${feature.name}: navigation failed`);
    return { ...feature, liveElements: [] };
  }

  const merged = new Map<string, CatalogEntry>();
  mergeCatalog(merged, await extractCatalog(page, 60), { keywords });
  const initialCount = merged.size;

  // Pass 2: scroll to reveal below-the-fold controls (fail-soft).
  try {
    await scrollAndExtract(page, merged, keywords, { steps: 2 });
  } catch (err) {
    console.warn(`  [crawl] ${feature.name}: scroll pass skipped: ${String(err).split("\n")[0]}`);
  }
  const afterScroll = merged.size;

  // Pass 3: guarded interaction to reveal result-state controls (fail-soft).
  let revealSteps: DemoStep[] | undefined;
  try {
    revealSteps = await revealByInteraction(page, productionUrl, feature, keywords, merged);
  } catch (err) {
    console.warn(`  [crawl] ${feature.name}: reveal interaction skipped: ${String(err).split("\n")[0]}`);
  }

  const liveElements = finalizeCatalog(merged, keywords);
  const revealedCount = liveElements.filter((e) => e.revealed).length;
  console.log(
    `  [crawl] ${feature.name}: ${liveElements.length} live elements ` +
      `(${initialCount} initial, +${afterScroll - initialCount} scroll, +${revealedCount} revealed)`,
  );
  return { ...feature, liveElements, ...(revealSteps?.length ? { revealSteps } : {}) };
}

// ── Public API ─────────────────────────────────────────────────────────────────

export interface CrawlOptions {
  authEmail?: string;
  authPassword?: string;
  /** Directory to write the authenticated storageState (auth.json). */
  outDir?: string;
  /** Free-form user refinement (e.g. "click Save to Notion") that steers the reveal pass. */
  focusArea?: string;
}

export async function crawlAndEnrich(
  featureMap: AppFeatureMap,
  productionUrl: string,
  opts: CrawlOptions = {},
): Promise<AppFeatureMap> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  try {
    await page.goto(productionUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.waitForTimeout(1500);
  } catch {
    console.warn("  [crawl] root visit failed, continuing");
  }

  // Log in, then persist the authenticated session for the record phase.
  let login: LoginSelectors | null = null;
  let authStatePath: string | undefined;
  if (opts.authEmail && opts.authPassword) {
    login = await attemptLogin(page, productionUrl, opts.authEmail, opts.authPassword);
    if (login) {
      try {
        const dir = opts.outDir ?? path.join(os.tmpdir(), "recordly-auto-demo");
        fs.mkdirSync(dir, { recursive: true });
        authStatePath = path.join(dir, "auth.json");
        await context.storageState({ path: authStatePath });
        console.log(`  [crawl] saved auth state → ${authStatePath}`);
      } catch (err) {
        console.warn(`  [crawl] failed to save auth state: ${String(err).split("\n")[0]}`);
        authStatePath = undefined;
      }
    }
  }

  const keywords = extractFocusKeywords(opts.focusArea);
  if (keywords.length) console.log(`  [crawl] focus keywords: ${keywords.join(", ")}`);
  const updatedFeatures: AppFeature[] = [];
  for (const feature of featureMap.features) {
    updatedFeatures.push(await crawlFeaturePage(page, productionUrl, feature, keywords));
  }

  await page.close().catch(() => {});
  await context.close().catch(() => {});
  await browser.close().catch(() => {});

  return {
    ...featureMap,
    features: updatedFeatures,
    ...(login ? { loginSelectors: login, loginUrl: login.url } : {}),
    ...(authStatePath ? { authStatePath } : {}),
  };
}
