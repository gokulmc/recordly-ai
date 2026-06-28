import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { CaretRightIcon, CaretDownIcon, ArrowRightIcon } from "@phosphor-icons/react";
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

// ── Step item ─────────────────────────────────────────────────────────────────

function StepItem({ step, index }: { step: DemoStep; index: number }) {
  const { bg, color } = actionColor(step.action);
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 6, padding: "4px 0" }}>
      <span style={{ fontSize: 10, color: "var(--launch-label)", minWidth: 16, flexShrink: 0, fontVariantNumeric: "tabular-nums", lineHeight: "17px" }}>{index + 1}</span>
      <span style={{ fontSize: 10, fontWeight: 600, borderRadius: 4, padding: "1px 5px", flexShrink: 0, background: bg, color, lineHeight: "17px" }}>
        {step.action}
      </span>
      <span style={{ fontSize: 11, color: "var(--launch-text-muted)", lineHeight: 1.45, flex: 1 }}>
        {step.narration ?? step.url ?? step.selector ?? step.value ?? ""}
      </span>
    </div>
  );
}

// ── Feature node ──────────────────────────────────────────────────────────────

function FeatureNode({
  feature,
  steps,
  isExpanded,
  onClick,
}: {
  feature: AppFeatureMap["features"][0];
  steps: DemoStep[];
  isExpanded: boolean;
  onClick: () => void;
}) {
  const badge = importanceBadge(feature.importance);
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <button
        type="button"
        onClick={onClick}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 4,
          padding: "8px 10px",
          borderRadius: 9,
          border: `1px solid ${isExpanded ? "rgba(37,99,235,0.35)" : "var(--launch-border)"}`,
          background: isExpanded ? "rgba(37,99,235,0.06)" : "var(--launch-panel)",
          cursor: "pointer",
          textAlign: "left",
          minWidth: 88,
          transition: "all 0.12s",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {isExpanded
            ? <CaretDownIcon size={11} style={{ color: "var(--launch-accent)", flexShrink: 0 }} weight="bold" />
            : <CaretRightIcon size={11} style={{ color: "var(--launch-label)", flexShrink: 0 }} weight="bold" />
          }
          <span style={{ fontSize: 11, fontWeight: 600, color: "var(--launch-text)", lineHeight: 1.3 }}>{feature.name}</span>
        </div>
        <span style={{ fontSize: 9, fontWeight: 600, borderRadius: 4, padding: "1px 5px", alignSelf: "flex-start", background: badge.bg, color: badge.color }}>
          {badge.label}
        </span>
      </button>

      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.15 }}
            style={{ overflow: "hidden", marginTop: 4, borderRadius: 8, border: "1px solid var(--launch-border)", background: "var(--launch-surface)", padding: "4px 8px" }}
          >
            {steps.length === 0
              ? <span style={{ fontSize: 11, color: "var(--launch-label)" }}>No steps</span>
              : steps.map((s, i) => <StepItem key={i} step={s} index={i} />)
            }
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Group steps by feature (heuristic) ───────────────────────────────────────

function groupStepsByFeature(features: AppFeatureMap["features"], script: RecordingScript): Map<string, DemoStep[]> {
  const map = new Map<string, DemoStep[]>(features.map((f) => [f.name, []]));
  const names = features.map((f) => f.name.toLowerCase());
  let currentFeature = names[0] ?? "";
  for (const step of script.steps) {
    const narration = (step.narration ?? "").toLowerCase();
    for (let i = 0; i < names.length; i++) {
      if (narration.includes(names[i]!)) { currentFeature = names[i]!; break; }
    }
    const featureName = features.find((f) => f.name.toLowerCase() === currentFeature)?.name ?? features[0]?.name ?? "";
    map.get(featureName)?.push(step);
  }
  return map;
}

// ── List view ─────────────────────────────────────────────────────────────────

function ListView({ script }: { script: RecordingScript }) {
  return (
    <div style={{ overflowY: "auto", maxHeight: 200, padding: "2px 0" }}>
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
  const stepsByFeature = groupStepsByFeature(featureMap.features, script);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {/* Toggle + meta */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 10, color: "var(--launch-label)" }}>
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
                fontSize: 11,
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
            <div style={{ overflowX: "auto", paddingBottom: 4 }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 6, minWidth: "max-content" }}>
                {featureMap.features.map((feature, idx) => (
                  <div key={feature.name} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <FeatureNode
                      feature={feature}
                      steps={stepsByFeature.get(feature.name) ?? []}
                      isExpanded={expandedFeature === feature.name}
                      onClick={() => setExpandedFeature(expandedFeature === feature.name ? null : feature.name)}
                    />
                    {idx < featureMap.features.length - 1 && (
                      <ArrowRightIcon size={11} style={{ color: "var(--launch-border-strong)", flexShrink: 0, marginTop: 16 }} weight="bold" />
                    )}
                  </div>
                ))}
              </div>
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
