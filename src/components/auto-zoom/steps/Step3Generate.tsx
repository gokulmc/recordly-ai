import { CheckCircleIcon, CircleNotchIcon, WarningCircleIcon, FolderOpenIcon } from "@phosphor-icons/react";
import type { AutoZoomProgress } from "../useAutoZoomStore";

interface Props {
  progresses: AutoZoomProgress[];
  projectPath: string | null;
  error: string | null;
  onOpenProject: () => void;
  styles: Record<string, string>;
}

const STAGE_LABELS: Record<string, string> = {
  zooms: "Deriving zoom regions",
  captions: "Building captions",
  audio: "Generating narration",
  assemble: "Assembling project",
  open: "Opening in editor",
};

const STAGE_ORDER = ["zooms", "captions", "audio", "assemble", "open"];

function StageIcon({ status }: { status: string }) {
  if (status === "running") return <CircleNotchIcon size={15} weight="bold" style={{ color: "var(--launch-accent)", animation: "spin 0.7s linear infinite", flexShrink: 0 }} />;
  if (status === "done") return <CheckCircleIcon size={15} weight="fill" style={{ color: "#059669", flexShrink: 0 }} />;
  if (status === "error") return <WarningCircleIcon size={15} weight="fill" style={{ color: "#dc2626", flexShrink: 0 }} />;
  return <span style={{ width: 15, height: 15, borderRadius: "50%", border: "1.5px solid var(--launch-border-strong)", display: "inline-block", flexShrink: 0 }} />;
}

export function Step3Generate({ progresses, projectPath, error, onOpenProject, styles: _styles }: Props) {
  const progressMap = Object.fromEntries(progresses.map((p) => [p.stage, p]));
  const openFailed = progressMap.open?.status === "error";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Stage list */}
      <div style={{ flex: 1, padding: "0 20px", display: "flex", flexDirection: "column", gap: 2 }}>
        {STAGE_ORDER.map((s) => {
          const p = progressMap[s];
          const status: string = p?.status ?? "pending";
          return (
            <div
              key={s}
              style={{
                display: "flex", alignItems: "flex-start", gap: 12,
                padding: "9px 12px", borderRadius: 9,
                background: status === "running" ? "rgba(37,99,235,0.05)" : "transparent",
                borderLeft: status === "running" ? "2px solid var(--launch-accent)" : "2px solid transparent",
                transition: "all 0.15s",
              }}
            >
              <div style={{ marginTop: 2 }}>
                <StageIcon status={status} />
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <p style={{
                  fontSize: 14, fontWeight: 500, margin: 0, lineHeight: 1.3,
                  color: status === "pending" ? "var(--launch-label)" : status === "error" ? "#dc2626" : "var(--launch-text)",
                }}>
                  {STAGE_LABELS[s] ?? s}
                </p>
                {p?.message && status !== "pending" && (
                  <p style={{ fontSize: 13, color: "var(--launch-text-muted)", margin: "3px 0 0", lineHeight: 1.4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {p.message}
                  </p>
                )}
              </div>
            </div>
          );
        })}

        {error && (
          <div style={{ marginTop: 8, padding: "8px 12px", borderRadius: 9, background: "rgba(220,38,38,0.06)", border: "1px solid rgba(220,38,38,0.2)" }}>
            <p style={{ fontSize: 13, color: "#dc2626", margin: 0 }}>{error}</p>
          </div>
        )}
      </div>

      {/* The editor opens automatically once assembly finishes — this footer
          only appears if that final step itself failed, as a manual retry. */}
      {projectPath && openFailed && (
        <div style={{ flexShrink: 0, borderTop: "1px solid var(--launch-border)", padding: "10px 20px 14px" }}>
          <button
            type="button"
            onClick={onOpenProject}
            style={{
              width: "100%", height: 42, borderRadius: 10, border: "none",
              background: "#059669", color: "#fff",
              fontSize: 15, fontWeight: 600, cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
            }}
          >
            <FolderOpenIcon size={15} />
            Retry opening in editor
          </button>
        </div>
      )}
    </div>
  );
}
