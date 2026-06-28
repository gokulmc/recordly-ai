/**
 * cursorDeriver — trace → recordly cursor telemetry sidecar.
 *
 * Playwright actions are sparse; recordly expects a dense (~30Hz) stream. We
 * synthesize one by easing the cursor between action waypoints (no teleports),
 * tagging clicks with their interactionType, and resolving each sample's
 * cursorType from DOM facts (computedCursor/role) — replacing recordly's
 * trajectory-guessing with the truth.
 *
 * Output is the exact `${video}.cursor.json` shape ({version:2, samples}).
 */

import type {
	CalibrationSegment,
	InteractionEvent,
	InteractionTrace,
} from "../schema/interactionTrace.js";
import {
	CURSOR_SAMPLE_INTERVAL_MS,
	CURSOR_TELEMETRY_VERSION,
	type CursorInteractionType,
	type CursorTelemetryFile,
	type CursorTelemetryPoint,
	type CursorVisualSettings,
	type CursorVisualType,
	DEFAULT_CURSOR_VISUAL_SETTINGS,
} from "../schema/recordlyContract.js";
import { applyAffine, clamp } from "./geometry.js";
import { mapComputedCursor } from "./zoomDeriver.js";

/** ms before reaching a control during which the cursor adopts that control's shape. */
const ARRIVE_MS = 160;
/** ms after an interaction during which the cursor keeps the control's shape (dwell). */
const DWELL_MS = 280;
/** safety cap on emitted samples (~1h @ 30Hz). */
const MAX_SAMPLES = 60 * 60 * 30;

interface Anchor {
	tMs: number;
	cx: number;
	cy: number;
	cursorType: CursorVisualType;
	interactionType?: CursorInteractionType;
}

function segmentById(segments: CalibrationSegment[], id: number): CalibrationSegment | undefined {
	return segments.find((s) => s.id === id);
}

/** The interaction point (not the framing container): center of visible/raw bbox. */
function interactionCenterNorm(
	event: InteractionEvent,
	segment: CalibrationSegment,
): { cx: number; cy: number } {
	const box = event.visibleBbox ?? event.bbox;
	const p = applyAffine(segment.M, box.x + box.w / 2, box.y + box.h / 2);
	return { cx: clamp(p.x, 0, 1), cy: clamp(p.y, 0, 1) };
}

function actionToInteraction(
	action: InteractionEvent["action"],
): CursorInteractionType | undefined {
	switch (action) {
		case "click":
		case "mousedown":
			return "click";
		case "dblclick":
			return "double-click";
		case "rightclick":
			return "right-click";
		case "mouseup":
			return "mouseup";
		default:
			return undefined; // hover/fill/type/scroll/navigate/keypress → movement only
	}
}

function easeInOutCubic(t: number): number {
	return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

export interface CursorDeriverResult {
	samples: CursorTelemetryPoint[];
	cursorVisual: CursorVisualSettings;
	file: CursorTelemetryFile;
}

export function deriveCursorTelemetry(
	trace: InteractionTrace,
	options?: {
		intervalMs?: number;
		cursorVisual?: CursorVisualSettings;
	},
): CursorDeriverResult {
	const interval = Math.max(8, options?.intervalMs ?? CURSOR_SAMPLE_INTERVAL_MS);
	const cursorVisual = options?.cursorVisual ?? DEFAULT_CURSOR_VISUAL_SETTINGS;
	const totalMs = Math.max(0, trace.totalMs);

	// Build ordered anchors from events that resolve to a calibration segment.
	const anchors: Anchor[] = [];
	for (const event of trace.events) {
		const segment = segmentById(trace.segments, event.segmentId);
		if (!segment) continue;
		const { cx, cy } = interactionCenterNorm(event, segment);
		anchors.push({
			tMs: clamp(event.tMs, 0, totalMs),
			cx,
			cy,
			cursorType: mapComputedCursor(event.computedCursor, event.role),
			interactionType: actionToInteraction(event.action),
		});
	}
	anchors.sort((a, b) => a.tMs - b.tMs);

	const samples: CursorTelemetryPoint[] = [];
	const push = (
		timeMs: number,
		cx: number,
		cy: number,
		interactionType: CursorInteractionType,
		cursorType: CursorVisualType,
	) => {
		if (samples.length >= MAX_SAMPLES) return;
		samples.push({ timeMs: clamp(timeMs, 0, totalMs), cx, cy, interactionType, cursorType });
	};

	if (anchors.length === 0) {
		for (let t = 0; t <= totalMs; t += interval) push(t, 0.5, 0.5, "move", "arrow");
		return { samples, cursorVisual, file: telemetryFile(samples) };
	}

	const first = anchors[0]!;
	// Leading hold at the first anchor's position.
	for (let t = 0; t < first.tMs; t += interval) push(t, first.cx, first.cy, "move", "arrow");
	pushAnchor(push, first);

	// Travel between consecutive anchors.
	for (let i = 1; i < anchors.length; i++) {
		const a = anchors[i - 1]!;
		const b = anchors[i]!;
		const span = Math.max(1, b.tMs - a.tMs);
		for (let t = a.tMs + interval; t < b.tMs; t += interval) {
			const frac = easeInOutCubic(clamp((t - a.tMs) / span, 0, 1));
			const cx = a.cx + (b.cx - a.cx) * frac;
			const cy = a.cy + (b.cy - a.cy) * frac;
			let cursorType: CursorVisualType = "arrow";
			if (b.tMs - t <= ARRIVE_MS) cursorType = b.cursorType;
			else if (t - a.tMs <= DWELL_MS) cursorType = a.cursorType;
			push(t, cx, cy, "move", cursorType);
		}
		pushAnchor(push, b);
	}

	// Trailing hold after the last anchor.
	const last = anchors[anchors.length - 1]!;
	for (let t = last.tMs + interval; t <= totalMs; t += interval) {
		const cursorType = t - last.tMs <= DWELL_MS ? last.cursorType : "arrow";
		push(t, last.cx, last.cy, "move", cursorType);
	}

	samples.sort((p, q) => p.timeMs - q.timeMs);
	return { samples, cursorVisual, file: telemetryFile(samples) };
}

function pushAnchor(
	push: (
		t: number,
		cx: number,
		cy: number,
		it: CursorInteractionType,
		ct: CursorVisualType,
	) => void,
	a: Anchor,
): void {
	push(a.tMs, a.cx, a.cy, a.interactionType ?? "move", a.cursorType);
}

function telemetryFile(samples: CursorTelemetryPoint[]): CursorTelemetryFile {
	return { version: CURSOR_TELEMETRY_VERSION, samples };
}
