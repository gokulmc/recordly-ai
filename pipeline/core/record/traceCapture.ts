/**
 * Action wrappers that execute Playwright actions AND record InteractionEvents.
 *
 * Each wrapper:
 *   1. Executes the Playwright action
 *   2. Waits for layout to settle (2× rAF, via captureElementInfo)
 *   3. Reads DOM facts (bbox, cursor, role, container, occlusion)
 *   4. Appends an InteractionEvent to the live trace
 *
 * The trace is mutated in place (passed by reference). Callers (recorder.ts)
 * accumulate a single InteractionTrace across the whole recording session.
 */

import { performance } from "node:perf_hooks";
import type { Locator, Page } from "playwright";
import type { InteractionEvent, InteractionTrace } from "../schema/interactionTrace.js";
import { captureElementInfo, capturePageContext } from "./domCapture.js";
import { perfNowToEventTms } from "./syncBeacon.js";

/**
 * Per-action wait budget. Kept short so a missed selector does not dead-air the
 * recording for the full Playwright default (30s). One bad step then costs a
 * couple of seconds, not half a minute.
 */
export const ACTION_TIMEOUT_MS = 7000;
const FALLBACK_TIMEOUT_MS = 1500;

function currentSegment(trace: InteractionTrace) {
	const seg = trace.segments[trace.segments.length - 1];
	if (!seg) throw new Error("No calibration segment on trace — inject a beacon first");
	return seg;
}

