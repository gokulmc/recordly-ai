import { useEffect, useState } from "react";
import { CheckIcon, PencilSimpleIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";

interface Props {
  videoPath: string;
}

export function VideoReviewWindow({ videoPath }: Props) {
  const [localSrc, setLocalSrc] = useState("");
  const [zoom, setZoom] = useState(3);
  useEffect(() => {
    if (!videoPath) return;
    void window.electronAPI?.getLocalMediaUrl?.(videoPath).then((res) => {
      if (res?.success) setLocalSrc(res.url);
    });
  }, [videoPath]);

  const decide = (decision: "approve" | "modify") => {
    window.electronAPI?.sendVideoReviewDecision?.(decision, decision === "approve" ? zoom : undefined);
  };

  const ZOOM_LABELS = ["Minimal", "Subtle", "Balanced", "Punchy", "Aggressive"];

  return (
    <div
      className="w-screen h-screen flex flex-col items-center justify-center"
      style={{ background: "rgba(0,0,0,0.82)", backdropFilter: "blur(4px)" }}
      onClick={() => decide("modify")}
    >
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        src={localSrc}
        autoPlay
        loop
        muted
        playsInline
        style={{ width: "75vw", height: "75vh", objectFit: "contain", borderRadius: 12, boxShadow: "0 32px 96px rgba(0,0,0,0.7)" }}
        onClick={(e) => e.stopPropagation()}
      />

      {/* Zoom density control */}
      <div
        className="mt-5 flex flex-col items-center gap-1.5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 text-white/70 text-xs">
          <span>Zoom density</span>
          <span className="text-white/90 font-medium tabular-nums">{ZOOM_LABELS[zoom - 1]}</span>
        </div>
        <input
          type="range"
          min={1}
          max={5}
          step={1}
          value={zoom}
          onChange={(e) => setZoom(Number(e.target.value))}
          className="zoom-density-slider w-72"
          aria-label="Zoom density"
        />
        <div className="flex justify-between w-72 text-[10px] text-white/40">
          <span>Subtle</span>
          <span>Aggressive</span>
        </div>
      </div>

      <div
        className="flex gap-3 mt-4"
        onClick={(e) => e.stopPropagation()}
      >
        <Button
          onClick={() => decide("modify")}
          variant="outline"
          className="h-9 px-5 border-white/20 bg-white/5 text-white/80 hover:bg-white/10 hover:text-white backdrop-blur-sm"
        >
          <PencilSimpleIcon className="w-4 h-4 mr-1.5" weight="bold" />
          Modify Script
        </Button>
        <Button
          onClick={() => decide("approve")}
          className="h-9 px-5 bg-green-600 hover:bg-green-500 text-white shadow-lg shadow-green-900/40"
        >
          <CheckIcon className="w-4 h-4 mr-1.5" weight="bold" />
          Approve → Full Render
        </Button>
      </div>

      <p className="mt-3 text-xs text-white/30">Click outside the video to modify</p>
    </div>
  );
}
