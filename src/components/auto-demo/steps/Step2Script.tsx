import { useState } from "react";
import { ArrowLeftIcon, RecordIcon, ArrowsCounterClockwiseIcon } from "@phosphor-icons/react";
import { AutoDemoFlowchart } from "../AutoDemoFlowchart";
import type { AppFeatureMap, RecordingScript } from "../useAutoDemoStore";

interface Props {
  featureMap: AppFeatureMap;
  script: RecordingScript;
  isRecording: boolean;
  isRegenerating: boolean;
  onApprove: () => void;
  onRegenerate: (refinement: string) => void;
  onBack: () => void;
  styles: Record<string, string>;
}

export function Step2Script({ featureMap, script, isRecording, isRegenerating, onApprove, onRegenerate, onBack, styles }: Props) {
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

        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            onClick={() => { onRegenerate(refinement); setRefinement(""); }}
            disabled={!refinement.trim() || isRecording || isRegenerating}
            className={styles.ddItem}
            style={{
              flex: 1,
              justifyContent: "center",
              borderRadius: 10,
              border: "1px solid var(--launch-border)",
              height: 40,
              fontSize: 14,
              fontWeight: 500,
              opacity: (!refinement.trim() || isRecording || isRegenerating) ? 0.45 : 1,
            }}
          >
            {isRegenerating ? (
              <>
                <span style={{ width: 12, height: 12, borderRadius: "50%", border: "2px solid rgba(0,0,0,0.2)", borderTopColor: "var(--launch-accent)", display: "inline-block", animation: "spin 0.7s linear infinite", marginRight: 5 }} />
                Regenerating…
              </>
            ) : (
              <>
                <ArrowsCounterClockwiseIcon size={14} style={{ marginRight: 5 }} />
                Regenerate
              </>
            )}
          </button>

          <button
            type="button"
            onClick={onApprove}
            disabled={isRecording || isRegenerating}
            style={{
              flex: 1,
              height: 40,
              borderRadius: 10,
              border: "none",
              background: "var(--launch-accent)",
              color: "#fff",
              fontSize: 14,
              fontWeight: 600,
              cursor: (isRecording || isRegenerating) ? "default" : "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              opacity: (isRecording || isRegenerating) ? 0.6 : 1,
            }}
          >
            {isRecording ? (
              <>
                <span style={{ width: 12, height: 12, borderRadius: "50%", border: "2px solid rgba(255,255,255,0.3)", borderTopColor: "#fff", display: "inline-block", animation: "spin 0.7s linear infinite" }} />
                Recording…
              </>
            ) : (
              <>
                <RecordIcon size={14} weight="fill" />
                Approve & Record
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
