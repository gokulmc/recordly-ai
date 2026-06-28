/**
 * Coordinate registration — the dual-track bridge.
 *
 * Builds the per-segment affine `M` that maps Playwright viewport CSS px →
 * normalized source-frame coords (0-1). Two modes:
 *   - scale-only (Playwright video / CDP screencast, frame === viewport)
 *   - fiducial least-squares fit (recordly native capture: window chrome, DPI,
 *     letterboxing are all absorbed by the affine)
 *
 * `M` targets the RAW SOURCE frame, before recordly crop/padding/export layout —
 * recordly's ZoomRegion.focus is normalized *source* focus.
 */

import type { CalibrationSegment } from "../schema/interactionTrace.js";
import { type Correspondence, scaleOnlyAffine, solveAffine } from "./geometry.js";

/** A detected fiducial: a known viewport position observed at a normalized frame position. */
export interface FiducialObservation {
	/** marker's known position in viewport CSS px */
	viewport: { x: number; y: number };
	/** where it was detected in the source frame, normalized 0-1 */
	frameNorm: { u: number; v: number };
}

/** Residual above this (normalized units) means the calibration is untrustworthy → fail closed. */
export const MAX_TRUSTED_RESIDUAL = 0.01; // ~1% of a frame edge

export interface SegmentClockAnchor {
	videoTimeMs: number;
	traceMonotonicMs: number;
	wallEpochMs: number;
}

/** Build a scale-only segment (MVP / Playwright-video path, M ≈ identity after viewport scaling). */
export function buildScaleOnlySegment(params: {
	id: number;
	viewport: { w: number; h: number; dpr: number };
	anchor: SegmentClockAnchor;
}): CalibrationSegment {
	return {
		id: params.id,
		M: scaleOnlyAffine(params.viewport.w, params.viewport.h),
		residual: 0,
		anchor: params.anchor,
		viewport: params.viewport,
	};
}

/** Build a segment from fiducial observations (recordly native-capture path). */
export function buildFiducialSegment(params: {
	id: number;
	viewport: { w: number; h: number; dpr: number };
	anchor: SegmentClockAnchor;
	fiducials: FiducialObservation[];
}): CalibrationSegment {
	if (params.fiducials.length < 3) {
		throw new Error(
			`buildFiducialSegment: need >=3 fiducials, got ${params.fiducials.length} (plan recommends 8+)`,
		);
	}
	const correspondences: Correspondence[] = params.fiducials.map((f) => ({
		src: { x: f.viewport.x, y: f.viewport.y },
		dst: { x: f.frameNorm.u, y: f.frameNorm.v },
	}));
	const { M, residual } = solveAffine(correspondences);
	return { id: params.id, M, residual, anchor: params.anchor, viewport: params.viewport };
}

/** Fail-closed gate: is this segment's calibration trustworthy enough to emit zooms from? */
export function isSegmentTrusted(
	segment: CalibrationSegment,
	maxResidual = MAX_TRUSTED_RESIDUAL,
): boolean {
	return Number.isFinite(segment.residual) && segment.residual <= maxResidual;
}
