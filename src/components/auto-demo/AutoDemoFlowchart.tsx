import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { CaretRightIcon, CaretDownIcon, ArrowDownIcon } from "@phosphor-icons/react";
import type { AppFeatureMap, DemoStep, RecordingScript } from "./useAutoDemoStore";

// ── Importance badge ──────────────────────────────────────────────────────────

function importanceBadge(n: number): { label: string; bg: string; color: string } {
  if (n >= 5) return { label: "Critical", bg: "rgba(239,68,68,0.1)", color: "#dc2626" };
  if (n >= 4) return { label: "High", bg: "rgba(249,115,22,0.1)", color: "#ea580c" };
  if (n >= 3) return { label: "Med", bg: "rgba(234,179,8,0.1)", color: "#ca8a04" };
  return { label: "Low", bg: "var(--launch-hover)", color: "var(--launch-label)" };
}

function actionColor(action: string): { bg: string; color: string } {
  const map: Record<string, { bg: string; color: string }> = {
    navigate: { bg: "rgba(37,99,235,0.08)", color: "#2563eb" },
    click: { bg: "rgba(139,92,246,0.08)", color: "#7c3aed" },
    fill: { bg: "rgba(16,185,129,0.08)", color: "#059669" },
    type: { bg: "rgba(16,185,129,0.08)", color: "#059669" },
    hover: { bg: "rgba(234,179,8,0.08)", color: "#ca8a04" },
    scroll: { bg: "var(--launch-hover)", color: "var(--launch-label)" },
    wait: { bg: "var(--launch-hover)", color: "var(--launch-label)" },
    keypress: { bg: "rgba(236,72,153,0.08)", color: "#db2777" },
  };
  return map[action] ?? { bg: "var(--launch-hover)", color: "var(--launch-label)" };
}

// ── Suggested-flow step (per feature) ─────────────────────────────────────────

function FlowStep({ text, index }: { text: string; index: number }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "4px 0" }}>
      <span style={{
        fontSize: 11, fontWeight: 600, color: "var(--launch-accent)", minWidth: 18, flexShrink: 0,
        fontVariantNumeric: "tabular-nums", lineHeight: "18px",
      }}>{index + 1}.</span>
      <span style={{ fontSize: 13, color: "var(--launch-text-muted)", lineHeight: 1.45, flex: 1 }}>{text}</span>
    </div>
  );
}

// ── Feature node (top-down) ───────────────────────────────────────────────────

function FeatureNode({
  feature,
  isExpanded,
  onClick,
}: {
  feature: AppFeatureMap["features"][0];
  isExpanded: boolean;
  onClick: () => void;
}) {
  const badge = importanceBadge(feature.importance);
  const flow = feature.suggestedFlow ?? [];
  return (
    <div style={{ display: "flex", flexDirection: "column", width: "100%" }}>
      <button
        type="button"
        onClick={onClick}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "10px 12px",
          borderRadius: 10,
          border: `1px solid ${isExpanded ? "rgba(37,99,235,0.35)" : "var(--launch-border)"}`,
          background: isExpanded ? "rgba(37,99,235,0.06)" : "var(--launch-panel)",
          cursor: "pointer",
          textAlign: "left",
          width: "100%",
          transition: "all 0.12s",
        }}
      >
        <span style={{ fontSize: 20, lineHeight: 1, flexShrink: 0 }}>{feature.emoji ?? "▫️"}</span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--launch-text)", lineHeight: 1.3, display: "block" }}>
            {feature.name}
          </span>
          <span style={{ fontSize: 11, color: "var(--launch-label)", lineHeight: 1.3, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {feature.description}
          </span>
        </div>
        <span style={{ fontSize: 10, fontWeight: 600, borderRadius: 4, padding: "2px 6px", flexShrink: 0, background: badge.bg, color: badge.color }}>
          {badge.label}
        </span>
        {isExpanded
          ? <CaretDownIcon size={13} style={{ color: "var(--launch-accent)", flexShrink: 0 }} weight="bold" />
          : <CaretRightIcon size={13} style={{ color: "var(--launch-label)", flexShrink: 0 }} weight="bold" />
        }
      </button>

      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.15 }}
            style={{ overflow: "hidden", marginTop: 5, borderRadius: 9, border: "1px solid var(--launch-border)", background: "var(--launch-surface)", padding: "6px 12px" }}
          >
            {flow.length === 0
              ? <span style={{ fontSize: 12, color: "var(--launch-label)" }}>No steps suggested</span>
              : flow.map((s, i) => <FlowStep key={i} text={s} index={i} />)
            }
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── List view (flat recording script) ─────────────────────────────────────────

