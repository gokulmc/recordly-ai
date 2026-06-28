/**
 * Sync-beacon helpers: create CalibrationSegments anchored to recording time.
 *
 * For the Playwright-video backend (M≈identity), M is the exact scale-only
 * affine (viewport px → normalized 0-1). A visual beacon is still injected so
 * the dual-track path (M3 native capture) can cross-check frame timing later.
 *
 * Clock model:
 *   - `traceMonotonicMs` = `performance.now()` at the moment the segment begins
 *   - `wallEpochMs`      = `Date.now()` at that same moment
 *   - `videoTimeMs`      = elapsed ms in the video since recording started
 *       Playwright-video: derived from elapsed monotonic time (exact same engine)
 *       Native capture:   derived from beacon detection in the video frames
 *   - Event `tMs`        = `performance.now()` - segment.anchor.traceMonotonicMs
 */

import { performance } from "node:perf_hooks";
import { buildScaleOnlySegment } from "../derive/registration.js";
import type { CalibrationSegment } from "../schema/interactionTrace.js";

export interface BeaconClock {
	/** performance.now() at beacon injection */
	traceMonotonicMs: number;
	/** Date.now() at beacon injection */
	wallEpochMs: number;
	/** Elapsed ms since the *first* beacon (= approximate video time for Playwright-video) */
	videoTimeMs: number;
}

/**
 * Capture a clock anchor right now. Call immediately before (or after) injecting
 * the visual beacon so the two timestamps are tightly coupled.
 */
export function captureBeaconClock(recordingStartMonotonicMs: number): BeaconClock {
	const now = performance.now();
	return {
		traceMonotonicMs: now,
		wallEpochMs: Date.now(),
		videoTimeMs: Math.max(0, now - recordingStartMonotonicMs),
	};
}

/**
 * Build a CalibrationSegment for the Playwright-video backend.
 *
 * M is the scale-only affine that maps viewport CSS px to normalized [0,1].
 * residual = 0 because the mapping is exact (video frame = viewport, no distortion).
 */
export function buildPlaywrightVideoSegment(opts: {
	id: number;
	viewport: { w: number; h: number; dpr: number };
	clock: BeaconClock;
}): CalibrationSegment {
	return buildScaleOnlySegment({
		id: opts.id,
		viewport: opts.viewport,
		anchor: {
			videoTimeMs: opts.clock.videoTimeMs,
			traceMonotonicMs: opts.clock.traceMonotonicMs,
			wallEpochMs: opts.clock.wallEpochMs,
		},
	});
}

/**
 * Convert a raw `performance.now()` timestamp to an event-relative `tMs` using
 * the segment's clock anchor.
 *
 * `tMs` is monotonic from the *segment's* anchor, not the recording start —
 * so a mid-demo navigation producing a new segment resets the clock for events
 * in that segment. The derive layer maps events back to absolute time using
 * `segment.anchor.videoTimeMs + event.tMs`.
 */
export function perfNowToEventTms(perfNow: number, segment: CalibrationSegment): number {
	return Math.max(0, perfNow - segment.anchor.traceMonotonicMs);
}
