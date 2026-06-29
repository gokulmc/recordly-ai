import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useAutoDemoStore, initialStages } from "./useAutoDemoStore";
import { Step1Inputs } from "./steps/Step1Inputs";
import { Step2Script } from "./steps/Step2Script";
import { Step3Progress } from "./steps/Step3Progress";
import styles from "@/components/launch/LaunchWindow.module.css";
import "@/components/launch/launchTheme.css";

// Inject keyframe animations into document once
const KEYFRAMES = `
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: 0; } }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.45; } }
`;
if (typeof document !== "undefined" && !document.getElementById("__auto-demo-kf")) {
  const s = document.createElement("style");
  s.id = "__auto-demo-kf";
  s.textContent = KEYFRAMES;
  document.head.appendChild(s);
}

const SLIDE_VARIANTS = {
  enter: (dir: number) => ({ x: dir > 0 ? 30 : -30, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (dir: number) => ({ x: dir > 0 ? -30 : 30, opacity: 0 }),
};

export function AutoDemoWindow() {
  const store = useAutoDemoStore();
  const [autoExpandAuth, setAutoExpandAuth] = useState(false);
  const {
    step, setStep,
    formValues, updateFormField,
    repoStatus, setRepoStatus,
    githubPat, setGithubPat,
    featureMap, script,
    stages, setStages, errorMessage, setErrorMessage, projectPath,
    isGenerating, setIsGenerating,
    isRecording, setIsRecording,
    isRendering, setIsRendering,
    savedConfigs, loadConfig, deleteConfig, saveConfig,
    reset,
    rawVideoPath, traceJsonPath,
    logLines, setLogLines,
  } = store;

  // ── Step 1: generate script ───────────────────────────────────────────────

  const handleGenerate = async () => {
    setErrorMessage(null);
    setLogLines([]);
    setStages(initialStages());
    setIsGenerating(true);
    saveConfig(formValues);
    try {
      await window.electronAPI?.autoDemoGenerateScript?.({
        repoUrl: formValues.repoUrl.trim(),
        productionUrl: formValues.productionUrl.trim(),
        authEmail: formValues.authEmail.trim() || undefined,
        authPassword: formValues.authPassword || undefined,
        githubToken: githubPat.trim() || undefined,
        focusArea: formValues.query.trim() || undefined,
      });
    } catch (err) {
      setIsGenerating(false);
      console.error("[AutoDemoWindow] generate-script failed:", err);
    }
  };

  // ── Step 2: approve & record ──────────────────────────────────────────────

  const handleApproveAndRecord = async () => {
    if (!script) return;
    setIsRecording(true);
    setStep(3);
    try {
      await window.electronAPI?.autoDemoRecord?.({
        scriptJson: JSON.stringify(script),
        authStatePath: featureMap?.authStatePath,
      });
    } catch (err) {
      setIsRecording(false);
      console.error("[AutoDemoWindow] record failed:", err);
    }
  };

  // ── Open video review window when rawVideoPath arrives ────────────────────

  const lastReviewedPath = useRef("");
  useEffect(() => {
    if (rawVideoPath && rawVideoPath !== lastReviewedPath.current) {
      lastReviewedPath.current = rawVideoPath;
      void window.electronAPI?.openVideoReview?.(rawVideoPath);
    }
  }, [rawVideoPath]);

  // ── Trigger render phase when user approves the video ─────────────────────

  const hasStartedRender = useRef(false);
  useEffect(() => {
    if (isRendering && rawVideoPath && traceJsonPath && !hasStartedRender.current) {
      hasStartedRender.current = true;
      void window.electronAPI?.autoDemoRender?.({
        videoPath: rawVideoPath,
        traceJsonPath,
        productionUrl: formValues.productionUrl.trim() || undefined,
        zoomAggressiveness: store.zoomAggressiveness,
      }).catch((err: unknown) => {
        console.error("[AutoDemoWindow] render failed:", err);
        setIsRendering(false);
      });
    }
    if (!isRendering) hasStartedRender.current = false;
  }, [isRendering, rawVideoPath, traceJsonPath]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Step 2: regenerate ────────────────────────────────────────────────────

  const handleRegenerate = async (refinement: string) => {
    setIsGenerating(true);
    try {
      await window.electronAPI?.autoDemoGenerateScript?.({
        repoUrl: formValues.repoUrl.trim(),
        productionUrl: formValues.productionUrl.trim(),
        authEmail: formValues.authEmail.trim() || undefined,
        authPassword: formValues.authPassword || undefined,
        githubToken: githubPat.trim() || undefined,
        focusArea: `${formValues.query.trim()} ${refinement}`.trim() || undefined,
      });
    } catch (err) {
      setIsGenerating(false);
      console.error("[AutoDemoWindow] regenerate failed:", err);
    }
  };

  const handleCancel = async () => {
    await window.electronAPI?.autoDemoCancel?.();
    reset();
  };

  const handleOpenProject = async () => {
    if (!projectPath) return;
    const result = await window.electronAPI?.openProjectFileAtPath?.(projectPath);
    if (result?.success) {
      await window.electronAPI?.switchToEditor?.();
    } else {
      console.error("[AutoDemoWindow] open project failed:", result?.message);
    }
  };

  const isRunning = isGenerating || isRecording || isRendering;
  const slideDir = step >= 2 ? 1 : -1;

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
              style={{ flex: 1, overflowY: "auto" }}
            >
              <Step1Inputs
                formValues={formValues}
                updateFormField={updateFormField}
                repoStatus={repoStatus}
                setRepoStatus={setRepoStatus}
                githubPat={githubPat}
                setGithubPat={setGithubPat}
                savedConfigs={savedConfigs}
                onLoadConfig={loadConfig}
                onDeleteConfig={deleteConfig}
                isGenerating={isGenerating}
                onGenerate={() => void handleGenerate()}
                stages={stages}
                logLines={logLines}
                errorMessage={errorMessage}
                autoExpandAuth={autoExpandAuth}
                styles={styles}
              />
            </motion.div>
          )}

          {step === 2 && featureMap && script && (
            <motion.div
              key="step2"
              custom={slideDir}
              variants={SLIDE_VARIANTS}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.18, ease: "easeOut" }}
              style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}
            >
              <Step2Script
                featureMap={featureMap}
                script={script}
                isRecording={isRecording}
                isRegenerating={isGenerating}
                authWarning={Boolean(featureMap?.authNeeded) && !(formValues.authEmail.trim() && formValues.authPassword)}
                onApprove={() => void handleApproveAndRecord()}
                onRegenerate={(r) => void handleRegenerate(r)}
                onBack={() => setStep(1)}
                onAddCredentials={() => { setAutoExpandAuth(true); setStep(1); }}
              />
            </motion.div>
          )}

          {step === 3 && (
            <motion.div
              key="step3"
              custom={1}
              variants={SLIDE_VARIANTS}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.18, ease: "easeOut" }}
              style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}
            >
              <Step3Progress
                stages={stages}
                logLines={logLines}
                errorMessage={errorMessage}
                projectPath={projectPath}
                isRunning={isRunning}
                onCancel={() => void handleCancel()}
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
