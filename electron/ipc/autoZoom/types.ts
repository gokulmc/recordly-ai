/** Shared types for the Auto Zoom feature (main process). */

export interface AutoZoomFeature {
  name: string;
  description: string;
  startMs: number;
  endMs: number;
  interactions: Array<{ label: string; timeMs: number }>;
  narration: string;
  importance?: "low" | "medium" | "high";
}

export interface AutoZoomContentRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AutoZoomAnalysis {
  appName: string;
  appCategory: string;
  features: AutoZoomFeature[];
  totalDurationMs: number;
  /** Normalized 0-1 rect of the app content, excluding browser chrome. */
  contentRect?: AutoZoomContentRect;
}

export interface AutoZoomProgress {
  stage: string;
  status: "running" | "done" | "error";
  message: string;
  payload?: unknown;
}

export interface EditorZoomRegion {
  id: string;
  startMs: number;
  endMs: number;
  depth: number;
  focus: { cx: number; cy: number };
  mode: "auto";
}

/** What Step 3 shows as the before/after comparison card once generation finishes. */
export interface AutoZoomSummary {
  appName: string;
  autoZoomRegions: number;
  vanillaRegions: number;
  deepZooms: number;
  trimmedMs: number;
  cropApplied: boolean;
  captions: number;
  features: number;
}

export const IDENTITY_CROP: AutoZoomContentRect = { x: 0, y: 0, width: 1, height: 1 };
