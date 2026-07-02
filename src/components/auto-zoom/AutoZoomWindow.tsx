import React, { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
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
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.45; } }
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
    enableAutoCrop, setEnableAutoCrop,
    projectPath,
    error,
  } = store;

  const prevStepRef = useRef(step);
  const slideDir = step > prevStepRef.current ? 1 : -1;
  useEffect(() => { prevStepRef.current = step; }, [step]);

  function handleRecordingComplete(vPath: string, cPath: string) {
    setVideoPath(vPath);
    setCursorPath(cPath);
    setStep(2);
  }

  // Arm capture handoff only while on Step 1 — the next HUD recording to
  // finalize is then handed to Auto Zoom instead of opening the editor.
  useEffect(() => {
    if (step !== 1) return;
    void window.electronAPI?.autoZoomSetArmed?.(true);
    return () => {
      void window.electronAPI?.autoZoomSetArmed?.(false);
    };
  }, [step]);

  // The HUD notifies us here once an armed recording finalizes.
  useEffect(() => {
    const cleanup = window.electronAPI?.onAutoZoomRecordingFinalized?.(({ videoPath: vPath, cursorPath: cPath }) => {
      handleRecordingComplete(vPath, cPath);
    });
    return () => cleanup?.();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Subscribe to backend progress events
  useEffect(() => {
    const cleanup = window.electronAPI?.onAutoZoomProgress?.((progress: AutoZoomProgress) => {
      pushProgress(progress);
    });
    return () => cleanup?.();
  }, [pushProgress]);

  async function handleGenerate() {
    setStep(3);
    await window.electronAPI?.autoZoomGenerate?.({ enableCaptions, enableAudio, enableAutoCrop });
  }

  async function handleOpenProject() {
    if (!projectPath) return;
    const result = await window.electronAPI?.openProjectFileAtPath?.(projectPath);
    if (result?.success) {
      await window.electronAPI?.switchToEditor?.();
    }
  }


  return (
    <div
      className="launch-theme"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        background: "var(--launch-surface)",
        fontFamily: "Roboto, SF Pro Display, Helvetica, sans-serif",
        fontSize: 14,
        color: "var(--launch-text)",
        userSelect: "none",
        overflow: "hidden",
      }}
    >
      {/* macOS traffic-light drag region */}
      <div style={{ height: 44, WebkitAppRegion: "drag", flexShrink: 0 } as React.CSSProperties} />

      <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <AnimatePresence mode="wait" custom={slideDir}>
          {step === 1 && (
            <motion.div
              key="step1"
              custom={-1}
              variants={SLIDE_VARIANTS}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.18, ease: "easeOut" }}
              style={{ display: "flex", flexDirection: "column", flex: 1, overflowY: "auto" }}
            >
              <StepHeader title="Record your walkthrough" step={1} />
              <Step1Record styles={styles} />
            </motion.div>
          )}

          {step === 2 && (
            <motion.div
              key="step2"
              custom={slideDir}
              variants={SLIDE_VARIANTS}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.18, ease: "easeOut" }}
              style={{ display: "flex", flexDirection: "column", flex: 1, overflowY: "auto" }}
            >
              <StepHeader
                title={analysis ? `Understanding ${analysis.appName}` : "Understanding your app…"}
                step={2}
              />
              <Step2Understand
                videoPath={videoPath}
                cursorPath={cursorPath}
                progresses={progresses.filter((p) => ["frames", "understanding"].includes(p.stage))}
                analysis={analysis}
                enableCaptions={enableCaptions}
                setEnableCaptions={setEnableCaptions}
                enableAudio={enableAudio}
                setEnableAudio={setEnableAudio}
                enableAutoCrop={enableAutoCrop}
                setEnableAutoCrop={setEnableAutoCrop}
                onGenerate={() => void handleGenerate()}
                styles={styles}
              />
            </motion.div>
          )}

          {step === 3 && (
            <motion.div
              key="step3"
              custom={slideDir}
              variants={SLIDE_VARIANTS}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.18, ease: "easeOut" }}
              style={{ display: "flex", flexDirection: "column", flex: 1, overflowY: "auto" }}
            >
              <StepHeader title={projectPath ? "All done!" : "Generating your demo…"} step={3} />
              <Step3Generate
                progresses={progresses.filter((p) => ["zooms", "captions", "audio", "assemble"].includes(p.stage))}
                projectPath={projectPath}
                error={error}
                onOpenProject={() => void handleOpenProject()}
                styles={styles}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function StepHeader({ title, step }: { title: string; step: number }) {
  return (
    <>
      <div style={{ padding: "10px 16px 8px", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        <span style={{ fontSize: 15, fontWeight: 600, color: "var(--launch-text)" }}>{title}</span>
        <span style={{ marginLeft: "auto", fontSize: 13, color: "var(--launch-label)" }}>Step {step} of 3</span>
      </div>
      <div style={{ height: 1, background: "var(--launch-border)", flexShrink: 0 }} />
    </>
  );
}
