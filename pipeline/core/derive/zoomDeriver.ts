/**
 * zoomDeriver — TraceToZoomRegions.
 *
 * The NEW core (the plan's §4/§5/§9): turn the DOM interaction trace into full
 * recordly `ZoomRegion`s. Unlike recordly's cursor-pixel heuristic, focus and
 * depth come from real element geometry mapped through the calibrated affine M:
 *   - focus  = centroid of the cluster's union *context frame* (containerBbox
 *     preferred, occlusion-clipped visibleBbox next, raw bbox last)
 *   - depth  = inverse of ZOOM_DEPTH_SCALES sized so the context fills a
 *     comfortable fraction of the frame, with hysteresis to avoid flicker
 *
 * Segments whose calibration is untrusted are skipped (fail closed) rather than
 * emitting a wrong-spot zoom.
 */

import {
	type Bbox,
	type CalibrationSegment,
	type InteractionEvent,
	type InteractionTrace,
} from "../schema/interactionTrace.js";
import {
	type CursorVisualType,
	type ZoomDepth,
	type ZoomRegion,
	ZOOM_DEPTH_SCALES,
} from "../schema/recordlyContract.js";
import {
	clamp,
	mapBboxToNorm,
	type NormRect,
	normRectCenter,
	normRectSize,
	unionNormRects,
} from "./geometry.js";
import { isSegmentTrusted } from "./registration.js";

/** Max gap between consecutive emphasized events before they split into separate clusters. */
export const CLICK_CLUSTER_MERGE_GAP_MS = 2500;
/** Padding added before the first and after the last event in a cluster. */
export const CLICK_CLUSTER_PAD_MS = 500;

const EXPLICIT_CLICK_ACTIONS = new Set<InteractionEvent["action"]>([
	"click",
	"dblclick",
	"rightclick",
]);

export interface ZoomDeriverConfig {
	/** target fraction of the shorter frame axis the context should fill (0-1) */
	targetFill: number;
	/** never let the context exceed this fraction of the frame (over-zoom guard) */
	safeMargin: number;
	/** keep the previous depth if the new need is within this band (anti-flicker) */
	hysteresisFrac: number;
	mergeGapMs: number;
	padMs: number;
	/** require a trusted calibration segment (fail closed) */
	requireTrustedSegment: boolean;
}

export const DEFAULT_ZOOM_DERIVER_CONFIG: ZoomDeriverConfig = {
	targetFill: 0.62,
	safeMargin: 0.9,
	hysteresisFrac: 0.15,
	mergeGapMs: CLICK_CLUSTER_MERGE_GAP_MS,
	padMs: CLICK_CLUSTER_PAD_MS,
	requireTrustedSegment: true,
};

/** Per-event editorial input from the LLM saliency pass (M4). M1 uses the default predicate. */
export interface SaliencyHint {
	emphasize: boolean;
	/** shift the geometric depth up/down by this many levels (clamped) */
	depthBias?: number;
	/** extend the hold after the cluster */
	holdMs?: number;
}

export type SaliencyResolver = (event: InteractionEvent, index: number) => SaliencyHint;

/** Default M1 saliency: emphasize every explicit click. */
export const defaultSaliency: SaliencyResolver = (event) => ({
	emphasize: EXPLICIT_CLICK_ACTIONS.has(event.action),
});

const DEPTHS: ZoomDepth[] = [1, 2, 3, 4, 5, 6];

/** Pick the depth whose scale best matches `needScale`, capped so context never exceeds safeMargin. */
export function quantizeDepth(needScale: number, maxCtxNorm: number, safeMargin: number): ZoomDepth {
	// Hard cap: scale where context would exactly fill safeMargin of the frame.
	const scaleCap = maxCtxNorm > 0 ? safeMargin / maxCtxNorm : ZOOM_DEPTH_SCALES[6];
	const target = clamp(needScale, ZOOM_DEPTH_SCALES[1], ZOOM_DEPTH_SCALES[6]);

	let best: ZoomDepth = 1;
	let bestErr = Number.POSITIVE_INFINITY;
	for (const d of DEPTHS) {
		const scale = ZOOM_DEPTH_SCALES[d];
		if (scale > scaleCap + 1e-9) continue; // would over-zoom past the safe margin
		const err = Math.abs(scale - target);
		if (err < bestErr) {
			bestErr = err;
			best = d;
		}
	}
	return best;
}

interface Cluster {
	firstMs: number;
	lastMs: number;
	contextRects: NormRect[];
	/** strongest per-event depth bias in the cluster (largest magnitude wins) */
	depthBias: number;
	/** longest requested hold in the cluster */
	holdMs: number;
}

/** Best available framing bbox for an event: container > visible > raw. */
function contextBbox(event: InteractionEvent): Bbox {
	return event.containerBbox ?? event.visibleBbox ?? event.bbox;
}

function segmentById(segments: CalibrationSegment[], id: number): CalibrationSegment | undefined {
	return segments.find((s) => s.id === id);
}

