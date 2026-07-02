import { useState, useCallback } from "react";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface AutoZoomNarrationLine {
  text: string;
  timeMs: number;
}

export interface AutoZoomFeature {
  name: string;
  description: string;
  startMs: number;
  endMs: number;
  interactions: Array<{ label: string; timeMs: number }>;
  narration: string;
  narrationLines?: AutoZoomNarrationLine[];
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
  reason: string;
}

export interface AutoZoomAnalysis {
  appName: string;
  appCategory: string;
  features: AutoZoomFeature[];
  totalDurationMs: number;
  contentRect?: AutoZoomContentRect;
  garbageSegments?: AutoZoomGarbageSegment[];
}

export interface AutoZoomProgress {
  stage: string;
  status: "running" | "done" | "error";
  message: string;
  payload?: unknown;
}

/** Before/after comparison shown on Step 3 once generation finishes. */
export interface AutoZoomSummary {
  appName: string;
  autoZoomRegions: number;
  vanillaRegions: number;
  deepZooms: number;
  trimmedMs: number;
  cutSegments: number;
  garbageSegments: number;
  cropApplied: boolean;
  captions: number;
  features: number;
}

export type AutoZoomStep = 1 | 2 | 3;

export interface AutoZoomState {
  step: AutoZoomStep;
  isRecording: boolean;
  videoPath: string;
  cursorPath: string;
  analysis: AutoZoomAnalysis | null;
  progresses: AutoZoomProgress[];
  enableCaptions: boolean;
  enableAudio: boolean;
  enableAutoCrop: boolean;
  enableMusic: boolean;
  projectPath: string | null;
  summary: AutoZoomSummary | null;
  error: string | null;
}

// ── Store ──────────────────────────────────────────────────────────────────────

export function useAutoZoomStore() {
  const [step, setStep] = useState<AutoZoomStep>(1);
  const [isRecording, setIsRecording] = useState(false);
  const [videoPath, setVideoPath] = useState("");
  const [cursorPath, setCursorPath] = useState("");
  const [analysis, setAnalysis] = useState<AutoZoomAnalysis | null>(null);
  const [progresses, setProgresses] = useState<AutoZoomProgress[]>([]);
  const [enableCaptions, setEnableCaptions] = useState(true);
  const [enableAudio, setEnableAudio] = useState(true);
  const [enableAutoCrop, setEnableAutoCrop] = useState(true);
  const [enableMusic, setEnableMusic] = useState(true);
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [summary, setSummary] = useState<AutoZoomSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pushProgress = useCallback((p: AutoZoomProgress) => {
    setProgresses((prev) => {
      const existing = prev.findIndex((x) => x.stage === p.stage);
      if (existing >= 0) {
        const next = [...prev];
        next[existing] = p;
        return next;
      }
      return [...prev, p];
    });
    if (p.payload && (p.payload as Record<string, unknown>).appName) {
      setAnalysis(p.payload as AutoZoomAnalysis);
    }
    if (p.stage === "assemble" && p.status === "done") {
      const pl = p.payload as { projectPath?: string; summary?: AutoZoomSummary } | undefined;
      if (pl?.projectPath) setProjectPath(pl.projectPath);
      if (pl?.summary) setSummary(pl.summary);
    }
    if (p.status === "error") setError(p.message);
  }, []);

  const reset = useCallback(() => {
    setStep(1);
    setIsRecording(false);
    setVideoPath("");
    setCursorPath("");
    setAnalysis(null);
    setProgresses([]);
    setEnableCaptions(true);
    setEnableAudio(true);
    setEnableAutoCrop(true);
    setEnableMusic(true);
    setProjectPath(null);
    setSummary(null);
    setError(null);
  }, []);

  return {
    step, setStep,
    isRecording, setIsRecording,
    videoPath, setVideoPath,
    cursorPath, setCursorPath,
    analysis, setAnalysis,
    progresses, pushProgress,
    enableCaptions, setEnableCaptions,
    enableAudio, setEnableAudio,
    enableAutoCrop, setEnableAutoCrop,
    enableMusic, setEnableMusic,
    projectPath,
    summary,
    error, setError,
    reset,
  };
}
