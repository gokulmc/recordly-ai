import { useEffect, useState } from "react";
import { CheckIcon, PencilSimpleIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";

interface Props {
  videoPath: string;
}

export function VideoReviewWindow({ videoPath }: Props) {
  const [localSrc, setLocalSrc] = useState("");
  useEffect(() => {
    if (!videoPath) return;
    void window.electronAPI?.getLocalMediaUrl?.(videoPath).then((res) => {
      if (res?.success) setLocalSrc(res.url);
    });
  }, [videoPath]);

  const decide = (decision: "approve" | "modify") => {
    window.electronAPI?.sendVideoReviewDecision?.(decision);
  };

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

      <div
        className="flex gap-3 mt-6"
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
