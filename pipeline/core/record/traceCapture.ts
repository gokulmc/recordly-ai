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
import { captureElementInfo, captureElementInfoFromLocator, capturePageContext } from "./domCapture.js";
import { compileTarget, describeTarget, findHealTarget } from "./locator.js";
import type { Target } from "../schema/target.js";
import { perfNowToEventTms } from "./syncBeacon.js";

/** A step's target hints: a structured Target (preferred), a legacy selector, and a self-heal intent. */
export interface StepRef {
	target?: Target;
	selector?: string;
	match?: { role?: string; name?: string };
}

interface ResolvedStep {
	locator: Locator;
	requested: string;
	resolved: string;
	healed: boolean;
}

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

async function locatorVisible(loc: Locator, timeoutMs: number): Promise<boolean> {
	try {
		await loc.waitFor({ state: "visible", timeout: timeoutMs });
		return true;
	} catch {
		return false;
	}
}

/**
 * Resolve a step to a visible locator. Order: structured Target → legacy
 * selector (+ derived fallbacks) → bounded high-confidence self-heal from the
 * recorded intent (`match`). Returns the requested vs resolved descriptors so
 * heals are auditable in the trace.
 */
export async function resolveStep(
	page: Page,
	ref: StepRef,
	action: string,
	timeoutMs = ACTION_TIMEOUT_MS,
): Promise<ResolvedStep | null> {
	// 1. Structured Target (preferred).
	if (ref.target) {
		const requested = describeTarget(ref.target);
		const loc = compileTarget(page, ref.target);
		if (await locatorVisible(loc, timeoutMs)) {
			return { locator: loc, requested, resolved: requested, healed: false };
		}
		const healed = await tryHeal(page, ref, action, requested);
		if (healed) return healed;
	}

	// 2. Legacy selector string (+ fallbacks).
	if (ref.selector) {
		const r = await resolveAction(page, ref.selector, ref.target ? FALLBACK_TIMEOUT_MS : timeoutMs);
		if (r) {
			return { locator: r.locator, requested: ref.selector, resolved: r.selector, healed: r.selector !== ref.selector };
		}
		const healed = await tryHeal(page, ref, action, ref.selector);
		if (healed) return healed;
	}

	return null;
}

async function tryHeal(page: Page, ref: StepRef, action: string, requested: string): Promise<ResolvedStep | null> {
	if (!ref.match) return null;
	const healTarget = await findHealTarget(page, action, ref.match);
	if (!healTarget) return null;
	const loc = compileTarget(page, healTarget);
	if (!(await locatorVisible(loc, FALLBACK_TIMEOUT_MS))) return null;
	const resolved = describeTarget(healTarget);
	console.log(`  [recorder] healed "${requested}" → "${resolved}"`);
	return { locator: loc, requested, resolved, healed: true };
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
	ref: StepRef,
): Promise<void> {
	const seg = currentSegment(trace);
	const r = await resolveStep(page, ref, "click");
	if (!r) throw new Error(`no visible element for ${describeRef(ref)}`);
	await r.locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
	await r.locator.click({ timeout: ACTION_TIMEOUT_MS });
	const tMs = perfNowToEventTms(performance.now(), seg);
	const info = await captureElementInfoFromLocator(page, r.locator);
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
		selector: r.resolved,
		requestedSelector: r.requested,
		resolvedSelector: r.healed ? r.resolved : undefined,
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

/** Human-readable description of a StepRef for error messages. */
function describeRef(ref: StepRef): string {
	if (ref.target) return describeTarget(ref.target);
	if (ref.selector) return ref.selector;
	if (ref.match?.name) return `match("${ref.match.name}")`;
	return "unknown target";
}

/**
 * Capture a double-click event.
 */
export async function traceDblClick(
	page: Page,
	trace: InteractionTrace,
	ref: StepRef,
): Promise<void> {
	const seg = currentSegment(trace);
	const r = await resolveStep(page, ref, "dblclick");
	if (!r) throw new Error(`no visible element for ${describeRef(ref)}`);
	await r.locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
	await r.locator.dblclick({ timeout: ACTION_TIMEOUT_MS });
	const tMs = perfNowToEventTms(performance.now(), seg);
	const info = await captureElementInfoFromLocator(page, r.locator);
	if (!info) return;

	const ctx = await capturePageContext(page);
	trace.events.push({
		tMs,
		segmentId: seg.id,
		action: "dblclick",
		bbox: info.bbox,
		visibleBbox: info.visibleBbox,
		containerBbox: info.containerBbox,
		selector: r.resolved,
		requestedSelector: r.requested,
		resolvedSelector: r.healed ? r.resolved : undefined,
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
	ref: StepRef,
	value: string,
): Promise<void> {
	const seg = currentSegment(trace);
	const r = await resolveStep(page, ref, "fill");
	if (!r) throw new Error(`no visible element for ${describeRef(ref)}`);
	await r.locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
	await r.locator.fill(value, { timeout: ACTION_TIMEOUT_MS });
	const tMs = perfNowToEventTms(performance.now(), seg);
	const info = await captureElementInfoFromLocator(page, r.locator);
	if (!info) return;

	// Never persist a typed password to the on-disk trace. Detect by the live
	// element type and the requested descriptor.
	const isPassword =
		/password/i.test(r.requested) ||
		(await r.locator.getAttribute("type").catch(() => null)) === "password";
	const recordedText = isPassword ? "•".repeat(Math.min(value.length, 8)) : value;

	const ctx = await capturePageContext(page);
	trace.events.push({
		tMs,
		segmentId: seg.id,
		action: "fill",
		bbox: info.bbox,
		visibleBbox: info.visibleBbox,
		containerBbox: info.containerBbox,
		selector: r.resolved,
		requestedSelector: r.requested,
		resolvedSelector: r.healed ? r.resolved : undefined,
		role: info.role,
		computedCursor: info.computedCursor,
		text: recordedText,
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
	ref: StepRef,
): Promise<void> {
	const seg = currentSegment(trace);
	const r = await resolveStep(page, ref, "hover");
	if (!r) throw new Error(`no visible element for ${describeRef(ref)}`);
	await r.locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
	await r.locator.hover({ timeout: ACTION_TIMEOUT_MS });
	const tMs = perfNowToEventTms(performance.now(), seg);
	const info = await captureElementInfoFromLocator(page, r.locator);
	if (!info) return;

	const ctx = await capturePageContext(page);
	trace.events.push({
		tMs,
		segmentId: seg.id,
		action: "hover",
		bbox: info.bbox,
		visibleBbox: info.visibleBbox,
		containerBbox: info.containerBbox,
		selector: r.resolved,
		requestedSelector: r.requested,
		resolvedSelector: r.healed ? r.resolved : undefined,
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
