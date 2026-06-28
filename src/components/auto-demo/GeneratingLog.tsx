import { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { CheckCircleIcon, CircleNotchIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { StageState } from "./useAutoDemoStore";

// Stages relevant to the generate-script phase only
const SCRIPT_STAGES: Array<{ id: string; label: string }> = [
  { id: "ingest", label: "Read repo" },
  { id: "crawl", label: "Crawl app" },
  { id: "script", label: "Generate" },
];

interface Props {
  stages: StageState[];
  logLines: string[];
  errorMessage?: string | null;
}

function StagePill({ stage, status }: { stage: string; status: "pending" | "running" | "done" | "error" }) {
  const isDone = status === "done";
  const isRunning = status === "running";

  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: 5,
      padding: "4px 10px",
      borderRadius: 20,
      border: `1px solid ${isRunning ? "rgba(37,99,235,0.3)" : isDone ? "rgba(5,150,105,0.25)" : "var(--launch-border)"}`,
      background: isRunning ? "rgba(37,99,235,0.07)" : isDone ? "rgba(5,150,105,0.07)" : "transparent",
      transition: "all 0.2s",
    }}>
      {isRunning ? (
        <CircleNotchIcon size={12} weight="bold" style={{ color: "#2563eb", animation: "spin 0.7s linear infinite", flexShrink: 0 }} />
      ) : isDone ? (
        <CheckCircleIcon size={12} weight="fill" style={{ color: "#059669", flexShrink: 0 }} />
      ) : (
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--launch-border-strong)", display: "inline-block", flexShrink: 0 }} />
      )}
      <span style={{
        fontSize: 11,
        fontWeight: 500,
        color: isRunning ? "#2563eb" : isDone ? "#059669" : "var(--launch-label)",
        whiteSpace: "nowrap",
      }}>
        {stage}
      </span>
    </div>
  );
}

function ConnectorDot({ done }: { done: boolean }) {
  return (
    <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
      {[0, 1, 2].map((i) => (
        <span key={i} style={{ width: 3, height: 3, borderRadius: "50%", background: done ? "rgba(5,150,105,0.4)" : "var(--launch-border)", display: "inline-block" }} />
      ))}
    </div>
  );
}

export function GeneratingLog({ stages, logLines, errorMessage }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logLines]);

  const getStageStatus = (id: string): "pending" | "running" | "done" | "error" => {
    return stages.find((s) => s.id === id)?.status ?? "pending";
  };

  const currentStageLabel = SCRIPT_STAGES.find(
    (s) => getStageStatus(s.id) === "running",
  )?.label ?? (getStageStatus("script") === "done" ? "Complete" : "Starting…");

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 4 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        style={{
          borderRadius: 12,
          border: "1px solid var(--launch-border)",
          background: "var(--launch-panel)",
          overflow: "hidden",
          boxShadow: "0 1px 8px rgba(0,0,0,0.04)",
        }}
      >
        {/* Stage pills row */}
        <div style={{
          padding: "10px 14px 10px",
          borderBottom: "1px solid var(--launch-border)",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}>
          {SCRIPT_STAGES.map((s, i) => (
            <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <StagePill stage={s.label} status={getStageStatus(s.id)} />
              {i < SCRIPT_STAGES.length - 1 && (
                <ConnectorDot done={getStageStatus(s.id) === "done"} />
              )}
            </div>
          ))}
          <span style={{
            marginLeft: "auto",
            fontSize: 10,
            color: "var(--launch-label)",
            fontStyle: "italic",
            animation: "pulse 2s ease-in-out infinite",
          }}>
            {currentStageLabel}
          </span>
        </div>

        {/* Log text area */}
        <div
          ref={scrollRef}
          style={{
            height: 160,
            overflowY: "auto",
            padding: "10px 14px",
            display: "flex",
            flexDirection: "column",
            gap: 1,
          }}
        >
          {logLines.length === 0 && !errorMessage ? (
            <span style={{ fontSize: 12, color: "var(--launch-label)", fontStyle: "italic", fontFamily: "monospace" }}>
              Initialising…
            </span>
          ) : (
            logLines.map((line, i) => {
              const isLast = i === logLines.length - 1 && !errorMessage;
              return (
                <div key={i} style={{
                  fontSize: 11.5,
                  lineHeight: 1.6,
                  color: isLast ? "var(--launch-text)" : "var(--launch-text-muted)",
                  fontFamily: "'Roboto Mono', 'SF Mono', 'Fira Code', monospace",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  transition: "color 0.3s",
                }}>
                  {line}
                  {isLast && (
                    <span style={{
                      display: "inline-block",
                      width: 6,
                      height: 13,
                      background: "var(--launch-accent)",
                      borderRadius: 1,
                      verticalAlign: "text-bottom",
                      marginLeft: 2,
                      animation: "blink 1.1s step-end infinite",
                    }} />
                  )}
                </div>
              );
            })
          )}

          {errorMessage && (
            <div style={{
              marginTop: logLines.length ? 8 : 0,
              padding: "8px 10px",
              borderRadius: 8,
              background: "rgba(220,38,38,0.06)",
              border: "1px solid rgba(220,38,38,0.2)",
              display: "flex",
              alignItems: "flex-start",
              gap: 7,
            }}>
              <WarningCircleIcon size={14} weight="fill" style={{ color: "#dc2626", flexShrink: 0, marginTop: 1 }} />
              <span style={{
                fontSize: 11.5,
                lineHeight: 1.5,
                color: "#991b1b",
                fontFamily: "'Roboto Mono', 'SF Mono', monospace",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}>
                {errorMessage}
              </span>
            </div>
          )}
        </div>

        {/* Subtle gradient fade at bottom */}
        <div style={{
          height: 20,
          marginTop: -20,
          background: "linear-gradient(transparent, var(--launch-panel))",
          pointerEvents: "none",
          position: "relative",
          zIndex: 1,
        }} />
      </motion.div>
    </AnimatePresence>
  );
}