/**
 * Derive zoom regions from a trace.
 * Returns regions sorted chronologically, each `mode: "auto"`.
 */
export function deriveZoomRegions(
	trace: InteractionTrace,
	options?: {
		config?: Partial<ZoomDeriverConfig>;
		saliency?: SaliencyResolver;
	},
): { regions: ZoomRegion[]; skipped: number } {
	const config = { ...DEFAULT_ZOOM_DERIVER_CONFIG, ...options?.config };
	const saliency = options?.saliency ?? defaultSaliency;

	// 1. Select + map emphasized events to normalized context rects (skip untrusted segments).
	let skipped = 0;
	const points: Array<{ tMs: number; rect: NormRect; hint: SaliencyHint }> = [];
	trace.events.forEach((event, index) => {
		const hint = saliency(event, index);
		if (!hint.emphasize) return;
		const segment = segmentById(trace.segments, event.segmentId);
		if (!segment) {
			skipped++;
			return;
		}
		if (config.requireTrustedSegment && !isSegmentTrusted(segment)) {
			skipped++;
			return;
		}
		points.push({ tMs: event.tMs, rect: mapBboxToNorm(segment.M, contextBbox(event)), hint });
	});

	if (points.length === 0) return { regions: [], skipped };

	// 2. Cluster by time gap.
	points.sort((a, b) => a.tMs - b.tMs);
	const clusters: Cluster[] = [];
	let current: Cluster | null = null;
	const absMax = (a: number, b: number) => (Math.abs(b) > Math.abs(a) ? b : a);
	for (const p of points) {
		const bias = p.hint.depthBias ?? 0;
		const hold = p.hint.holdMs ?? 0;
		if (current && p.tMs - current.lastMs <= config.mergeGapMs) {
			current.lastMs = p.tMs;
			current.contextRects.push(p.rect);
			current.depthBias = absMax(current.depthBias, bias);
			current.holdMs = Math.max(current.holdMs, hold);
		} else {
			current = {
				firstMs: p.tMs,
				lastMs: p.tMs,
				contextRects: [p.rect],
				depthBias: bias,
				holdMs: hold,
			};
			clusters.push(current);
		}
	}

	// 3. Geometry → focus + depth, with cross-cluster hysteresis.
	const regions: ZoomRegion[] = [];
	let lastDepth: ZoomDepth | null = null;
	clusters.forEach((cluster, i) => {
		const union = unionNormRects(cluster.contextRects);
		const center = normRectCenter(union);
		const size = normRectSize(union);
		const maxCtx = Math.max(size.w, size.h, 1e-4);
		const needScale = clamp(config.targetFill / maxCtx, ZOOM_DEPTH_SCALES[1], ZOOM_DEPTH_SCALES[6]);

		let depth = quantizeDepth(needScale, maxCtx, config.safeMargin);

		// Hysteresis: avoid 1-level flicker between adjacent clusters.
		if (lastDepth !== null && Math.abs(depth - lastDepth) === 1) {
			const lastScale = ZOOM_DEPTH_SCALES[lastDepth];
			if (Math.abs(needScale - lastScale) / lastScale <= config.hysteresisFrac) {
				depth = lastDepth;
			}
		}

		// Per-event LLM depth bias (M4) — strongest bias in the cluster.
		depth = clamp(Math.round(depth + cluster.depthBias), 1, 6) as ZoomDepth;
		lastDepth = depth;

		const startMs = Math.max(0, cluster.firstMs - config.padMs);
		const endMs = Math.min(trace.totalMs, cluster.lastMs + config.padMs + cluster.holdMs);
		if (endMs <= startMs) return;

		regions.push({
			id: `auto-zoom-${i}-${Math.round(startMs)}`,
			startMs,
			endMs,
			depth,
			focus: { cx: clamp(center.cx, 0, 1), cy: clamp(center.cy, 0, 1) },
			mode: "auto",
		});
	});

	return { regions, skipped };
}

/** Map a raw CSS `cursor` value / ARIA role to recordly's cursor enum (shared with cursorDeriver). */
export function mapComputedCursor(
	computedCursor: string | undefined,
	role: string | undefined,
): CursorVisualType {
	const c = (computedCursor ?? "").trim().toLowerCase();
	switch (c) {
		case "pointer":
			return "pointer";
		case "text":
		case "vertical-text":
			return "text";
		case "grab":
			return "open-hand";
		case "grabbing":
			return "closed-hand";
		case "crosshair":
			return "crosshair";
		case "not-allowed":
		case "no-drop":
			return "not-allowed";
		case "ew-resize":
		case "col-resize":
		case "e-resize":
		case "w-resize":
			return "resize-ew";
		case "ns-resize":
		case "row-resize":
		case "n-resize":
		case "s-resize":
			return "resize-ns";
	}
	// Fall back to role hints when cursor is default/auto.
	const r = (role ?? "").toLowerCase();
	if (r === "button" || r === "link" || r === "tab" || r === "menuitem") return "pointer";
	if (r === "textbox" || r === "searchbox") return "text";
	return "arrow";
}
