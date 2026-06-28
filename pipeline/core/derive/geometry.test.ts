import { describe, expect, it } from "vitest";
import type { AffineTransform, Bbox } from "../schema/interactionTrace.js";
import {
	applyAffine,
	mapBboxToNorm,
	normRectCenter,
	normRectSize,
	scaleOnlyAffine,
	solveAffine,
	unionNormRects,
} from "./geometry.js";

describe("scaleOnlyAffine", () => {
	it("maps viewport px to normalized 0-1", () => {
		const M = scaleOnlyAffine(1280, 720);
		expect(applyAffine(M, 0, 0)).toEqual({ x: 0, y: 0 });
		expect(applyAffine(M, 1280, 720)).toEqual({ x: 1, y: 1 });
		expect(applyAffine(M, 640, 360)).toEqual({ x: 0.5, y: 0.5 });
	});
});

describe("solveAffine", () => {
	it("recovers a known affine from exact correspondences", () => {
		// Truth: u = 0.001x + 0.05, v = 0.002y + 0.1
		const truth: AffineTransform = { a: 0.001, b: 0, c: 0.05, d: 0, e: 0.002, f: 0.1 };
		const pts = [
			{ x: 100, y: 50 },
			{ x: 900, y: 600 },
			{ x: 400, y: 700 },
			{ x: 1200, y: 200 },
		];
		const correspondences = pts.map((p) => ({ src: p, dst: applyAffine(truth, p.x, p.y) }));
		const { M, residual } = solveAffine(correspondences);
		expect(residual).toBeLessThan(1e-9);
		expect(M.a).toBeCloseTo(truth.a, 9);
		expect(M.c).toBeCloseTo(truth.c, 9);
		expect(M.e).toBeCloseTo(truth.e, 9);
		expect(M.f).toBeCloseTo(truth.f, 9);
	});

	it("reports residual for noisy correspondences", () => {
		const truth: AffineTransform = { a: 1 / 1280, b: 0, c: 0, d: 0, e: 1 / 720, f: 0 };
		const pts = [
			{ x: 0, y: 0 },
			{ x: 1280, y: 0 },
			{ x: 0, y: 720 },
			{ x: 1280, y: 720 },
		];
		const correspondences = pts.map((p, i) => {
			const dst = applyAffine(truth, p.x, p.y);
			return { src: p, dst: { x: dst.x + (i === 0 ? 0.02 : 0), y: dst.y } };
		});
		const { residual } = solveAffine(correspondences);
		expect(residual).toBeGreaterThan(0);
	});

	it("throws on collinear/insufficient input", () => {
		expect(() => solveAffine([{ src: { x: 0, y: 0 }, dst: { x: 0, y: 0 } }])).toThrow();
	});
});

describe("mapBboxToNorm", () => {
	it("maps a bbox center and size into normalized space", () => {
		const M = scaleOnlyAffine(1000, 500);
		const box: Bbox = { x: 200, y: 100, w: 100, h: 50 };
		const rect = mapBboxToNorm(M, box);
		const center = normRectCenter(rect);
		expect(center.cx).toBeCloseTo(0.25, 10);
		expect(center.cy).toBeCloseTo(0.25, 10);
		const size = normRectSize(rect);
		expect(size.w).toBeCloseTo(0.1, 10);
		expect(size.h).toBeCloseTo(0.1, 10);
	});

	it("unions rects", () => {
		const u = unionNormRects([
			{ u0: 0.1, v0: 0.1, u1: 0.2, v1: 0.2 },
			{ u0: 0.15, v0: 0.05, u1: 0.4, v1: 0.3 },
		]);
		expect(u).toEqual({ u0: 0.1, v0: 0.05, u1: 0.4, v1: 0.3 });
	});
});
