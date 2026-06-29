/**
 * Durable, structured locator targets shared by the crawl (catalog), the script
 * generator, and the recorder. Replaces fragile raw-CSS/`:has-text` strings with
 * Playwright's semantic locators (testId / role+name / label / placeholder /
 * text), falling back to CSS only as a last resort.
 *
 * The same browser-side extractor produces the authenticated element catalog AND
 * powers the recorder's self-heal, so what the LLM plans against is exactly what
 * the recorder can resolve.
 */

import type { Locator, Page } from "playwright";
import type { CatalogEntry, Target } from "../schema/target.js";

export type { CatalogEntry, Target } from "../schema/target.js";

/** Compile a Target to a Playwright Locator (first match). */
export function compileTarget(page: Page, t: Target): Locator {
  switch (t.kind) {
    case "testId":
      return page.getByTestId(t.value).first();
    case "role":
      // role names from the DOM are valid ARIA roles; cast for Playwright's union.
      return page.getByRole(t.role as Parameters<Page["getByRole"]>[0], { name: t.name, exact: false }).first();
    case "label":
      return page.getByLabel(t.value, { exact: false }).first();
    case "placeholder":
      return page.getByPlaceholder(t.value, { exact: false }).first();
    case "text":
      return page.getByText(t.value, { exact: false }).first();
    case "css":
      return page.locator(t.value).first();
  }
}

/** Human-readable form of a Target for logs/trace. */
export function describeTarget(t: Target): string {
  switch (t.kind) {
    case "role":
      return `role=${t.role}[name="${t.name}"]`;
    case "testId":
      return `testId=${t.value}`;
    default:
      return `${t.kind}="${t.value}"`;
  }
}

/**
 * The browser-side extractor, as a stringifiable function. Runs inside
 * page.evaluate to gather visible interactive elements and derive a durable
 * Target for each. Kept dependency-free so it can be serialized.
 */
function browserExtract(maxElements: number): CatalogEntry[] {
  const TAG_ROLE: Record<string, string> = {
    button: "button",
    a: "link",
    select: "combobox",
    textarea: "textbox",
  };
  function inputRole(el: Element): string {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "search") return "searchbox";
    if (type === "submit" || type === "button") return "button";
    return "textbox";
  }
  function accessibleName(el: Element): string {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    const ph = (el as HTMLInputElement).placeholder;
    if (ph && ph.trim()) return ph.trim();
    const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (txt) return txt.slice(0, 80);
    const val = (el as HTMLInputElement).value;
    if (val && val.trim()) return val.trim().slice(0, 80);
    const title = el.getAttribute("title");
    return title ? title.trim().slice(0, 80) : "";
  }
  function cssEscape(s: string): string {
    // CSS.escape is available in modern browsers.
    try {
      return (window as unknown as { CSS: { escape(v: string): string } }).CSS.escape(s);
    } catch {
      return s.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
    }
  }

  const els = document.querySelectorAll(
    'a, button, input, textarea, select, [role="button"], [role="textbox"], [role="searchbox"], [role="combobox"], [role="tab"], [role="menuitem"], [role="link"], [role="checkbox"]',
  );

  const out: CatalogEntry[] = [];
  const seen = new Set<string>();
  let id = 0;

  for (const el of Array.from(els)) {
    if (out.length >= maxElements) break;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (rect.bottom < 0 || rect.top > window.innerHeight * 2) continue;

    const tag = el.tagName.toLowerCase();
    const explicitRole = el.getAttribute("role") || "";
    const role = explicitRole || (tag === "input" ? inputRole(el) : TAG_ROLE[tag] || "");
    const name = accessibleName(el);
    const testId = el.getAttribute("data-testid") || el.getAttribute("data-test-id") || "";
    const placeholder = (el as HTMLInputElement).placeholder || "";
    const ariaLabel = el.getAttribute("aria-label") || "";
    const enabled = !(el as HTMLButtonElement).disabled && el.getAttribute("aria-disabled") !== "true";

    // Build the most durable Target available.
    let target: CatalogEntry["target"];
    if (testId) {
      target = { kind: "testId", value: testId };
    } else if (role && name) {
      target = { kind: "role", role, name };
    } else if (placeholder) {
      target = { kind: "placeholder", value: placeholder };
    } else if (ariaLabel) {
      target = { kind: "label", value: ariaLabel };
    } else if (name && tag !== "input" && tag !== "textarea" && tag !== "select") {
      target = { kind: "text", value: name };
    } else if (el.id) {
      target = { kind: "css", value: `#${cssEscape(el.id)}` };
    } else {
      target = { kind: "css", value: tag };
    }

    // Dedupe by (role|name|kind) so repeated controls don't flood the catalog.
    const key = `${target.kind}:${role}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      id: id++,
      target,
      text: name,
      role,
      tag,
      enabled,
      bbox: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    });
  }
  return out;
}

/** Extract the live element catalog from the current page state. */
export async function extractCatalog(page: Page, maxElements = 40): Promise<CatalogEntry[]> {
  try {
    // tsx/esbuild wraps inner named functions with `__name`, which is undefined
    // in the page context — shim it so serialized helpers don't ReferenceError.
    await page
      .evaluate(() => {
        const g = globalThis as unknown as { __name?: (t: unknown, n?: unknown) => unknown };
        if (!g.__name) g.__name = (t) => t;
      })
      .catch(() => {});
    return await page.evaluate(browserExtract, maxElements);
  } catch (err) {
    console.warn(`  [crawl] catalog extraction failed: ${String(err).split("\n")[0]}`);
    return [];
  }
}

/** Action ↔ element-role compatibility for validation + self-heal. */
export function isActionCompatible(action: string, role: string, tag: string): boolean {
  if (action === "fill" || action === "type") {
    return role === "textbox" || role === "searchbox" || role === "combobox" || tag === "input" || tag === "textarea";
  }
  if (action === "click" || action === "dblclick" || action === "hover" || action === "rightclick") {
    return true; // most visible elements are clickable/hoverable
  }
  return true;
}

/**
 * Bounded, high-confidence self-heal: find a live element matching the recorded
 * intent. Accepts ONLY an action-compatible element whose role matches and whose
 * accessible name is an exact/near-exact match, that is visible+enabled. Returns
 * null otherwise (never guesses on weak signals).
 */
export async function findHealTarget(
  page: Page,
  action: string,
  match: { role?: string; name?: string },
): Promise<Target | null> {
  if (!match.name) return null;
  const catalog = await extractCatalog(page, 60);
  const want = match.name.trim().toLowerCase();
  let best: CatalogEntry | null = null;
  for (const e of catalog) {
    if (!e.enabled) continue;
    if (!isActionCompatible(action, e.role, e.tag)) continue;
    if (match.role && e.role && e.role !== match.role) continue;
    const have = e.text.trim().toLowerCase();
    if (!have) continue;
    const exact = have === want;
    const near = have.includes(want) || want.includes(have);
    if (exact) return e.target; // best possible
    if (near && !best) best = e;
  }
  return best ? best.target : null;
}
