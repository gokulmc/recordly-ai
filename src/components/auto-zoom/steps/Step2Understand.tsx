import { useEffect, useRef, useState } from "react";
import {
  CheckCircleIcon,
  CircleNotchIcon,
  WarningCircleIcon,
  ClosedCaptioningIcon,
  SpeakerHighIcon,
} from "@phosphor-icons/react";
import type { AutoZoomAnalysis, AutoZoomProgress } from "../useAutoZoomStore";
import { MindMap } from "../MindMap";

interface Props {
  videoPath: string;
  cursorPath: string;
  progresses: AutoZoomProgress[];
  analysis: AutoZoomAnalysis | null;
  enableCaptions: boolean;
  setEnableCaptions: (v: boolean) => void;
  enableAudio: boolean;
  setEnableAudio: (v: boolean) => void;
  onGenerate: () => void;
}

const STAGE_LABELS: Record<string, string> = {
  frames: "Extracting frames",
  understanding: "Understanding app",
};

function StageRow({ progress }: { progress: AutoZoomProgress }) {
  const label = STAGE_LABELS[progress.stage] ?? progress.stage;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      {progress.status === "running" ? (
        <CircleNotchIcon size={14} weight="bold" style={{ color: "var(--launch-accent, #6366f1)", animation: "spin 0.7s linear infinite", flexShrink: 0 }} />
      ) : progress.status === "done" ? (
        <CheckCircleIcon size={14} weight="fill" style={{ color: "#059669", flexShrink: 0 }} />
      ) : (
        <WarningCircleIcon size={14} weight="fill" style={{ color: "#dc2626", flexShrink: 0 }} />
      )}
      <div style={{ display: "flex", flexDirection: "column" }}>
        <span style={{ fontSize: 12, fontWeight: 500, color: "var(--launch-text)" }}>{label}</span>
        <span style={{ fontSize: 11, color: "var(--launch-label)" }}>{progress.message}</span>
      </div>
    </div>
  );
}

function Toggle({ label, checked, onChange, icon }: { label: string; checked: boolean; onChange: (v: boolean) => void; icon: React.ReactNode }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "5px 10px", borderRadius: 7,
        background: checked ? "var(--launch-accent, #6366f1)20" : "var(--launch-surface, rgba(255,255,255,0.04))",
        border: `1.5px solid ${checked ? "var(--launch-accent, #6366f1)60" : "var(--launch-border)"}`,
        color: checked ? "var(--launch-accent, #6366f1)" : "var(--launch-label)",
        fontSize: 12, fontWeight: 500, cursor: "pointer",
      }}
    >
      {icon}
      {label}
    </button>
  );
}

export function Step2Understand({
  videoPath,
  cursorPath,
  progresses,
  analysis,
  enableCaptions,
  setEnableCaptions,
  enableAudio,
  setEnableAudio,
  onGenerate,
}: Props) {
  const [feedback, setFeedback] = useState("");
  const [isRefining, setIsRefining] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Kick off analysis when the component mounts (videoPath is set)
  useEffect(() => {
    if (!videoPath || isAnalyzing) return;
    setIsAnalyzing(true);
    void window.electronAPI?.autoZoomAnalyze?.({ videoPath, cursorPath });
  }, [videoPath]);

  const isDone = analysis !== null;
  const hasError = progresses.some((p) => p.status === "error");

  async function handleFeedback() {
    if (!feedback.trim() || isRefining) return;
    setIsRefining(true);
    await window.electronAPI?.autoZoomRefineAnalysis?.(feedback.trim());
    setFeedback("");
    setIsRefining(false);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Header */}
      <div style={{ padding: "10px 16px 8px", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        <span style={{ fontSize: 15, fontWeight: 600, color: "var(--launch-text)" }}>
          {isDone ? `Understood ${analysis.appName}` : "Understanding your app…"}
        </span>
        <span style={{ marginLeft: "auto", fontSize: 13, color: "var(--launch-label)" }}>Step 2 of 3</span>
      </div>
      <div style={{ height: 1, background: "var(--launch-border)", flexShrink: 0 }} />

      {/* Body */}
      <div ref={bodyRef} style={{ flex: 1, overflowY: "auto", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 14, minHeight: 0 }}>
        {/* Progress stages */}
        {(progresses.length > 0 || !isDone) && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {progresses.map((p) => (
              <StageRow key={p.stage} progress={p} />
            ))}
            {progresses.length === 0 && !isDone && (
              <StageRow progress={{ stage: "frames", status: "running", message: "Starting…" }} />
            )}
          </div>
        )}

        {/* Mindmap */}
        {analysis && (
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--launch-label)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
              Feature map
            </div>
            <MindMap analysis={analysis} />
          </div>
        )}

        {/* Error state */}
        {hasError && (
          <div style={{ fontSize: 12, color: "#ef4444", padding: "8px 12px", borderRadius: 8, background: "#ef444410", border: "1px solid #ef444430" }}>
            Analysis failed. Try again or check your ANTHROPIC_API_KEY.
          </div>
        )}

        {/* Feedback input */}
        {isDone && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--launch-label)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              Corrections (optional)
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleFeedback(); } }}
                placeholder='e.g. "the search tab is for enterprise users only"'
                disabled={isRefining}
                style={{
                  flex: 1, padding: "6px 10px", borderRadius: 8, border: "1px solid var(--launch-border)",
                  background: "var(--launch-surface, rgba(255,255,255,0.05))",
                  color: "var(--launch-text)", fontSize: 12, outline: "none",
                }}
              />
              <button
                onClick={() => void handleFeedback()}
                disabled={!feedback.trim() || isRefining}
                style={{
                  padding: "6px 12px", borderRadius: 8, border: "none",
                  background: "var(--launch-accent, #6366f1)", color: "#fff",
                  fontSize: 12, fontWeight: 600, cursor: feedback.trim() && !isRefining ? "pointer" : "not-allowed",
                  opacity: feedback.trim() && !isRefining ? 1 : 0.5,
                  flexShrink: 0,
                }}
              >
                {isRefining ? "…" : "Update"}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      {isDone && (
        <>
          <div style={{ height: 1, background: "var(--launch-border)", flexShrink: 0 }} />
          <div style={{ padding: "10px 16px", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <Toggle
              label="Captions"
              checked={enableCaptions}
              onChange={setEnableCaptions}
              icon={<ClosedCaptioningIcon size={13} />}
            />
            <Toggle
              label="Narration"
              checked={enableAudio}
              onChange={setEnableAudio}
              icon={<SpeakerHighIcon size={13} />}
            />
            <button
              onClick={onGenerate}
              style={{
                marginLeft: "auto",
                padding: "8px 18px", borderRadius: 9, border: "none",
                background: "var(--launch-accent, #6366f1)", color: "#fff",
                fontSize: 13, fontWeight: 600, cursor: "pointer",
              }}
            >
              Generate →
            </button>
          </div>
        </>
      )}
    </div>
  );
}
