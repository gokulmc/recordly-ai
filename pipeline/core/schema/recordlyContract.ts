/**
 * Minimal mirror of the recordly data contracts this pipeline must emit.
 *
 * ⚠️ TEMPORARY: per the plan, M2 extracts a *compiled* internal package
 * `packages/recordly-project-format/` that both the recordly renderer and this
 * pipeline consume. Until that exists, we mirror only the small, stable subset
 * of types we need here — kept byte-compatible with:
 *   - src/components/video-editor/types.ts (ZoomRegion, CursorTelemetryPoint, CursorVisualSettings, ZOOM_DEPTH_SCALES)
 *   - electron/ipc/cursor/telemetry.ts (cursor sidecar shape, CURSOR_TELEMETRY_VERSION)
 *
 * Do NOT add behaviour here beyond plain data + constants. When the compiled
 * seam lands, delete this file and re-point imports.
 */

export type ZoomDepth = 1 | 2 | 3 | 4 | 5 | 6;

export interface ZoomFocus {
	/** normalized horizontal center (0-1) of the *source* video frame */
	cx: number;
	/** normalized vertical center (0-1) of the *source* video frame */
	cy: number;
}

export type ZoomMode = "auto" | "manual";

export interface ZoomRegion {
	id: string;
	startMs: number;
	endMs: number;
	depth: ZoomDepth;
	focus: ZoomFocus;
	mode?: ZoomMode;
}

export type CursorInteractionType =
	| "move"
	| "click"
	| "double-click"
	| "right-click"
	| "middle-click"
	| "mouseup";

export type CursorVisualType =
	| "arrow"
	| "text"
	| "pointer"
	| "crosshair"
	| "open-hand"
	| "closed-hand"
	| "resize-ew"
	| "resize-ns"
	| "not-allowed";

export interface CursorTelemetryPoint {
	timeMs: number;
	cx: number;
	cy: number;
	pressure?: number;
	interactionType?: CursorInteractionType;
	cursorType?: CursorVisualType;
}

export type CursorStyle = "macos" | "tahoe" | "tahoe-inverted" | "dot" | "figma" | (string & {});
export type CursorClickEffectStyle = "none" | "spotlight" | "ripple" | "echo";

export interface CursorVisualSettings {
	size: number;
	smoothing: number;
	motionBlur: number;
	clickBounce: number;
	clickBounceDuration: number;
	clickEffect: CursorClickEffectStyle;
	clickEffectColor: string;
	clickEffectScale: number;
	clickEffectOpacity: number;
	clickEffectDurationMs: number;
	sway: number;
	style: CursorStyle;
}

/** Mirror of types.ts ZOOM_DEPTH_SCALES — depth → camera scale factor. */
export const ZOOM_DEPTH_SCALES: Record<ZoomDepth, number> = {
	1: 1.25,
	2: 1.5,
	3: 1.8,
	4: 2.2,
	5: 3.5,
	6: 5.0,
};

export const CURSOR_TELEMETRY_VERSION = 2;
export const CURSOR_SAMPLE_INTERVAL_MS = 33; // ~30Hz, matches recordly's capture cadence

/** The on-disk shape of `${video}.cursor.json`. */
export interface CursorTelemetryFile {
	version: number;
	samples: CursorTelemetryPoint[];
}

/** Sensible default cursor styling (used until the LLM "taste" pass in M4). */
export const DEFAULT_CURSOR_VISUAL_SETTINGS: CursorVisualSettings = {
	size: 1,
	smoothing: 0.6,
	motionBlur: 0.3,
	clickBounce: 0.4,
	clickBounceDuration: 300,
	clickEffect: "none",
	clickEffectColor: "#2563EB",
	clickEffectScale: 1,
	clickEffectOpacity: 1,
	clickEffectDurationMs: 600,
	sway: 0.2,
	style: "tahoe",
};
