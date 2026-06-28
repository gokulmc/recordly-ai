import { useState } from "react";
import { ArrowLeftIcon, RecordIcon, ArrowsCounterClockwiseIcon, LockKeyIcon } from "@phosphor-icons/react";
import { AutoDemoFlowchart } from "../AutoDemoFlowchart";
import type { AppFeatureMap, RecordingScript } from "../useAutoDemoStore";

interface Props {
  featureMap: AppFeatureMap;
  script: RecordingScript;
  isRecording: boolean;
  isRegenerating: boolean;
  /** App requires login but no demo credentials were entered */
  authWarning: boolean;
  onApprove: () => void;
  onRegenerate: (refinement: string) => void;
  onBack: () => void;
  onAddCredentials: () => void;
}

export function Step2Script({ featureMap, script, isRecording, isRegenerating, authWarning, onApprove, onRegenerate, onBack, onAddCredentials }: Props) {
  const [refinement, setRefinement] = useState("");

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Header */}
      <div style={{ padding: "10px 16px 8px", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        <button
          type="button"
          onClick={onBack}
          style={{ color: "var(--launch-label)", cursor: "pointer", background: "none", border: "none", padding: 2, borderRadius: 4, display: "flex" }}
        >
          <ArrowLeftIcon size={16} />
        </button>
        <span style={{ fontSize: 15, fontWeight: 600, color: "var(--launch-text)" }}>Script Preview</span>
        <span style={{ marginLeft: "auto", fontSize: 13, color: "var(--launch-label)" }}>Step 2 of 3</span>
      </div>

      <div style={{ height: 1, background: "var(--launch-border)", flexShrink: 0 }} />

      {/* Auth-needed warning */}
      {authWarning && (
        <div style={{
          flexShrink: 0,
          margin: "10px 16px 0",
          padding: "10px 12px",
          borderRadius: 9,
          border: "1px solid rgba(234,179,8,0.35)",
          background: "rgba(234,179,8,0.07)",
          display: "flex",
          alignItems: "flex-start",
          gap: 8,
        }}>
          <LockKeyIcon size={15} weight="fill" style={{ color: "#ca8a04", flexShrink: 0, marginTop: 1 }} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#92400e" }}>This app needs login to demo</div>
            <div style={{ fontSize: 12, color: "#92400e", opacity: 0.85, lineHeight: 1.4, marginTop: 2 }}>
              No demo credentials were entered, so the recording may hit a sign-in wall.
            </div>
            <button
              type="button"
              onClick={onAddCredentials}
              style={{ marginTop: 6, fontSize: 12, fontWeight: 600, color: "#92400e", textDecoration: "underline", background: "none", border: "none", padding: 0, cursor: "pointer" }}
            >
              ← Add demo credentials
            </button>
          </div>
        </div>
      )}

      {/* Flowchart */}
      <div style={{ flex: 1, overflowY: "auto", padding: "10px 12px", minHeight: 0 }}>
        <AutoDemoFlowchart featureMap={featureMap} script={script} />
      </div>

      {/* Refinement + actions */}
      <div style={{ flexShrink: 0, borderTop: "1px solid var(--launch-border)", padding: "12px 16px 14px" }}>
        <textarea
          value={refinement}
          onChange={(e) => setRefinement(e.target.value)}
          placeholder="Refine the script… e.g. add the export flow after sign-in"
          rows={2}
          disabled={isRecording || isRegenerating}
          style={{
            width: "100%",
            padding: "9px 12px",
            fontSize: 15,
            color: "var(--launch-text)",
            background: "var(--launch-panel)",
            border: "1px solid var(--launch-border)",
            borderRadius: 9,
            outline: "none",
            resize: "none",
            fontFamily: "inherit",
            lineHeight: 1.5,
            marginBottom: 10,
            opacity: (isRecording || isRegenerating) ? 0.5 : 1,
            boxSizing: "border-box",
          }}
        />

        {/* Single CTA: becomes Regenerate when the refine box has text,
            otherwise Approve & Record. */}
        {(() => {
          const wantsRegenerate = refinement.trim().length > 0;
          const busy = isRecording || isRegenerating;
          const onClick = wantsRegenerate
            ? () => { onRegenerate(refinement); setRefinement(""); }
            : onApprove;
          return (
            <button
              type="button"
              onClick={onClick}
              disabled={busy}
              style={{
                width: "100%",
                height: 42,
                borderRadius: 10,
                border: "none",
                background: wantsRegenerate ? "var(--launch-text)" : "var(--launch-accent)",
                color: "#fff",
                fontSize: 14,
                fontWeight: 600,
                cursor: busy ? "default" : "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                opacity: busy ? 0.6 : 1,
                transition: "background 0.15s",
              }}
            >
              {isRegenerating ? (
                <>
                  <span style={{ width: 13, height: 13, borderRadius: "50%", border: "2px solid rgba(255,255,255,0.3)", borderTopColor: "#fff", display: "inline-block", animation: "spin 0.7s linear infinite" }} />
                  Regenerating…
                </>
              ) : isRecording ? (
                <>
                  <span style={{ width: 13, height: 13, borderRadius: "50%", border: "2px solid rgba(255,255,255,0.3)", borderTopColor: "#fff", display: "inline-block", animation: "spin 0.7s linear infinite" }} />
                  Recording…
                </>
              ) : wantsRegenerate ? (
                <>
                  <ArrowsCounterClockwiseIcon size={15} weight="bold" />
                  Regenerate with changes
                </>
              ) : (
                <>
                  <RecordIcon size={15} weight="fill" />
                  Approve & Record
                </>
              )}
            </button>
          );
        })()}
      </div>
    </div>
  );
}
