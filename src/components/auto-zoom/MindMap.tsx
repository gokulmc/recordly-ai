import type { AutoZoomAnalysis, AutoZoomFeature } from "./useAutoZoomStore";

interface Props {
  analysis: AutoZoomAnalysis;
}

function formatMs(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function FeatureNode({ feature, index }: { feature: AutoZoomFeature; index: number }) {
  const colors = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#ec4899", "#8b5cf6"];
  const color = colors[index % colors.length];

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "8px 12px",
        borderRadius: 8,
        border: `1.5px solid ${color}40`,
        background: `${color}10`,
        minWidth: 140,
        maxWidth: 180,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span
          style={{
            width: 8, height: 8, borderRadius: "50%",
            background: color, flexShrink: 0,
          }}
        />
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--launch-text)", lineHeight: 1.3 }}>
          {feature.name}
        </span>
      </div>
      <span style={{ fontSize: 10, color: "var(--launch-label)" }}>
        {formatMs(feature.startMs)} – {formatMs(feature.endMs)}
      </span>
      {feature.interactions.map((int, i) => (
        <div
          key={i}
          style={{
            fontSize: 10,
            color: "var(--launch-label-dim, #9ca3af)",
            paddingLeft: 14,
            borderLeft: `1.5px solid ${color}30`,
          }}
        >
          {formatMs(int.timeMs)} · {int.label}
        </div>
      ))}
    </div>
  );
}

export function MindMap({ analysis }: Props) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {/* Root */}
      <div
        style={{
          padding: "6px 12px",
          borderRadius: 8,
          background: "var(--launch-accent, #6366f1)",
          color: "#fff",
          fontWeight: 600,
          fontSize: 13,
          alignSelf: "flex-start",
        }}
      >
        {analysis.appName}
        {analysis.appCategory ? (
          <span style={{ fontWeight: 400, fontSize: 10, marginLeft: 6, opacity: 0.8 }}>
            {analysis.appCategory}
          </span>
        ) : null}
      </div>

      {/* Feature grid */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          paddingLeft: 16,
          borderLeft: "2px solid var(--launch-border)",
          marginLeft: 6,
        }}
      >
        {analysis.features.map((f, i) => (
          <FeatureNode key={i} feature={f} index={i} />
        ))}
      </div>
    </div>
  );
}
