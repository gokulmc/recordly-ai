import { useState, useEffect, useRef } from "react";
import { RecordIcon, StopCircleIcon } from "@phosphor-icons/react";

interface Props {
  onRecordingComplete: (videoPath: string, cursorPath: string) => void;
  styles: Record<string, string>;
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function Step1Record({ onRecordingComplete, styles: _styles }: Props) {
  const [isRecording, setIsRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const startTimeRef = useRef<number>(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Listen for pill stop events (user clicked stop from the floating pill)
  useEffect(() => {
    const cleanup = window.electronAPI?.onAutoZoomPillStop?.(() => {
      void handleStop();
    });
    return () => cleanup?.();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleStart() {
    setError(null);
    try {
      await window.electronAPI?.autoZoomStartRecord?.({});

      // Reuse the Recordly recording flow — get the currently selected source
      // (same source the user picked in the HUD source selector)
      const source = await window.electronAPI?.getSelectedSource?.();
      if (!source) {
        setError("No screen source selected. Open Recordly's source selector first.");
        return;
      }

      const result = await window.electronAPI?.startNativeScreenRecording?.(source);
      if (!result?.success) {
        setError(result?.message ?? "Failed to start recording.");
        return;
      }

      setIsRecording(true);
      startTimeRef.current = Date.now();
      tickRef.current = setInterval(() => {
        setElapsedMs(Date.now() - startTimeRef.current);
      }, 500);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleStop() {
    if (!isRecording) return;
    if (tickRef.current) clearInterval(tickRef.current);
    setIsRecording(false);
    try {
      const stopResult = await window.electronAPI?.stopNativeScreenRecording?.() as Record<string, unknown> | undefined;
      const videoPath: string = (stopResult?.path ?? "") as string;
      // Cursor telemetry sidecar lives at <videoPath>.cursor.json by convention
      const cursorPath = `${videoPath}.cursor.json`;
      await window.electronAPI?.autoZoomStopRecord?.({ videoPath, cursorPath });
      onRecordingComplete(videoPath, cursorPath);
    } catch (err) {
      setError(String(err));
    }
  }

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
          "Open your app before starting",
          "Click through all features you want highlighted",
          "Keep it natural — no need to zoom or pause",
        ].map((tip, i) => (
          <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <span style={{ fontSize: 13, color: "var(--launch-accent)", marginTop: 1, flexShrink: 0, fontWeight: 600 }}>→</span>
            <span style={{ fontSize: 13, color: "var(--launch-label)", lineHeight: 1.5 }}>{tip}</span>
          </div>
        ))}
      </div>

      {/* Timer */}
      {isRecording && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, marginBottom: 16 }}>
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
      )}

      {/* Record / Stop button */}
      {!isRecording ? (
        <button
          type="button"
          onClick={() => void handleStart()}
          style={{
            width: "100%",
            height: 42,
            borderRadius: 10,
            border: "none",
            background: "#ef4444",
            color: "#fff",
            fontSize: 15,
            fontWeight: 600,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 7,
          }}
        >
          <RecordIcon size={15} weight="fill" />
          Start Recording
        </button>
      ) : (
        <button
          type="button"
          onClick={() => void handleStop()}
          style={{
            width: "100%",
            height: 42,
            borderRadius: 10,
            background: "transparent",
            border: "1.5px solid #ef4444",
            color: "#ef4444",
            fontSize: 15,
            fontWeight: 600,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 7,
          }}
        >
          <StopCircleIcon size={15} weight="fill" />
          Stop Recording
        </button>
      )}

      {/* Source hint */}
      <p style={{ fontSize: 12, color: "var(--launch-label)", textAlign: "center", marginTop: 10, marginBottom: 0 }}>
        Uses the source selected in Recordly's HUD
      </p>

      {error && (
        <p style={{ fontSize: 13, color: "#dc2626", marginTop: 10, textAlign: "center", lineHeight: 1.4 }}>{error}</p>
      )}
    </div>
  );
}
