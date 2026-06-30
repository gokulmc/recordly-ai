import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import { MagicWandIcon, XIcon } from "@phosphor-icons/react";
import { useAutoZoomStore } from "./useAutoZoomStore";
import { Step1Record } from "./steps/Step1Record";
import { Step2Understand } from "./steps/Step2Understand";
import { Step3Generate } from "./steps/Step3Generate";
import type { AutoZoomProgress } from "./useAutoZoomStore";
import styles from "@/components/launch/LaunchWindow.module.css";
import "@/components/launch/launchTheme.css";

const KEYFRAMES = `
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: 0; } }
`;
if (typeof document !== "undefined" && !document.getElementById("__auto-zoom-kf")) {
  const s = document.createElement("style");
  s.id = "__auto-zoom-kf";
  s.textContent = KEYFRAMES;
  document.head.appendChild(s);
}

const SLIDE_VARIANTS = {
  enter: (dir: number) => ({ x: dir > 0 ? 30 : -30, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (dir: number) => ({ x: dir > 0 ? -30 : 30, opacity: 0 }),
};

export function AutoZoomWindow() {
  const store = useAutoZoomStore();
  const {
    step, setStep,
    videoPath, setVideoPath,
    cursorPath, setCursorPath,
    analysis,
    progresses, pushProgress,
    enableCaptions, setEnableCaptions,
    enableAudio, setEnableAudio,
    projectPath,
    error,
  } = store;

  const prevStepRef = useRef(step);
  const dir = step > prevStepRef.current ? 1 : -1;
  useEffect(() => { prevStepRef.current = step; }, [step]);

  // Subscribe to backend progress events
  useEffect(() => {
    const cleanup = window.electronAPI?.onAutoZoomProgress?.((progress: AutoZoomProgress) => {
      pushProgress(progress);
    });
    return () => cleanup?.();
  }, [pushProgress]);

  function handleRecordingComplete(vPath: string, cPath: string) {
    setVideoPath(vPath);
    setCursorPath(cPath);
    setStep(2);
  }

  async function handleGenerate() {
    setStep(3);
    await window.electronAPI?.autoZoomGenerate?.({ enableCaptions, enableAudio });
  }

  async function handleOpenProject() {
    if (!projectPath) return;
    await window.electronAPI?.openProjectFileAtPath?.(projectPath);
    await window.electronAPI?.switchToEditor?.();
  }

  async function handleCancel() {
    await window.electronAPI?.autoZoomCancel?.();
    window.close();
  }

  return (
    <div
      style={{
        width: "100vw", height: "100vh",
        display: "flex", flexDirection: "column",
        background: "var(--launch-bg, #18181b)",
        color: "var(--launch-text, #f4f4f5)",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        overflow: "hidden",
        borderRadius: 10,
        userSelect: "none",
      }}
    >
      {/* Title bar */}
      <div
        className={styles.electronDrag}
        style={{
          height: 36, flexShrink: 0,
          display: "flex", alignItems: "center", paddingLeft: 80, paddingRight: 12,
          borderBottom: "1px solid var(--launch-border, rgba(255,255,255,0.08))",
          position: "relative",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, position: "absolute", left: "50%", transform: "translateX(-50%)" }}>
          <MagicWandIcon size={14} style={{ color: "#6366f1" }} />
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--launch-text)" }}>Auto Zoom</span>
        </div>
        <button
          className={styles.electronNoDrag}
          onClick={() => void handleCancel()}
          style={{
            marginLeft: "auto", padding: "4px", borderRadius: 5, border: "none",
            background: "transparent", color: "var(--launch-label)", cursor: "pointer",
            display: "flex", alignItems: "center",
          }}
        >
          <XIcon size={13} />
        </button>
      </div>

      {/* Step content */}
      <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
        <AnimatePresence custom={dir} mode="wait">
          {step === 1 && (
            <motion.div
              key="step1"
              custom={dir}
              variants={SLIDE_VARIANTS}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.18, ease: "easeOut" }}
              style={{ position: "absolute", inset: 0 }}
            >
              <Step1Record
                onRecordingComplete={handleRecordingComplete}
              />
            </motion.div>
          )}
          {step === 2 && (
            <motion.div
              key="step2"
              custom={dir}
              variants={SLIDE_VARIANTS}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.18, ease: "easeOut" }}
              style={{ position: "absolute", inset: 0 }}
            >
              <Step2Understand
                videoPath={videoPath}
                cursorPath={cursorPath}
                progresses={progresses.filter((p) => ["frames", "understanding"].includes(p.stage))}
                analysis={analysis}
                enableCaptions={enableCaptions}
                setEnableCaptions={setEnableCaptions}
                enableAudio={enableAudio}
                setEnableAudio={setEnableAudio}
                onGenerate={() => void handleGenerate()}
              />
            </motion.div>
          )}
          {step === 3 && (
            <motion.div
              key="step3"
              custom={dir}
              variants={SLIDE_VARIANTS}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.18, ease: "easeOut" }}
              style={{ position: "absolute", inset: 0 }}
            >
              <Step3Generate
                progresses={progresses.filter((p) => ["zooms", "captions", "audio", "assemble"].includes(p.stage))}
                projectPath={projectPath}
                error={error}
                onOpenProject={() => void handleOpenProject()}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
