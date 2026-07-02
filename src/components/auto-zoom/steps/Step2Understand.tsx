import { useEffect, useRef, useState } from "react";
import {
  CheckCircleIcon,
  CircleNotchIcon,
  WarningCircleIcon,
  ClosedCaptioningIcon,
  SpeakerHighIcon,
  CropIcon,
  MusicNotesIcon,
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
  enableAutoCrop: boolean;
  setEnableAutoCrop: (v: boolean) => void;
  enableMusic: boolean;
  setEnableMusic: (v: boolean) => void;
  onGenerate: () => void;
  styles: Record<string, string>;
}

const STAGE_LABELS: Record<string, string> = {
  frames: "Extracting frames",
  understanding: "Understanding your app",
};

function formatTimestamp(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function StageIcon({ status }: { status: AutoZoomProgress["status"] }) {
  if (status === "running") return <CircleNotchIcon size={15} weight="bold" style={{ color: "var(--launch-accent)", animation: "spin 0.7s linear infinite", flexShrink: 0 }} />;
  if (status === "done") return <CheckCircleIcon size={15} weight="fill" style={{ color: "#059669", flexShrink: 0 }} />;
  return <WarningCircleIcon size={15} weight="fill" style={{ color: "#dc2626", flexShrink: 0 }} />;
}

function Toggle({ label, checked, onChange, icon }: { label: string; checked: boolean; onChange: (v: boolean) => void; icon: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "6px 12px", borderRadius: 8,
        background: checked ? "rgba(37,99,235,0.08)" : "transparent",
        border: `1px solid ${checked ? "var(--launch-accent)" : "var(--launch-border)"}`,
        color: checked ? "var(--launch-accent)" : "var(--launch-label)",
        fontSize: 13, fontWeight: 500, cursor: "pointer",
        transition: "all 0.12s",
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
  enableAutoCrop,
  setEnableAutoCrop,
  enableMusic,
  setEnableMusic,
  onGenerate,
  styles: _styles,
}: Props) {
  const [feedback, setFeedback] = useState("");
  const [isRefining, setIsRefining] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!videoPath || isAnalyzing) return;
    setIsAnalyzing(true);
    void window.electronAPI?.autoZoomAnalyze?.({ videoPath, cursorPath });
  }, [videoPath]); // eslint-disable-line react-hooks/exhaustive-deps

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
    <div ref={bodyRef} style={{ padding: "0 20px 20px", display: "flex", flexDirection: "column", gap: 16 }}>

      {/* Progress stages */}
      {(progresses.length > 0 || !isDone) && (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {(progresses.length === 0 && !isDone
            ? [{ stage: "frames", status: "running" as const, message: "Starting…" }]
            : progresses
          ).map((p) => (
            <div
              key={p.stage}
              style={{
                display: "flex", alignItems: "flex-start", gap: 12,
                padding: "9px 12px", borderRadius: 9,
                background: p.status === "running" ? "rgba(37,99,235,0.05)" : "transparent",
                borderLeft: p.status === "running" ? "2px solid var(--launch-accent)" : "2px solid transparent",
                transition: "all 0.15s",
              }}
            >
              <div style={{ marginTop: 2 }}>
                <StageIcon status={p.status} />
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <p style={{ fontSize: 14, fontWeight: 500, color: p.status === "error" ? "#dc2626" : "var(--launch-text)", margin: 0, lineHeight: 1.3 }}>
                  {STAGE_LABELS[p.stage] ?? p.stage}
                </p>
                {p.message && (
                  <p style={{ fontSize: 13, color: "var(--launch-text-muted)", margin: "3px 0 0", lineHeight: 1.4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {p.message}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Error banner */}
      {hasError && (
        <div style={{ padding: "8px 12px", borderRadius: 9, background: "rgba(220,38,38,0.06)", border: "1px solid rgba(220,38,38,0.2)" }}>
          <p style={{ fontSize: 13, color: "#dc2626", margin: 0 }}>Analysis failed — check your ANTHROPIC_API_KEY and try again.</p>
        </div>
      )}

      {/* Mindmap */}
      {analysis && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--launch-label)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 10 }}>
            Feature map
          </div>
          <MindMap analysis={analysis} />
        </div>
      )}

      {/* Garbage segments the generator will cut out */}
      {analysis && (analysis.garbageSegments?.length ?? 0) > 0 && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: "#d97706", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 8 }}>
            Will be cut
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {analysis.garbageSegments?.map((g, i) => (
              <div
                key={i}
                style={{
                  display: "flex", alignItems: "baseline", gap: 8,
                  padding: "6px 10px", borderRadius: 8,
                  background: "rgba(217,119,6,0.06)", border: "1px solid rgba(217,119,6,0.18)",
                }}
              >
                <span style={{ fontSize: 12, fontVariantNumeric: "tabular-nums", fontWeight: 600, color: "#d97706", flexShrink: 0 }}>
                  {formatTimestamp(g.startMs)}–{formatTimestamp(g.endMs)}
                </span>
                <span style={{ fontSize: 12.5, color: "var(--launch-label)", lineHeight: 1.4 }}>{g.reason}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Feedback / corrections */}
      {isDone && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--launch-label)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 8 }}>
            Corrections (optional)
          </div>
          <div style={{ display: "flex", gap: 7 }}>
            <input
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleFeedback(); } }}
              placeholder='e.g. "the search tab is for enterprise users only"'
              disabled={isRefining}
              style={{
                flex: 1, height: 38, padding: "0 12px", fontSize: 14,
                color: "var(--launch-text)", background: "var(--launch-panel, var(--launch-surface))",
                border: "1px solid var(--launch-border)", borderRadius: 9,
                outline: "none",
              }}
            />
            <button
              type="button"
              onClick={() => void handleFeedback()}
              disabled={!feedback.trim() || isRefining}
              style={{
                height: 38, padding: "0 14px", borderRadius: 9, border: "none",
                background: "var(--launch-accent)", color: "#fff",
                fontSize: 14, fontWeight: 600, cursor: feedback.trim() && !isRefining ? "pointer" : "not-allowed",
                opacity: feedback.trim() && !isRefining ? 1 : 0.5, flexShrink: 0,
              }}
            >
              {isRefining ? <CircleNotchIcon size={13} weight="bold" style={{ animation: "spin 0.7s linear infinite" }} /> : "Update"}
            </button>
          </div>
        </div>
      )}

      {/* Footer: toggles + generate */}
      {isDone && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, paddingTop: 4 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <Toggle label="Auto crop" checked={enableAutoCrop} onChange={setEnableAutoCrop} icon={<CropIcon size={14} />} />
            <Toggle label="Captions" checked={enableCaptions} onChange={setEnableCaptions} icon={<ClosedCaptioningIcon size={14} />} />
            <Toggle label="Narration" checked={enableAudio} onChange={setEnableAudio} icon={<SpeakerHighIcon size={14} />} />
            <Toggle label="Music" checked={enableMusic} onChange={setEnableMusic} icon={<MusicNotesIcon size={14} />} />
          </div>
          <button
            type="button"
            onClick={onGenerate}
            style={{
              width: "100%",
              height: 42, padding: "0 20px",
              borderRadius: 10, border: "none",
              background: "var(--launch-accent)", color: "#fff",
              fontSize: 15, fontWeight: 600, cursor: "pointer",
            }}
          >
            Generate →
          </button>
        </div>
      )}
    </div>
  );
}
