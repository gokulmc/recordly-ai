/**
 * Core data types shared between the recordly editor and the auto-demo pipeline.
 * No Electron, Vite, or renderer imports — pure TypeScript.
 *
 * Source of truth for:
 *   src/components/video-editor/types.ts (ZoomRegion, CursorTelemetryPoint, etc.)
 *   electron/ipc/constants.ts (CURSOR_TELEMETRY_VERSION, CURSOR_SAMPLE_INTERVAL_MS)
 */

export type ZoomDepth = 1 | 2 | 3 | 4 | 5 | 6;

export interface ZoomFocus {
	cx: number; // normalized horizontal center (0-1) of the *source* video frame
	cy: number; // normalized vertical center (0-1) of the *source* video frame
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

export const DEFAULT_CURSOR_STYLE: CursorStyle = "tahoe";
export const DEFAULT_CURSOR_CLICK_EFFECT: CursorClickEffectStyle = "none";
export const DEFAULT_CURSOR_CLICK_EFFECT_COLOR = "#2563EB";
export const DEFAULT_CURSOR_CLICK_EFFECT_SCALE = 1;
export const DEFAULT_CURSOR_CLICK_EFFECT_OPACITY = 1;
export const DEFAULT_CURSOR_CLICK_EFFECT_DURATION_MS = 600;
export const DEFAULT_CURSOR_SIZE = 3.0;
export const DEFAULT_CURSOR_SMOOTHING = 0.67;
export const DEFAULT_CURSOR_MOTION_BLUR = 0.4;
export const DEFAULT_CURSOR_CLICK_BOUNCE = 2.5;
export const DEFAULT_CURSOR_CLICK_BOUNCE_DURATION = 350;
export const DEFAULT_CURSOR_SWAY = 0.4;

export const DEFAULT_CURSOR_VISUAL_SETTINGS: CursorVisualSettings = {
	size: DEFAULT_CURSOR_SIZE,
	smoothing: DEFAULT_CURSOR_SMOOTHING,
	motionBlur: DEFAULT_CURSOR_MOTION_BLUR,
	clickBounce: DEFAULT_CURSOR_CLICK_BOUNCE,
	clickBounceDuration: DEFAULT_CURSOR_CLICK_BOUNCE_DURATION,
	clickEffect: DEFAULT_CURSOR_CLICK_EFFECT,
	clickEffectColor: DEFAULT_CURSOR_CLICK_EFFECT_COLOR,
	clickEffectScale: DEFAULT_CURSOR_CLICK_EFFECT_SCALE,
	clickEffectOpacity: DEFAULT_CURSOR_CLICK_EFFECT_OPACITY,
	clickEffectDurationMs: DEFAULT_CURSOR_CLICK_EFFECT_DURATION_MS,
	sway: DEFAULT_CURSOR_SWAY,
	style: DEFAULT_CURSOR_STYLE,
};

export interface CursorTelemetryFile {
	version: number;
	samples: CursorTelemetryPoint[];
}