function StepItem({ step, index }: { step: DemoStep; index: number }) {
  const { bg, color } = actionColor(step.action);
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 7, padding: "4px 0" }}>
      <span style={{ fontSize: 12, color: "var(--launch-label)", minWidth: 16, flexShrink: 0, fontVariantNumeric: "tabular-nums", lineHeight: "18px" }}>{index + 1}</span>
      <span style={{ fontSize: 12, fontWeight: 600, borderRadius: 4, padding: "1px 5px", flexShrink: 0, background: bg, color, lineHeight: "18px" }}>
        {step.action}
      </span>
      <span style={{ fontSize: 13, color: "var(--launch-text-muted)", lineHeight: 1.45, flex: 1 }}>
        {step.narration ?? step.url ?? step.selector ?? step.value ?? ""}
      </span>
    </div>
  );
}

function ListView({ script }: { script: RecordingScript }) {
  return (
    <div style={{ overflowY: "auto", maxHeight: 280, padding: "2px 0" }}>
      {script.steps.map((step, i) => <StepItem key={i} step={step} index={i} />)}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  featureMap: AppFeatureMap;
  script: RecordingScript;
}

export function AutoDemoFlowchart({ featureMap, script }: Props) {
  const [expandedFeature, setExpandedFeature] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"flow" | "list">("flow");

  // Detect a leading sign-in sequence (deterministic login prepended to the
  // script) and surface it as a node so the user sees login IS in the flow.
  const loginSteps = script.steps.filter(
    (s) => /password|email|username/i.test(s.selector ?? "") || /sign(ing)?\s*in|log(ging)?\s*in/i.test(s.narration ?? ""),
  );
  const hasLogin = script.steps.some((s) => /password/i.test(s.selector ?? ""));

  // Synthetic feature node for the sign-in step.
  const loginNode: AppFeatureMap["features"][0] | null = hasLogin
    ? {
        name: "Sign in",
        emoji: "🔐",
        description: "Authenticate before demoing the app",
        entryPath: "/login",
        importance: 5,
        suggestedFlow: loginSteps.map((s) => s.narration ?? s.action),
      }
    : null;

  const flowNodes = loginNode ? [loginNode, ...featureMap.features] : featureMap.features;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {/* Toggle + meta */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 12, color: "var(--launch-label)" }}>
          {featureMap.features.length} features · {script.steps.length} steps
        </span>
        <div style={{ display: "flex", borderRadius: 7, border: "1px solid var(--launch-border)", overflow: "hidden" }}>
          {(["flow", "list"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setViewMode(mode)}
              style={{
                padding: "3px 10px",
                fontSize: 12,
                fontWeight: 500,
                border: "none",
                cursor: "pointer",
                background: viewMode === mode ? "var(--launch-selected)" : "transparent",
                color: viewMode === mode ? "var(--launch-accent)" : "var(--launch-label)",
                transition: "all 0.1s",
              }}
            >
              {mode === "flow" ? "Flow" : "List"}
            </button>
          ))}
        </div>
      </div>

      <AnimatePresence mode="wait">
        {viewMode === "flow" ? (
          <motion.div key="flow" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.1 }}>
            {/* Top-down vertical flow */}
            <div style={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: 0 }}>
              {flowNodes.map((feature, idx) => (
                <div key={feature.name} style={{ display: "flex", flexDirection: "column", alignItems: "stretch" }}>
                  <FeatureNode
                    feature={feature}
                    isExpanded={expandedFeature === feature.name}
                    onClick={() => setExpandedFeature(expandedFeature === feature.name ? null : feature.name)}
                  />
                  {idx < flowNodes.length - 1 && (
                    <div style={{ display: "flex", justifyContent: "center", padding: "3px 0" }}>
                      <ArrowDownIcon size={14} style={{ color: "var(--launch-border-strong)" }} weight="bold" />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </motion.div>
        ) : (
          <motion.div key="list" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.1 }}>
            <ListView script={script} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
