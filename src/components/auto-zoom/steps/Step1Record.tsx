import { useEffect, useState } from "react";
import { RecordIcon } from "@phosphor-icons/react";

interface Props {
  styles: Record<string, string>;
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Purely presentational — recording itself is driven by Recordly's own HUD
 * record button. This step just arms the handoff (done by the parent window)
 * and reflects the HUD's live recording state until the recording finalizes,
 * at which point the parent advances to Step 2 automatically.
 */
export function Step1Record({ styles: _styles }: Props) {
  const [isRecording, setIsRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    const cleanup = window.electronAPI?.onRecordingStateChanged?.((state) => {
      setIsRecording(state.recording);
      if (!state.recording) setElapsedMs(0);
    });
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    if (!isRecording) return;
    const startedAt = Date.now();
    const tick = setInterval(() => setElapsedMs(Date.now() - startedAt), 500);
    return () => clearInterval(tick);
  }, [isRecording]);

  return (
    <div style={{ padding: "0 20px 20px" }}>
      {/* Section label */}
      <div style={{ marginBottom: 20 }}>
        <p style={{ fontSize: 13, color: "var(--launch-label)", lineHeight: 1.6, margin: 0 }}>
          Record yourself walking through your app. Show every feature you want in the final demo — Auto Zoom handles the rest automatically.
        </p>
      </div>

      {/* Tips */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 24 }}>
        {[
          "Press Record in Recordly's HUD and pick your source",
          "Click through all features you want highlighted",
          "Keep it natural — no need to zoom or pause",
          "When you stop, Auto Zoom continues automatically",
        ].map((tip, i) => (
          <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <span style={{ fontSize: 13, color: "var(--launch-accent)", marginTop: 1, flexShrink: 0, fontWeight: 600 }}>→</span>
            <span style={{ fontSize: 13, color: "var(--launch-label)", lineHeight: 1.5 }}>{tip}</span>
          </div>
        ))}
      </div>

      {isRecording ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, marginBottom: 4 }}>
          <span
            style={{
              width: 8, height: 8, borderRadius: "50%",
              background: "#ef4444", animation: "blink 1.2s ease-in-out infinite", flexShrink: 0,
            }}
          />
          <span style={{ fontSize: 28, fontVariantNumeric: "tabular-nums", fontWeight: 600, color: "var(--launch-text)", letterSpacing: "0.02em" }}>
            {formatElapsed(elapsedMs)}
          </span>
        </div>
      ) : (
        <div
          style={{
            width: "100%",
            height: 42,
            borderRadius: 10,
            border: "1.5px dashed var(--launch-border-strong)",
            color: "var(--launch-label)",
            fontSize: 14,
            fontWeight: 500,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 7,
          }}
        >
          <RecordIcon size={15} />
          Waiting for you to press Record…
        </div>
      )}

      <p style={{ fontSize: 12, color: "var(--launch-label)", textAlign: "center", marginTop: 14, marginBottom: 0 }}>
        Recording is controlled by Recordly's HUD, not this window
      </p>
    </div>
  );
}
