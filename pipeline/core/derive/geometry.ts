/**
 * Pure 2D geometry: affine fitting/applying and bbox mapping.
 * No I/O, no recordly imports — trivially unit-testable.
 */

import type { AffineTransform, Bbox } from "../schema/interactionTrace.js";

export interface Point {
	x: number;
	y: number;
}

/** Normalized rectangle in source-frame space (0-1). */
export interface NormRect {
	u0: number;
	v0: number;
	u1: number;
	v1: number;
}

export function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/** Apply M: [u,v] = M·[x,y,1]. */
export function applyAffine(M: AffineTransform, x: number, y: number): Point {
	return {
		x: M.a * x + M.b * y + M.c,
		y: M.d * x + M.e * y + M.f,
	};
}

/**
 * Identity-ish affine for the "frame === viewport" case (Playwright video /
 * CDP screencast): viewport px → normalized source frame is pure scaling.
 */
export function scaleOnlyAffine(viewportW: number, viewportH: number): AffineTransform {
	const w = Math.max(1, viewportW);
	const h = Math.max(1, viewportH);
	return { a: 1 / w, b: 0, c: 0, d: 0, e: 1 / h, f: 0 };
}

export interface AffineFit {
	M: AffineTransform;
	/** RMS residual of the fit, in normalized (0-1) units */
	residual: number;
}

export interface Correspondence {
	/** source point in viewport CSS px */
	src: Point;
	/** target point in normalized source-frame coords (0-1) */
	dst: Point;
}

/**
 * Least-squares affine fit from >=3 non-collinear correspondences.
 * Solves u = a·x+b·y+c and v = d·x+e·y+f independently (shared design matrix).
 */
export function solveAffine(correspondences: Correspondence[]): AffineFit {
	if (correspondences.length < 3) {
		throw new Error(`solveAffine needs >=3 correspondences, got ${correspondences.length}`);
	}

	// Normal equations XᵀX · p = Xᵀ·t, with X rows = [x, y, 1].
	// XᵀX is symmetric 3×3; accumulate it plus the two RHS vectors (for u and v).
	const A = [
		[0, 0, 0],
		[0, 0, 0],
		[0, 0, 0],
	];
	const bu = [0, 0, 0];
	const bv = [0, 0, 0];

	for (const { src, dst } of correspondences) {
		const row = [src.x, src.y, 1];
		for (let i = 0; i < 3; i++) {
			for (let j = 0; j < 3; j++) {
				A[i]![j]! += row[i]! * row[j]!;
			}
			bu[i]! += row[i]! * dst.x;
			bv[i]! += row[i]! * dst.y;
		}
	}

	const [a, b, c] = solve3x3(A, bu);
	const [d, e, f] = solve3x3(A, bv);
	const M: AffineTransform = { a, b, c, d, e, f };

	// RMS residual
	let sumSq = 0;
	for (const { src, dst } of correspondences) {
		const p = applyAffine(M, src.x, src.y);
		sumSq += (p.x - dst.x) ** 2 + (p.y - dst.y) ** 2;
	}
	const residual = Math.sqrt(sumSq / correspondences.length);

	return { M, residual };
}

/** Solve a 3×3 linear system via Gaussian elimination with partial pivoting. */
function solve3x3(A: number[][], b: number[]): [number, number, number] {
	// Augmented copy
	const m = [
		[A[0]![0]!, A[0]![1]!, A[0]![2]!, b[0]!],
		[A[1]![0]!, A[1]![1]!, A[1]![2]!, b[1]!],
		[A[2]![0]!, A[2]![1]!, A[2]![2]!, b[2]!],
	];

	for (let col = 0; col < 3; col++) {
		// Partial pivot
		let pivot = col;
		for (let r = col + 1; r < 3; r++) {
			if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
		}
		if (Math.abs(m[pivot]![col]!) < 1e-12) {
			throw new Error("solveAffine: singular system (collinear correspondences?)");
		}
		[m[col], m[pivot]] = [m[pivot]!, m[col]!];

		// Eliminate
		for (let r = 0; r < 3; r++) {
			if (r === col) continue;
			const factor = m[r]![col]! / m[col]![col]!;
			for (let k = col; k < 4; k++) {
				m[r]![k]! -= factor * m[col]![k]!;
			}
		}
	}

	return [m[0]![3]! / m[0]![0]!, m[1]![3]! / m[1]![1]!, m[2]![3]! / m[2]![2]!];
}

/** Map a viewport-px bbox through M to a normalized source-frame rect (axis-aligned bounds of the 4 mapped corners). */
export function mapBboxToNorm(M: AffineTransform, box: Bbox): NormRect {
	const corners = [
		applyAffine(M, box.x, box.y),
		applyAffine(M, box.x + box.w, box.y),
		applyAffine(M, box.x, box.y + box.h),
		applyAffine(M, box.x + box.w, box.y + box.h),
	];
	const us = corners.map((p) => p.x);
	const vs = corners.map((p) => p.y);
	return { u0: Math.min(...us), v0: Math.min(...vs), u1: Math.max(...us), v1: Math.max(...vs) };
}

export function normRectCenter(r: NormRect): { cx: number; cy: number } {
	return { cx: (r.u0 + r.u1) / 2, cy: (r.v0 + r.v1) / 2 };
}

export function normRectSize(r: NormRect): { w: number; h: number } {
	return { w: Math.max(0, r.u1 - r.u0), h: Math.max(0, r.v1 - r.v0) };
}

/** Union of normalized rects. */
export function unionNormRects(rects: NormRect[]): NormRect {
	if (rects.length === 0) throw new Error("unionNormRects: empty");
	return {
		u0: Math.min(...rects.map((r) => r.u0)),
		v0: Math.min(...rects.map((r) => r.v0)),
		u1: Math.max(...rects.map((r) => r.u1)),
		v1: Math.max(...rects.map((r) => r.v1)),
	};
}

/** Union of viewport-px bboxes. */
export function unionBboxes(boxes: Bbox[]): Bbox {
	if (boxes.length === 0) throw new Error("unionBboxes: empty");
	const x0 = Math.min(...boxes.map((b) => b.x));
	const y0 = Math.min(...boxes.map((b) => b.y));
	const x1 = Math.max(...boxes.map((b) => b.x + b.w));
	const y1 = Math.max(...boxes.map((b) => b.y + b.h));
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
