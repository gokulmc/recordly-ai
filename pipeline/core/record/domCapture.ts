/**
 * DOM capture helpers — run INSIDE the browser via page.evaluate().
 *
 * All functions that call page.evaluate() pass a serializable callback: no
 * closures over non-JSON-serializable values. TypeScript annotations are erased
 * at runtime so the functions are valid browser JS.
 *
 * These are the "DOM truth" that the OS recorder never sees, and form the
 * factual basis for zoom-focus, zoom-depth, and cursor-type derivation.
 */

import type { Page } from "playwright";
import type { Bbox, InteractionEvent } from "../schema/interactionTrace.js";

export interface DomElementInfo {
	bbox: Bbox;
	visibleBbox?: Bbox;
	containerBbox?: Bbox;
	computedCursor: string;
	role?: string;
	accessibleName?: string;
	text?: string;
	occluded: boolean;
	scroll: { x: number; y: number };
	viewport: { w: number; h: number; dpr: number };
}

/**
 * Capture element info AFTER an action completes + 2× rAF (layout stable).
 * Returns null if the selector doesn't match any element.
 */
export async function captureElementInfo(
	page: Page,
	selector: string,
): Promise<DomElementInfo | null> {
	// Wait for 2 animation frames so layout is stable post-action
	await page.evaluate(() =>
		new Promise<void>((resolve) =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
		),
	);

	return page.evaluate((sel: string) => {
		const el = document.querySelector(sel);
		if (!el) return null;

		const rect = el.getBoundingClientRect();
		const bbox = { x: rect.x, y: rect.y, w: rect.width, h: rect.height };

		// Cursor type from computed styles
		const computedCursor = getComputedStyle(el).cursor || "auto";

		// ARIA role — prefer explicit attribute, fall back to tag
		const role =
			el.getAttribute("role") ||
			(el instanceof HTMLElement ? el.tagName.toLowerCase() : undefined);

		// Accessible name — aria-label first, then aria-labelledby, then text
		const accessibleName =
			el.getAttribute("aria-label") ||
			el.getAttribute("aria-labelledby") ||
			(el instanceof HTMLElement ? el.innerText?.trim().slice(0, 120) : undefined) ||
			undefined;

		const text =
			el instanceof HTMLElement ? el.innerText?.trim().slice(0, 200) : undefined;

		// Smallest semantic ancestor that provides visual context for the action
		const CONTAINER_ROLES = new Set([
			"dialog",
			"form",
			"region",
			"listbox",
			"group",
			"navigation",
			"main",
			"complementary",
			"article",
			"list",
			"menu",
			"tabpanel",
			"treegrid",
		]);
		const CONTAINER_TAGS = new Set([
			"form",
			"dialog",
			"main",
			"nav",
			"aside",
			"section",
			"article",
			"ul",
			"ol",
			"table",
		]);
		let containerBbox: Bbox | undefined;
		let node = el.parentElement;
		while (node && node !== document.body) {
			const nodeRole = node.getAttribute("role") ?? "";
			const tag = node.tagName.toLowerCase();
			if (
				CONTAINER_ROLES.has(nodeRole) ||
				CONTAINER_TAGS.has(tag) ||
				node.className.includes("card") ||
				node.className.includes("modal") ||
				node.className.includes("panel") ||
				node.className.includes("dialog")
			) {
				const cRect = node.getBoundingClientRect();
				if (cRect.width > 0 && cRect.height > 0) {
					containerBbox = { x: cRect.x, y: cRect.y, w: cRect.width, h: cRect.height };
					break;
				}
			}
			node = node.parentElement;
		}

		// Occlusion: is something covering the element's center?
		const cx = rect.x + rect.width / 2;
		const cy = rect.y + rect.height / 2;
		const topEl = document.elementFromPoint(cx, cy);
		const occluded = !!topEl && topEl !== el && !el.contains(topEl);

		// Visible bbox clipped to viewport
		const vpW = window.innerWidth;
		const vpH = window.innerHeight;
		const visX = Math.max(0, rect.x);
		const visY = Math.max(0, rect.y);
		const visX2 = Math.min(vpW, rect.x + rect.width);
		const visY2 = Math.min(vpH, rect.y + rect.height);
		const visibleBbox: Bbox | undefined =
			visX2 > visX && visY2 > visY
				? { x: visX, y: visY, w: visX2 - visX, h: visY2 - visY }
				: undefined;

		const scroll = { x: window.scrollX, y: window.scrollY };
		const dpr = window.devicePixelRatio || 1;
		const viewport = { w: vpW, h: vpH, dpr };

		return {
			bbox,
			visibleBbox,
			containerBbox,
			computedCursor,
			role: role ?? undefined,
			accessibleName: accessibleName ?? undefined,
			text: text ?? undefined,
			occluded,
			scroll,
			viewport,
		};
	}, selector);
}

/**
 * Capture page-level context (scroll, viewport) without targeting a specific
 * element — used for navigate and scroll events.
 */
export async function capturePageContext(
	page: Page,
): Promise<Pick<InteractionEvent, "scroll" | "visualViewport" | "viewport" | "url">> {
	return page.evaluate(() => ({
		scroll: { x: window.scrollX, y: window.scrollY },
		visualViewport: {
			w: window.visualViewport?.width ?? window.innerWidth,
			h: window.visualViewport?.height ?? window.innerHeight,
			offsetLeft: window.visualViewport?.offsetLeft ?? 0,
			offsetTop: window.visualViewport?.offsetTop ?? 0,
		},
		viewport: {
			w: window.innerWidth,
			h: window.innerHeight,
			dpr: window.devicePixelRatio || 1,
		},
		url: window.location.href,
	}));
}

/**
 * Inject a sync beacon — a 2-frame full-viewport white flash detectable in any
 * captured video. Used to anchor the clock at recording start and after each
 * navigation. The flash is invisible to the user but visible to frame detection
 * in the dual-track path (M3 native capture).
 */
export async function injectSyncBeacon(page: Page): Promise<void> {
	await page.evaluate(() => {
		const beacon = document.createElement("div");
		beacon.setAttribute("data-recordly-beacon", "1");
		beacon.style.cssText =
			"position:fixed;inset:0;background:#fff;z-index:2147483647;" +
			"pointer-events:none;opacity:1";
		document.body.appendChild(beacon);
		requestAnimationFrame(() => requestAnimationFrame(() => beacon.remove()));
	});
	// Wait for the 2 frames to complete in the actual page
	await page.evaluate(() =>
		new Promise<void>((resolve) =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
		),
	);
}
