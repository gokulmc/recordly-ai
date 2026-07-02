import { useState } from "react";
import { MagicWandIcon, CircleNotchIcon, CaretDownIcon, CaretUpIcon } from "@phosphor-icons/react";
import type { AutoZoomAnalysis } from "@/components/auto-zoom/useAutoZoomStore";
import type { ZoomRegion } from "./types";

interface Props {
  analysis: AutoZoomAnalysis;
  zoomRegions: ZoomRegion[];
  onZoomRegionsUpdate: (regions: ZoomRegion[]) => void;
}

export function AutoZoomPanel({ analysis, zoomRegions, onZoomRegionsUpdate }: Props) {
  const [query, setQuery] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [lastMessage, setLastMessage] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(true);

  async function handleSubmit() {
    if (!query.trim() || isLoading) return;
    setIsLoading(true);
    setLastMessage(null);
    try {
      const result = await window.electronAPI?.autoZoomRefineRegions?.({
        query: query.trim(),
        zoomRegions,
      });
      if (result?.success && result.zoomRegions) {
        onZoomRegionsUpdate(result.zoomRegions as ZoomRegion[]);
        setLastMessage(result.message ?? "Updated");
      } else if (result?.error) {
        setLastMessage(`Error: ${result.error}`);
      }
    } catch (err) {
      setLastMessage(String(err));
    } finally {
      setIsLoading(false);
      setQuery("");
    }
  }

  return (
    <div
      style={{
        borderTop: "1px solid var(--editor-border, rgba(255,255,255,0.08))",
        background: "var(--editor-bg-raised, rgba(255,255,255,0.02))",
        flexShrink: 0,
      }}
    >
      {/* Collapsed toggle */}
      <button
        onClick={() => setIsExpanded((v) => !v)}
        style={{
          width: "100%",
          display: "flex", alignItems: "center", gap: 6, padding: "6px 12px",
          background: "transparent", border: "none", cursor: "pointer",
          color: "var(--foreground-muted, rgba(255,255,255,0.5))",
          fontSize: 11, fontWeight: 500,
        }}
      >
        <MagicWandIcon size={12} style={{ color: "#6366f1", flexShrink: 0 }} />
        <span style={{ color: "#6366f1", fontWeight: 600 }}>Auto Zoom</span>
        <span style={{ flex: 1, textAlign: "left" }}>
          {analysis.appName ?? "App"} · {analysis.features?.length ?? 0} features · {zoomRegions.length} zoom regions
        </span>
        {isExpanded ? <CaretDownIcon size={12} /> : <CaretUpIcon size={12} />}
      </button>

      {isExpanded && (
        <div style={{ padding: "0 12px 8px", display: "flex", flexDirection: "column", gap: 6 }}>
          {/* Query input */}
          <div style={{ display: "flex", gap: 6 }}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleSubmit(); }
              }}
              placeholder='e.g. "more zoom on the login section" or "remove zooms after 1:30"'
              disabled={isLoading}
              style={{
                flex: 1, padding: "5px 10px", borderRadius: 7,
                border: "1px solid var(--editor-border, rgba(255,255,255,0.12))",
                background: "var(--editor-surface, rgba(255,255,255,0.05))",
                color: "var(--foreground, #f4f4f5)", fontSize: 12, outline: "none",
              }}
            />
            <button
              onClick={() => void handleSubmit()}
              disabled={!query.trim() || isLoading}
              style={{
                display: "flex", alignItems: "center", gap: 4,
                padding: "5px 12px", borderRadius: 7, border: "none",
                background: "#6366f1", color: "#fff",
                fontSize: 12, fontWeight: 600, cursor: query.trim() && !isLoading ? "pointer" : "not-allowed",
                opacity: query.trim() && !isLoading ? 1 : 0.5, flexShrink: 0,
              }}
            >
              {isLoading ? <CircleNotchIcon size={13} weight="bold" style={{ animation: "spin 0.7s linear infinite" }} /> : "Apply"}
            </button>
          </div>
          {lastMessage && (
            <div style={{ fontSize: 11, color: lastMessage.startsWith("Error") ? "#ef4444" : "#6366f1", paddingLeft: 2 }}>
              {lastMessage}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
