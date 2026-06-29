/**
 * Playwright crawl stage (M5).
 *
 * Visits each feature's entryPath on the production URL and:
 *   - Verifies / updates selectors with live DOM observations
 *   - Enriches suggestedFlow with discovered accessible names and selectors
 *
 * The crawl is the AUTHORITY for selectors — LLM likelySelectors are hints
 * only. Every step in the generated demo script will use selectors discovered
 * here rather than LLM guesses.
 */

import { chromium, type Page } from "playwright";
import type { AppFeatureMap, AppFeature, LoginSelectors } from "../schema/appFeatureMap.js";

interface CrawlResult {
  /** Feature with updated selectors from live DOM */
  feature: AppFeature;
  /** Discovered interactable elements: { selector, role, label }[] */
  elements: DiscoveredElement[];
}

export interface DiscoveredElement {
  selector: string;
  role?: string;
  label?: string;
  tag: string;
  isInteractable: boolean;
}

/** Visit one feature path and return discovered elements */
async function crawlFeaturePage(
  page: Page,
  productionUrl: string,
  feature: AppFeature,
): Promise<CrawlResult> {
  const url = new URL(feature.entryPath, productionUrl).href;
  console.log(`  [crawl] ${feature.name}: ${url}`);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.waitForTimeout(1500); // let client-side render settle
  } catch {
    console.warn(`  [crawl] ${feature.name}: navigation failed, skipping`);
    return { feature, elements: [] };
  }

  // Collect interactable elements visible in the viewport
  const elements: DiscoveredElement[] = await page.evaluate(() => {
    const results: Array<{
      selector: string;
      role?: string;
      label?: string;
      tag: string;
      isInteractable: boolean;
    }> = [];

    const seen = new Set<string>();
    const interactableTags = new Set(["a", "button", "input", "textarea", "select", "[role]"]);

    const els = document.querySelectorAll(
      'a, button, input, textarea, select, [role="button"], [role="textbox"], [role="searchbox"], [role="combobox"], [role="tab"], [role="menuitem"]',
    );

    for (const el of Array.from(els).slice(0, 50)) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.top < 0 || rect.top > window.innerHeight * 1.5) continue;

      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role") ?? undefined;
      const ariaLabel = el.getAttribute("aria-label") ?? undefined;
      const placeholder = (el as HTMLInputElement).placeholder ?? undefined;
      const text = el.textContent?.trim().slice(0, 60) ?? undefined;
      const testId = el.getAttribute("data-testid") ?? undefined;
      const id = el.id ? `#${el.id}` : undefined;

      const label = ariaLabel ?? placeholder ?? text ?? undefined;

      // Build a selector in priority: testId > id > type-appropriate match.
      // Inputs/textareas/selects have NO text content, so `:has-text` never
      // matches them — use placeholder/aria-label attribute selectors instead.
      const isField = tag === "input" || tag === "textarea" || tag === "select";
      let selector: string;
      if (testId) {
        selector = `[data-testid="${testId}"]`;
      } else if (id) {
        selector = id;
      } else if (isField) {
        if (placeholder) selector = `${tag}[placeholder="${placeholder.slice(0, 40)}"]`;
        else if (ariaLabel) selector = `${tag}[aria-label="${ariaLabel.slice(0, 40)}"]`;
        else if (role) selector = `[role="${role}"]`;
        else selector = tag;
      } else if (text) {
        selector = `${tag}:has-text("${text.slice(0, 40)}")`;
      } else if (ariaLabel) {
        selector = `${tag}[aria-label="${ariaLabel.slice(0, 40)}"]`;
      } else if (role) {
        selector = `[role="${role}"]`;
      } else {
        selector = tag;
      }

      const key = `${selector}:${label ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);

      void interactableTags; // silence unused var

      results.push({
        selector,
        role,
        label,
        tag,
        isInteractable: true,
      });
    }
    return results;
  });

  // Verify LLM-guessed selectors and update them to live-discovered ones
  const verifiedSelectors: string[] = [];
  for (const sel of feature.likelySelectors ?? []) {
    try {
      const found = await page.$(sel);
      if (found) verifiedSelectors.push(sel);
    } catch { /* invalid selector */ }
  }

  // Rank discovered elements by relevance to THIS feature so each feature gets
  // distinct, meaningful selectors instead of the same generic top-of-page
  // buttons (all features share entryPath "/", so the raw element list is
  // identical for every one of them).
  const keywords = [feature.name, feature.description, ...(feature.suggestedFlow ?? [])]
    .join(" ")
    .toLowerCase()
    .match(/[a-z]{4,}/g) ?? [];
  const labelled = elements.filter((e) => e.label);
  const discoveredSelectors = labelled
    .map((e, i) => {
      const label = (e.label ?? "").toLowerCase();
      const score = keywords.reduce((s, k) => (label.includes(k) ? s + 1 : s), 0);
      return { e, score, i };
    })
    // higher relevance first; preserve original order for ties
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, 5)
    .map(({ e }) => e.selector);

  const updatedFeature: AppFeature = {
    ...feature,
    likelySelectors: [
      ...verifiedSelectors,
      ...discoveredSelectors.filter((s) => !verifiedSelectors.includes(s)),
    ].slice(0, 8),
  };

  console.log(
    `  [crawl] ${feature.name}: ${elements.length} elements, ${updatedFeature.likelySelectors?.length ?? 0} selectors`,
  );
  return { feature: updatedFeature, elements };
}

export interface CrawlOptions {
  authEmail?: string;
  authPassword?: string;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Crawl the production URL and enrich the AppFeatureMap with live selectors.
 * If credentials are provided, attempts to log in before crawling so that
 * auth-gated pages yield meaningful selectors.
 */
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

  // First visit the root to set cookies / trigger redirects
  try {
    await page.goto(productionUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.waitForTimeout(1500);
  } catch {
    console.warn("  [crawl] root visit failed, continuing with feature pages");
  }

  // Attempt login if credentials provided
  let login: LoginSelectors | null = null;
  if (opts.authEmail && opts.authPassword) {
    login = await attemptLogin(page, productionUrl, opts.authEmail, opts.authPassword);
  }

  const updatedFeatures: AppFeature[] = [];
  for (const feature of featureMap.features) {
    const result = await crawlFeaturePage(page, productionUrl, feature);
    updatedFeatures.push(result.feature);
  }

  await page.close();
  await context.close();
  await browser.close();

  return {
    ...featureMap,
    features: updatedFeatures,
    ...(login ? { loginUrl: login.url, loginSelectors: login } : {}),
  };
}

const EMAIL_SELECTORS = [
  'input[type="email"]',
  'input[name="email"]',
  'input[name="username"]',
  'input[autocomplete="username"]',
  'input[id*="email" i]',
];
const PASSWORD_SELECTORS = [
  'input[type="password"]',
  'input[name="password"]',
  'input[autocomplete="current-password"]',
];
const NEXT_SELECTORS = [
  'button:has-text("Next")',
  'button:has-text("Continue")',
  'button[type="submit"]',
  'input[type="submit"]',
];

/** Return the first selector in `candidates` that points to a visible element. */
async function firstVisibleSelector(
  page: import("playwright").Page,
  candidates: string[],
  timeoutMs = 2000,
): Promise<string | null> {
  for (const sel of candidates) {
    const visible = await page.locator(sel).first().isVisible({ timeout: timeoutMs }).catch(() => false);
    if (visible) return sel;
  }
  return null;
}

/**
 * Log in during the crawl and CAPTURE the exact selectors that worked, including
 * a Next/Continue click for multi-step (email-then-password) forms. The demo
 * script later replays these verified selectors instead of guessing.
 */
async function attemptLogin(
  page: import("playwright").Page,
  productionUrl: string,
  email: string,
  password: string,
): Promise<LoginSelectors | null> {
  console.log("  [crawl] attempting login …");

  const tryForm = async (formUrl: string): Promise<LoginSelectors | null> => {
    const emailSel = await firstVisibleSelector(page, EMAIL_SELECTORS);
    if (!emailSel) return null;
    await page.locator(emailSel).first().fill(email);
    await page.waitForTimeout(300);

    // Password may already be visible (single page) or require a Next click.
    let passSel = await firstVisibleSelector(page, PASSWORD_SELECTORS, 1500);
    let nextSel: string | undefined;
    if (!passSel) {
      const next = await firstVisibleSelector(page, NEXT_SELECTORS, 1500);
      if (next) {
        await page.locator(next).first().click().catch(() => {});
        await page.waitForTimeout(1500);
        passSel = await firstVisibleSelector(page, PASSWORD_SELECTORS, 2500);
        if (passSel) nextSel = next;
      }
    }
    if (!passSel) return null;

    await page.locator(passSel).first().fill(password);
    await page.waitForTimeout(300);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(3000);
    console.log(`  [crawl] login submitted at ${formUrl}${nextSel ? " (multi-step)" : ""} → ${page.url()}`);
    return { url: formUrl, emailSelector: emailSel, passwordSelector: passSel, nextSelector: nextSel };
  };

  // 1. Known sign-in paths.
  for (const signinPath of ["/login", "/signin", "/auth/signin", "/sign-in", "/auth/login"]) {
    try {
      await page.goto(new URL(signinPath, productionUrl).href, { waitUntil: "domcontentloaded", timeout: 10_000 });
      await page.waitForTimeout(1500);
      const result = await tryForm(page.url());
      if (result) return result;
    } catch { /* try next path */ }
  }

  // 2. Fallback: click a Login/Sign in control on the current page.
  try {
    const loginBtn = page.locator('button:has-text("Login"), a:has-text("Login"), button:has-text("Sign in"), a:has-text("Sign in")').first();
    if (await loginBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await loginBtn.click();
      await page.waitForTimeout(2000);
      const result = await tryForm(page.url());
      if (result) return result;
    }
  } catch { /* skip */ }

  console.warn("  [crawl] could not find login form — crawling as anonymous");
  return null;
}
