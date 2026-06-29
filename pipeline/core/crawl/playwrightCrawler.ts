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
import type { Target } from "../schema/target.js";
import { extractCatalog } from "../record/locator.js";

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

// ── Per-feature catalog ─────────────────────────────────────────────────────────

/** Visit one feature's page (authenticated) and capture its live element catalog. */
async function crawlFeaturePage(page: Page, productionUrl: string, feature: AppFeature): Promise<AppFeature> {
  const url = new URL(feature.entryPath, productionUrl).href;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.waitForTimeout(1500); // let client-side render settle
  } catch {
    console.warn(`  [crawl] ${feature.name}: navigation failed`);
    return { ...feature, liveElements: [] };
  }

  const liveElements = await extractCatalog(page, 40);
  console.log(`  [crawl] ${feature.name}: ${liveElements.length} live elements`);
  return { ...feature, liveElements };
}

// ── Public API ─────────────────────────────────────────────────────────────────

export interface CrawlOptions {
  authEmail?: string;
  authPassword?: string;
  /** Directory to write the authenticated storageState (auth.json). */
  outDir?: string;
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

  const updatedFeatures: AppFeature[] = [];
  for (const feature of featureMap.features) {
    updatedFeatures.push(await crawlFeaturePage(page, productionUrl, feature));
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
