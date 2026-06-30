import { useState, useEffect, useRef } from "react";
import { RecordIcon, StopCircleIcon, MonitorIcon } from "@phosphor-icons/react";

interface Props {
  onRecordingComplete: (videoPath: string, cursorPath: string) => void;
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function Step1Record({ onRecordingComplete }: Props) {
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
  }, [isRecording]);

  async function handleStart() {
    setError(null);
    try {
      await window.electronAPI?.autoZoomStartRecord?.({});
      // Start the actual native recording — pass null source to use the system default display
      const result = await window.electronAPI?.startNativeScreenRecording?.(
        null as unknown as Parameters<typeof window.electronAPI.startNativeScreenRecording>[0],
      );
      if (!result?.success) {
        setError("Failed to start recording.");
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
      const videoPath: string = (stopResult?.path ?? stopResult?.filePath ?? stopResult?.videoPath ?? "") as string;
      // Cursor telemetry sidecar lives at <videoPath>.cursor.json by convention
      const cursorPath: string = `${videoPath}.cursor.json`;
      await window.electronAPI?.autoZoomStopRecord?.({ videoPath, cursorPath });
      onRecordingComplete(videoPath, cursorPath);
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Header */}
      <div style={{ padding: "10px 16px 8px", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        <span style={{ fontSize: 15, fontWeight: 600, color: "var(--launch-text)" }}>
          Record your walkthrough
        </span>
        <span style={{ marginLeft: "auto", fontSize: 13, color: "var(--launch-label)" }}>Step 1 of 3</span>
      </div>
      <div style={{ height: 1, background: "var(--launch-border)", flexShrink: 0 }} />

      {/* Body */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", padding: "24px 20px", gap: 20 }}>

        {/* Instructions */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <p style={{ margin: 0, fontSize: 13, color: "var(--launch-label)", lineHeight: 1.5 }}>
            Record yourself walking through your app. Show every feature you want in the final demo — Auto Zoom will handle the rest.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
            {["Open your app and navigate to the start", "Click through all the features you want to highlight", "Keep it natural — no need to zoom manually"].map((tip, i) => (
              <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                <span style={{ fontSize: 11, color: "var(--launch-accent, #6366f1)", marginTop: 1, flexShrink: 0 }}>→</span>
                <span style={{ fontSize: 12, color: "var(--launch-label)" }}>{tip}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Source hint */}
        <div
          style={{
            display: "flex", alignItems: "center", gap: 8, padding: "8px 12px",
            borderRadius: 8, background: "var(--launch-surface, rgba(255,255,255,0.04))",
            border: "1px solid var(--launch-border)",
          }}
        >
          <MonitorIcon size={14} style={{ color: "var(--launch-label)", flexShrink: 0 }} />
          <span style={{ fontSize: 12, color: "var(--launch-label)" }}>
            Captures entire screen — switch to your app after clicking Record
          </span>
        </div>

        {/* Timer / Record button */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
          {isRecording && (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                style={{
                  width: 8, height: 8, borderRadius: "50%",
                  background: "#ef4444", animation: "blink 1.2s ease-in-out infinite",
                }}
              />
              <span style={{ fontSize: 22, fontVariantNumeric: "tabular-nums", fontWeight: 600, color: "var(--launch-text)" }}>
                {formatElapsed(elapsedMs)}
              </span>
            </div>
          )}

          {!isRecording ? (
            <button
              onClick={() => void handleStart()}
              style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "10px 24px", borderRadius: 10, border: "none",
                background: "#ef4444", color: "#fff",
                fontSize: 14, fontWeight: 600, cursor: "pointer",
                width: "100%", justifyContent: "center",
              }}
            >
              <RecordIcon size={16} weight="fill" />
              Start Recording
            </button>
          ) : (
            <button
              onClick={() => void handleStop()}
              style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "10px 24px", borderRadius: 10,
                background: "var(--launch-surface, rgba(255,255,255,0.08))",
                border: "1.5px solid #ef4444",
                color: "#ef4444",
                fontSize: 14, fontWeight: 600, cursor: "pointer",
                width: "100%", justifyContent: "center",
              }}
            >
              <StopCircleIcon size={16} weight="fill" />
              Stop Recording
            </button>
          )}
        </div>

        {error && (
          <div style={{ fontSize: 12, color: "#ef4444", textAlign: "center" }}>{error}</div>
        )}
      </div>
    </div>
  );
}