/** Pull the quoted text out of a text/has-text style selector, if present. */
function extractSelectorText(selector: string): string | null {
	const m =
		selector.match(/has-text\(\s*["'](.+?)["']\s*\)/i) ??
		selector.match(/:text(?:-is)?\(\s*["'](.+?)["']\s*\)/i) ??
		selector.match(/^text=["']?(.+?)["']?$/i);
	return m?.[1]?.trim() ?? null;
}

/**
 * Derive looser fallback selectors from a primary one. The script generator and
 * crawl often emit over-specific text selectors (full sentence, exact casing)
 * that miss the live DOM; these variants recover most of them.
 */
function fallbackSelectors(selector: string): string[] {
	const text = extractSelectorText(selector);
	if (!text) return [];
	const variants = new Set<string>();
	// case-insensitive substring match on the full text
	variants.add(`text=${text}`);
	// role-scoped variants
	variants.add(`button:has-text("${text}")`);
	variants.add(`a:has-text("${text}")`);
	// first few words, for when the full string is too specific
	const short = text.split(/\s+/).slice(0, 4).join(" ");
	if (short && short !== text) {
		variants.add(`:text("${short}")`);
		variants.add(`text=${short}`);
	}
	variants.delete(selector);
	return [...variants];
}

async function firstVisible(page: Page, selector: string, timeoutMs: number): Promise<Locator | null> {
	const loc = page.locator(selector).first();
	try {
		await loc.waitFor({ state: "visible", timeout: timeoutMs });
		return loc;
	} catch {
		return null;
	}
}

/**
 * Resolve a selector to a visible locator, trying the primary selector first
 * (short timeout) and then derived fallbacks. Returns the locator AND the
 * selector that actually matched (so DOM facts can be captured from it).
 */
export async function resolveAction(
	page: Page,
	selector: string,
	timeoutMs = ACTION_TIMEOUT_MS,
): Promise<{ locator: Locator; selector: string } | null> {
	const primary = await firstVisible(page, selector, timeoutMs);
	if (primary) return { locator: primary, selector };

	for (const fb of fallbackSelectors(selector)) {
		const loc = await firstVisible(page, fb, FALLBACK_TIMEOUT_MS);
		if (loc) {
			console.log(`  [recorder] selector fallback: "${selector}" → "${fb}"`);
			return { locator: loc, selector: fb };
		}
	}
	return null;
}

/**
 * Capture a navigate event. Waits for `networkidle` so the new page is fully
 * loaded before capturing context. Creates no new segment (caller does that
 * after navigation if viewport/DPR changed).
 */
export async function traceNavigate(
	page: Page,
	trace: InteractionTrace,
	url: string,
): Promise<void> {
	const tStart = performance.now();
	await page.goto(url, { waitUntil: "networkidle" });
	const tMs = perfNowToEventTms(performance.now(), currentSegment(trace));
	const ctx = await capturePageContext(page);

	const seg = currentSegment(trace);
	const event: InteractionEvent = {
		tMs,
		segmentId: seg.id,
		action: "navigate",
		bbox: { x: 0, y: 0, w: ctx.viewport.w, h: ctx.viewport.h },
		selector: url,
		...ctx,
		layoutStableAtMs: tMs,
	};
	trace.events.push(event);
}

/**
 * Capture a click event. Uses `page.click()` which moves the cursor and fires
 * mouse events, matching what a real user would do.
 */
export async function traceClick(
	page: Page,
	trace: InteractionTrace,
	selector: string,
): Promise<void> {
	const seg = currentSegment(trace);
	const resolved = await resolveAction(page, selector);
	if (!resolved) throw new Error(`no visible element for selector ${selector}`);
	await resolved.locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
	await resolved.locator.click({ timeout: ACTION_TIMEOUT_MS });
	const tMs = perfNowToEventTms(performance.now(), seg);
	const info = await captureElementInfo(page, resolved.selector);
	if (!info) return;

	const ctx = await capturePageContext(page);
	const event: InteractionEvent = {
		tMs,
		segmentId: seg.id,
		action: "click",
		bbox: info.bbox,
		visibleBbox: info.visibleBbox,
		containerBbox: info.containerBbox,
		occluded: info.occluded || undefined,
		selector,
		role: info.role,
		accessibleName: info.accessibleName,
		computedCursor: info.computedCursor,
		text: info.text,
		scroll: info.scroll,
		viewport: info.viewport,
		url: ctx.url,
		layoutStableAtMs: tMs,
	};
	trace.events.push(event);
}

/**
 * Capture a double-click event.
 */
export async function traceDblClick(
	page: Page,
	trace: InteractionTrace,
	selector: string,
): Promise<void> {
	const seg = currentSegment(trace);
	const resolved = await resolveAction(page, selector);
	if (!resolved) throw new Error(`no visible element for selector ${selector}`);
	await resolved.locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
	await resolved.locator.dblclick({ timeout: ACTION_TIMEOUT_MS });
	const tMs = perfNowToEventTms(performance.now(), seg);
	const info = await captureElementInfo(page, resolved.selector);
	if (!info) return;

	const ctx = await capturePageContext(page);
	trace.events.push({
		tMs,
		segmentId: seg.id,
		action: "dblclick",
		bbox: info.bbox,
		visibleBbox: info.visibleBbox,
		containerBbox: info.containerBbox,
		selector,
		role: info.role,
		computedCursor: info.computedCursor,
		text: info.text,
		scroll: info.scroll,
		viewport: info.viewport,
		url: ctx.url,
	});
}

/**
 * Capture a fill event (clear + type into an input).
 */
export async function traceFill(
	page: Page,
	trace: InteractionTrace,
	selector: string,
	value: string,
): Promise<void> {
	const seg = currentSegment(trace);
	const resolved = await resolveAction(page, selector);
	if (!resolved) throw new Error(`no visible element for selector ${selector}`);
	await resolved.locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
	await resolved.locator.fill(value, { timeout: ACTION_TIMEOUT_MS });
	const tMs = perfNowToEventTms(performance.now(), seg);
	const info = await captureElementInfo(page, resolved.selector);
	if (!info) return;

	const ctx = await capturePageContext(page);
	trace.events.push({
		tMs,
		segmentId: seg.id,
		action: "fill",
		bbox: info.bbox,
		visibleBbox: info.visibleBbox,
		containerBbox: info.containerBbox,
		selector,
		role: info.role,
		computedCursor: info.computedCursor,
		text: value,
		scroll: info.scroll,
		viewport: info.viewport,
		url: ctx.url,
	});
}

/**
 * Capture a hover event. Hover adds cursor-type telemetry without triggering a
 * click — useful for revealing tooltips or dropdown menus before the click.
 */
export async function traceHover(
	page: Page,
	trace: InteractionTrace,
	selector: string,
): Promise<void> {
	const seg = currentSegment(trace);
	const resolved = await resolveAction(page, selector);
	if (!resolved) throw new Error(`no visible element for selector ${selector}`);
	await resolved.locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
	await resolved.locator.hover({ timeout: ACTION_TIMEOUT_MS });
	const tMs = perfNowToEventTms(performance.now(), seg);
	const info = await captureElementInfo(page, resolved.selector);
	if (!info) return;

	const ctx = await capturePageContext(page);
	trace.events.push({
		tMs,
		segmentId: seg.id,
		action: "hover",
		bbox: info.bbox,
		visibleBbox: info.visibleBbox,
		containerBbox: info.containerBbox,
		selector,
		role: info.role,
		computedCursor: info.computedCursor,
		scroll: info.scroll,
		viewport: info.viewport,
		url: ctx.url,
	});
}

/**
 * Capture a scroll event. We scroll the page by `deltaY` px and record the new
 * viewport state as a scroll action. No element targeting (scrolls the page body).
 */
export async function traceScroll(
	page: Page,
	trace: InteractionTrace,
	deltaY: number,
): Promise<void> {
	const seg = currentSegment(trace);
	await page.evaluate((dy: number) => window.scrollBy(0, dy), deltaY);
	// Small settle wait
	await page.waitForTimeout(100);
	const tMs = perfNowToEventTms(performance.now(), seg);
	const ctx = await capturePageContext(page);

	trace.events.push({
		tMs,
		segmentId: seg.id,
		action: "scroll",
		bbox: { x: 0, y: 0, w: ctx.viewport.w, h: ctx.viewport.h },
		selector: "window",
		scroll: ctx.scroll,
		viewport: ctx.viewport,
		url: ctx.url,
	});
}
