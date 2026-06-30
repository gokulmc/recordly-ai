import { CheckCircleIcon, CircleNotchIcon, WarningCircleIcon, FolderOpenIcon } from "@phosphor-icons/react";
import type { AutoZoomProgress } from "../useAutoZoomStore";

interface Props {
  progresses: AutoZoomProgress[];
  projectPath: string | null;
  error: string | null;
  onOpenProject: () => void;
}

const STAGE_LABELS: Record<string, string> = {
  zooms: "Deriving zoom regions",
  captions: "Building captions",
  audio: "Generating narration",
  assemble: "Assembling project",
};

const STAGE_ORDER = ["zooms", "captions", "audio", "assemble"];

function StageRow({ stage, progress }: { stage: string; progress: AutoZoomProgress | undefined }) {
  const label = STAGE_LABELS[stage] ?? stage;
  const status = progress?.status ?? "pending";
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "4px 0" }}>
      {status === "running" ? (
        <CircleNotchIcon size={15} weight="bold" style={{ color: "var(--launch-accent, #6366f1)", animation: "spin 0.7s linear infinite", flexShrink: 0, marginTop: 1 }} />
      ) : status === "done" ? (
        <CheckCircleIcon size={15} weight="fill" style={{ color: "#059669", flexShrink: 0, marginTop: 1 }} />
      ) : status === "error" ? (
        <WarningCircleIcon size={15} weight="fill" style={{ color: "#dc2626", flexShrink: 0, marginTop: 1 }} />
      ) : (
        <span style={{ width: 15, height: 15, borderRadius: "50%", border: "1.5px solid var(--launch-border-strong, #4b5563)", display: "inline-block", flexShrink: 0, marginTop: 1 }} />
      )}
      <div style={{ display: "flex", flexDirection: "column" }}>
        <span style={{ fontSize: 13, color: status === "pending" ? "var(--launch-label)" : "var(--launch-text)" }}>{label}</span>
        {progress?.message && status !== "pending" && (
          <span style={{ fontSize: 11, color: "var(--launch-label)" }}>{progress.message}</span>
        )}
      </div>
    </div>
  );
}

export function Step3Generate({ progresses, projectPath, error, onOpenProject }: Props) {
  const progressMap = Object.fromEntries(progresses.map((p) => [p.stage, p]));
  const isDone = !!projectPath;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Header */}
      <div style={{ padding: "10px 16px 8px", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        <span style={{ fontSize: 15, fontWeight: 600, color: "var(--launch-text)" }}>
          {isDone ? "All done!" : "Generating your demo…"}
        </span>
        <span style={{ marginLeft: "auto", fontSize: 13, color: "var(--launch-label)" }}>Step 3 of 3</span>
      </div>
      <div style={{ height: 1, background: "var(--launch-border)", flexShrink: 0 }} />

      {/* Stage list */}
      <div style={{ flex: 1, padding: "16px 20px", display: "flex", flexDirection: "column", gap: 4 }}>
        {STAGE_ORDER.map((s) => (
          <StageRow key={s} stage={s} progress={progressMap[s]} />
        ))}
        {error && (
          <div style={{ marginTop: 12, fontSize: 12, color: "#ef4444", padding: "8px 12px", borderRadius: 8, background: "#ef444410", border: "1px solid #ef444430" }}>
            {error}
          </div>
        )}
      </div>

      {/* Open project button */}
      {isDone && (
        <>
          <div style={{ height: 1, background: "var(--launch-border)", flexShrink: 0 }} />
          <div style={{ padding: "12px 16px" }}>
            <button
              onClick={onOpenProject}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                width: "100%", padding: "10px", borderRadius: 10, border: "none",
                background: "var(--launch-accent, #6366f1)", color: "#fff",
                fontSize: 14, fontWeight: 600, cursor: "pointer",
              }}
            >
              <FolderOpenIcon size={16} weight="fill" />
              Open in Editor
            </button>
          </div>
        </>
      )}
    </div>
  );
}
