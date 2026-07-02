/**
 * Derives zoom regions from real cursor telemetry (click positions) instead of
 * guessing a fixed focus point. Falls back to a centered heuristic when no
 * telemetry is available.
 *
 * Reuses the editor's own click-clustering logic (`buildInteractionZoomSuggestions`)
 * so Auto Zoom and the manual "suggest zooms" feature behave consistently.
 */

import fsp from "node:fs/promises";
import { buildInteractionZoomSuggestions } from "../../../src/components/video-editor/timeline/zoomSuggestionUtils";
import type { CursorTelemetryPoint, ZoomFocus } from "../../../src/components/video-editor/types";
import { IDENTITY_CROP } from "./types";
import type { AutoZoomAnalysis, AutoZoomContentRect, EditorZoomRegion } from "./types";

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** Zoom focus is relative to the CROPPED frame, so remap full-frame cursor coords into crop space. */
function remapFocusToCrop(focus: ZoomFocus, crop: AutoZoomContentRect): ZoomFocus {
  if (crop.width <= 0 || crop.height <= 0) return focus;
  return {
    cx: clamp01((focus.cx - crop.x) / crop.width),
    cy: clamp01((focus.cy - crop.y) / crop.height),
  };
}

function depthForImportance(importance: "low" | "medium" | "high" | undefined): number {
  if (importance === "high") return 3;
  if (importance === "low") return 1;
  return 2;
}

function findNearestSample(
  samples: CursorTelemetryPoint[],
  timeMs: number,
  maxDeltaMs: number,
): CursorTelemetryPoint | null {
  if (!samples.length) return null;
  let lo = 0;
  let hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].timeMs < timeMs) lo = mid + 1;
    else hi = mid;
  }
  const candidates = [samples[lo]];
  if (lo > 0) candidates.push(samples[lo - 1]);
  let best: CursorTelemetryPoint | null = null;
  let bestDelta = Infinity;
  for (const c of candidates) {
    const delta = Math.abs(c.timeMs - timeMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = c;
    }
  }
  return best && bestDelta <= maxDeltaMs ? best : null;
}

/** Fallback used when no cursor telemetry is available: centers each LLM interaction. */
function centeredFallbackRegions(analysis: AutoZoomAnalysis, crop: AutoZoomContentRect): EditorZoomRegion[] {
  const regions: EditorZoomRegion[] = [];
  let idx = 0;
  for (const feature of analysis.features) {
    const ints = feature.interactions;
    if (!ints.length) continue;
    const depth = ints.length <= 2 ? 3 : ints.length <= 4 ? 2 : 1;
    for (const int of ints) {
      regions.push({
        id: `az-${idx++}`,
        startMs: Math.max(0, int.timeMs - 400),
        endMs: int.timeMs + 1800,
        depth,
        focus: remapFocusToCrop({ cx: 0.5, cy: 0.4 }, crop),
        mode: "auto",
      });
    }
  }
  return regions;
}

interface CandidateRegion {
  startMs: number;
  endMs: number;
  focus: ZoomFocus;
  depth: number;
  synthetic: boolean;
}

export async function deriveZoomRegionsFromCursor(opts: {
  cursorPath: string;
  analysis: AutoZoomAnalysis;
  crop?: AutoZoomContentRect;
  totalDurationMs: number;
}): Promise<{ regions: EditorZoomRegion[]; source: "cursor" | "fallback"; vanillaCount: number }> {
  const crop = opts.crop ?? IDENTITY_CROP;

  let samples: CursorTelemetryPoint[] = [];
  try {
    const raw = await fsp.readFile(opts.cursorPath, "utf-8");
    const parsed = JSON.parse(raw) as { samples?: CursorTelemetryPoint[] };
    samples = Array.isArray(parsed.samples) ? parsed.samples : [];
  } catch {
    samples = [];
  }

  if (!samples.length) {
    return { regions: centeredFallbackRegions(opts.analysis, crop), source: "fallback", vanillaCount: 0 };
  }

  const clickResult = buildInteractionZoomSuggestions({
    cursorTelemetry: samples,
    totalMs: opts.totalDurationMs,
    defaultDurationMs: 2200,
  });
  // The plain click-cluster count is what default Recordly's own "suggest zooms" would
  // propose from this same telemetry — used for the before/after comparison in Step 3.
  const vanillaCount = clickResult.status === "ok" ? clickResult.suggestions.length : 0;

  if (clickResult.status !== "ok" || !clickResult.suggestions.length) {
    return { regions: centeredFallbackRegions(opts.analysis, crop), source: "fallback", vanillaCount };
  }

  const candidates: CandidateRegion[] = [];

  // Click-cluster regions — depth taken from whichever LLM feature contains the midpoint.
  for (const suggestion of clickResult.suggestions) {
    const midpoint = (suggestion.start + suggestion.end) / 2;
    const feature = opts.analysis.features.find((f) => midpoint >= f.startMs && midpoint <= f.endMs);
    candidates.push({
      startMs: suggestion.start,
      endMs: suggestion.end,
      focus: suggestion.focus,
      depth: depthForImportance(feature?.importance),
      synthetic: false,
    });
  }

  // Dwell regions for LLM interactions with no nearby click cluster — fall back to the
  // cursor position at that timestamp instead of a hardcoded center.
  for (const feature of opts.analysis.features) {
    for (const interaction of feature.interactions) {
      const hasNearbyCluster = candidates.some(
        (r) => !r.synthetic && Math.abs(interaction.timeMs - (r.startMs + r.endMs) / 2) <= 1500,
      );
      if (hasNearbyCluster) continue;
      const nearest = findNearestSample(samples, interaction.timeMs, 1000);
      if (!nearest) continue;
      candidates.push({
        startMs: Math.max(0, interaction.timeMs - 400),
        endMs: interaction.timeMs + 1800,
        focus: { cx: nearest.cx, cy: nearest.cy },
        depth: depthForImportance(feature.importance),
        synthetic: true,
      });
    }
  }

  candidates.sort((a, b) => a.startMs - b.startMs);

  // Resolve overlaps — a real click-cluster region always wins over a synthetic dwell region.
  const resolved: CandidateRegion[] = [];
  for (const region of candidates) {
    const overlapIdx = resolved.findIndex((r) => region.startMs < r.endMs && region.endMs > r.startMs);
    if (overlapIdx === -1) {
      resolved.push(region);
      continue;
    }
    if (!region.synthetic && resolved[overlapIdx].synthetic) {
      resolved[overlapIdx] = region;
    }
  }
  resolved.sort((a, b) => a.startMs - b.startMs);

  const regions: EditorZoomRegion[] = resolved.map((r, idx) => ({
    id: `az-${idx}`,
    startMs: Math.max(0, r.startMs),
    endMs: Math.min(opts.totalDurationMs, r.endMs),
    depth: r.depth,
    focus: remapFocusToCrop(r.focus, crop),
    mode: "auto",
  }));

  return { regions, source: "cursor", vanillaCount };
}
