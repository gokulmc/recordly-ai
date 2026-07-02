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

export interface AutoZoomGarbageSegment {
  startMs: number;
  endMs: number;
  /** Why this portion should be removed (mistake, error state, loading, wandering…). */
  reason: string;
}

export interface AutoZoomAnalysis {
  appName: string;
  appCategory: string;
  features: AutoZoomFeature[];
  totalDurationMs: number;
  /** Normalized 0-1 rect of the app content, excluding browser chrome. */
  contentRect?: AutoZoomContentRect;
  /** Portions the LLM flagged for removal from the final demo. */
  garbageSegments?: AutoZoomGarbageSegment[];
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
  /** Number of removed dead segments (head + tail + garbage + mid-feature gaps). */
  cutSegments: number;
  /** How many of the cuts came from LLM-flagged garbage portions. */
  garbageSegments: number;
  cropApplied: boolean;
  captions: number;
  features: number;
}

export const IDENTITY_CROP: AutoZoomContentRect = { x: 0, y: 0, width: 1, height: 1 };
