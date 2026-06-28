import {
  CheckCircleIcon,
  CircleNotchIcon,
  WarningCircleIcon,
  XCircleIcon,
  FolderOpenIcon,
} from "@phosphor-icons/react";
import type { StageState } from "../useAutoDemoStore";

interface Props {
  stages: StageState[];
  errorMessage: string | null;
  projectPath: string | null;
  isRunning: boolean;
  onCancel: () => void;
  onOpenProject: () => void;
  styles: Record<string, string>;
}

function StageIcon({ status }: { status: StageState["status"] }) {
  if (status === "running") return <CircleNotchIcon size={15} weight="bold" style={{ color: "var(--launch-accent)", animation: "spin 0.7s linear infinite", flexShrink: 0 }} />;
  if (status === "done") return <CheckCircleIcon size={15} weight="fill" style={{ color: "#059669", flexShrink: 0 }} />;
  if (status === "error") return <WarningCircleIcon size={15} weight="fill" style={{ color: "#dc2626", flexShrink: 0 }} />;
  return <span style={{ width: 15, height: 15, borderRadius: "50%", border: "1.5px solid var(--launch-border-strong)", display: "inline-block", flexShrink: 0 }} />;
}

export function Step3Progress({ stages, errorMessage, projectPath, isRunning, onCancel, onOpenProject, styles: _styles }: Props) {
  const isDone = stages.some((s) => s.id === "done" && s.status === "done");

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Header */}
      <div style={{ padding: "10px 16px 8px", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--launch-text)" }}>
          {isDone ? "All done" : isRunning ? "Running pipeline…" : "Progress"}
        </span>
        <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--launch-label)" }}>Step 3 of 3</span>
      </div>

      <div style={{ height: 1, background: "var(--launch-border)", flexShrink: 0 }} />

      {/* Stage list */}
      <div style={{ flex: 1, overflowY: "auto", padding: "6px 16px", minHeight: 0 }}>
        {stages.map((stage) => (
          <div
            key={stage.id}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 12,
              padding: "9px 12px",
              borderRadius: 9,
              marginBottom: 2,
              background: stage.status === "running" ? "rgba(37,99,235,0.05)" : "transparent",
              borderLeft: stage.status === "running" ? "2px solid var(--launch-accent)" : "2px solid transparent",
              transition: "all 0.15s",
            }}
          >
            <div style={{ marginTop: 2 }}>
              <StageIcon status={stage.status} />
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <p style={{
                fontSize: 13,
                fontWeight: 500,
                color: stage.status === "pending" ? "var(--launch-label)" : stage.status === "error" ? "#dc2626" : "var(--launch-text)",
                margin: 0,
                lineHeight: 1.3,
              }}>
                {stage.label}
              </p>
              {stage.message && stage.status !== "pending" && (
                <p style={{ fontSize: 12, color: "var(--launch-text-muted)", margin: "3px 0 0", lineHeight: 1.4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {stage.message}
                </p>
              )}
            </div>
          </div>
        ))}

        {errorMessage && (
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "7px 10px", borderRadius: 8, background: "rgba(220,38,38,0.05)" }}>
            <XCircleIcon size={15} weight="fill" style={{ color: "#dc2626", flexShrink: 0, marginTop: 1 }} />
            <p style={{ fontSize: 11, color: "#991b1b", margin: 0, lineHeight: 1.4 }}>{errorMessage}</p>
          </div>
        )}
      </div>

      {/* Footer action */}
      <div style={{ flexShrink: 0, borderTop: "1px solid var(--launch-border)", padding: "10px 16px 14px" }}>
        {isDone && projectPath ? (
          <button
            type="button"
            onClick={onOpenProject}
            style={{
              width: "100%",
              height: 42,
              borderRadius: 10,
              border: "none",
              background: "#059669",
              color: "#fff",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 7,
            }}
          >
            <FolderOpenIcon size={15} />
            Open in Editor
          </button>
        ) : isRunning ? (
          <button
            type="button"
            onClick={onCancel}
            style={{
              width: "100%",
              height: 42,
              borderRadius: 10,
              border: "1px solid var(--launch-border)",
              background: "var(--launch-hover)",
              color: "var(--launch-text-muted)",
              fontSize: 14,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
        ) : null}
      </div>
    </div>
  );
}
