import { describe, expect, it } from "vitest";
import { buildScaleOnlySegment } from "./registration.js";
import { sampleTrace } from "./__fixtures__/sampleTrace.js";
import {
	deriveZoomRegions,
	mapComputedCursor,
	quantizeDepth,
	actionSaliency,
	zoomOptionsForAggressiveness,
} from "./zoomDeriver.js";
import { ZOOM_DEPTH_SCALES } from "../schema/recordlyContract.js";

describe("deriveZoomRegions", () => {
	const { regions, skipped } = deriveZoomRegions(sampleTrace);

	it("emits one region per click-cluster (the non-click fill is ignored)", () => {
		expect(skipped).toBe(0);
		expect(regions).toHaveLength(2);
	});

	it("merges clicks within the gap window into a single region", () => {
		const first = regions[0]!;
		// cluster of clicks at 1000ms and 1500ms, padded by 500ms
		expect(first.startMs).toBe(500);
		expect(first.endMs).toBe(2000);
	});

	it("focuses on the normalized centroid of the context frame", () => {
		const first = regions[0]!;
		// container {500,250,300,200} on a 1280×720 frame → center (650/1280, 350/720)
		expect(first.focus.cx).toBeCloseTo(650 / 1280, 5);
		expect(first.focus.cy).toBeCloseTo(350 / 720, 5);
	});

	it("zooms deeper for a smaller element", () => {
		const [card, icon] = regions;
		expect(icon!.depth).toBeGreaterThan(card!.depth);
	});

	it("marks every region as auto and sorts chronologically", () => {
		expect(regions.every((r) => r.mode === "auto")).toBe(true);
		expect(regions.map((r) => r.startMs)).toEqual([...regions.map((r) => r.startMs)].sort((a, b) => a - b));
		expect(new Set(regions.map((r) => r.id)).size).toBe(regions.length);
	});

	it("fails closed: skips events on an untrusted calibration segment", () => {
		const untrusted = buildScaleOnlySegment({
			id: 0,
			viewport: { w: 1280, h: 720, dpr: 1 },
			anchor: { videoTimeMs: 0, traceMonotonicMs: 0, wallEpochMs: 0 },
		});
		untrusted.residual = 0.5; // way above MAX_TRUSTED_RESIDUAL
		const result = deriveZoomRegions({ ...sampleTrace, segments: [untrusted] });
		expect(result.regions).toHaveLength(0);
		expect(result.skipped).toBeGreaterThan(0);
	});

	it("honors LLM saliency overrides (emphasize + depthBias)", () => {
		const result = deriveZoomRegions(sampleTrace, {
			saliency: (event) => ({
				emphasize: event.action === "fill", // only the text field
				depthBias: 1,
			}),
		});
		expect(result.regions).toHaveLength(1);
	});
});

describe("quantizeDepth", () => {
	it("caps depth so the context never exceeds the safe margin", () => {
		// huge needScale but a large context → capped low
		const depth = quantizeDepth(99, 0.6 /* 60% of frame */, 0.9);
		expect(ZOOM_DEPTH_SCALES[depth] * 0.6).toBeLessThanOrEqual(0.9 + 1e-9);
	});
});

describe("mapComputedCursor", () => {
	it("maps CSS cursor + role to recordly's enum", () => {
		expect(mapComputedCursor("pointer", undefined)).toBe("pointer");
		expect(mapComputedCursor("text", undefined)).toBe("text");
		expect(mapComputedCursor("grab", undefined)).toBe("open-hand");
		expect(mapComputedCursor("grabbing", undefined)).toBe("closed-hand");
		expect(mapComputedCursor("not-allowed", undefined)).toBe("not-allowed");
		expect(mapComputedCursor("ew-resize", undefined)).toBe("resize-ew");
		expect(mapComputedCursor("auto", "button")).toBe("pointer");
		expect(mapComputedCursor("default", "textbox")).toBe("text");
		expect(mapComputedCursor(undefined, undefined)).toBe("arrow");
	});
});

describe("zoomOptionsForAggressiveness", () => {
	it("maps level to a tighter merge gap and wider action set", () => {
		const subtle = zoomOptionsForAggressiveness(1);
		const aggressive = zoomOptionsForAggressiveness(5);
		expect(subtle.config.mergeGapMs).toBe(2500);
		expect(aggressive.config.mergeGapMs).toBe(800);
		// Subtle: clicks only. Aggressive: clicks + fill + type + hover.
		expect(subtle.emphasizeActions.has("fill")).toBe(false);
		expect(aggressive.emphasizeActions.has("fill")).toBe(true);
		expect(aggressive.emphasizeActions.has("hover")).toBe(true);
	});

	it("clamps out-of-range levels", () => {
		expect(zoomOptionsForAggressiveness(0).config.mergeGapMs).toBe(2500);
		expect(zoomOptionsForAggressiveness(99).config.mergeGapMs).toBe(800);
	});

	it("produces more zoom regions at higher aggressiveness", () => {
		// sampleTrace: clicks @1000,1500,6000 + fill @9000.
		const subtle = zoomOptionsForAggressiveness(1);
		const aggressive = zoomOptionsForAggressiveness(5);
		const subtleRegions = deriveZoomRegions(sampleTrace, {
			config: subtle.config,
			saliency: actionSaliency(subtle.emphasizeActions),
		}).regions;
		const aggressiveRegions = deriveZoomRegions(sampleTrace, {
			config: aggressive.config,
			saliency: actionSaliency(aggressive.emphasizeActions),
		}).regions;
		expect(aggressiveRegions.length).toBeGreaterThan(subtleRegions.length);
	});
});
