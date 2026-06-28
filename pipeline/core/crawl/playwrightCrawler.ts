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
import type { AppFeatureMap, AppFeature } from "../schema/appFeatureMap.js";

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

      // Build a selector in priority: testId > id > role+label > tag+text
      let selector: string;
      if (testId) {
        selector = `[data-testid="${testId}"]`;
      } else if (id) {
        selector = id;
      } else if (role && label) {
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

  // Add discovered elements as candidate selectors
  const discoveredSelectors = elements
    .filter((e) => e.label)
    .slice(0, 5)
    .map((e) => (e.label ? `${e.tag}:has-text("${e.label.slice(0, 40)}")` : e.selector));

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

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Crawl the production URL and enrich the AppFeatureMap with live selectors.
 */
export async function crawlAndEnrich(
  featureMap: AppFeatureMap,
  productionUrl: string,
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
    await page.waitForTimeout(1000);
  } catch {
    console.warn("  [crawl] root visit failed, continuing with feature pages");
  }

  const updatedFeatures: AppFeature[] = [];
  for (const feature of featureMap.features) {
    const result = await crawlFeaturePage(page, productionUrl, feature);
    updatedFeatures.push(result.feature);
  }

  await page.close();
  await context.close();
  await browser.close();

  return { ...featureMap, features: updatedFeatures };
}
