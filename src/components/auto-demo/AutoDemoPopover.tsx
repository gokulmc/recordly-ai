import { type ReactElement, useEffect, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import { HudPopover } from "@/components/launch/popovers/PopoverScaffold";
import { useLaunchPopoverCoordinator } from "@/components/launch/popovers/LaunchPopoverCoordinator";
import styles from "@/components/launch/LaunchWindow.module.css";
import { useAutoDemoStore } from "./useAutoDemoStore";
import { Step1Inputs } from "./steps/Step1Inputs";
import { Step2Script } from "./steps/Step2Script";
import { Step3Progress } from "./steps/Step3Progress";

const POPOVER_ID = "auto-demo";

const SLIDE_VARIANTS = {
  enter: (dir: number) => ({ x: dir > 0 ? 30 : -30, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (dir: number) => ({ x: dir > 0 ? -30 : 30, opacity: 0 }),
};

interface Props {
  trigger: ReactElement;
  onRunningChange?: (running: boolean) => void;
}

export function AutoDemoPopover({ trigger, onRunningChange }: Props) {
  const { isOpen, requestOpen, requestClose } = useLaunchPopoverCoordinator();
  const open = isOpen(POPOVER_ID);

  const store = useAutoDemoStore();
  const {
    step, setStep,
    formValues, updateFormField,
    repoStatus, setRepoStatus,
    githubPat, setGithubPat,
    featureMap, script,
    stages,
    errorMessage,
    projectPath,
    isGenerating, setIsGenerating,
    isRecording, setIsRecording,
    isRendering,
    savedConfigs, loadConfig, deleteConfig, saveConfig,
    reset,
    rawVideoPath, traceJsonPath,
    logLines,
  } = store;

  // ── Step 1: Generate script ──────────────────────────────────────────────────

  const handleGenerate = async () => {
    setIsGenerating(true);
    saveConfig(formValues);
    try {
      await window.electronAPI?.autoDemoGenerateScript?.({
        repoUrl: formValues.repoUrl.trim(),
        productionUrl: formValues.productionUrl.trim(),
        authEmail: formValues.authEmail.trim() || undefined,
        authPassword: formValues.authPassword || undefined,
        focusArea: formValues.query.trim() || undefined,
      });
    } catch (err) {
      setIsGenerating(false);
      console.error("[AutoDemoPopover] generate-script failed:", err);
    }
  };

  // ── Step 2: Approve & record ──────────────────────────────────────────────────

  const handleApproveAndRecord = async () => {
    if (!script) return;
    setIsRecording(true);
    setStep(3);
    onRunningChange?.(true);
    try {
      await window.electronAPI?.autoDemoRecord?.({ scriptJson: JSON.stringify(script) });
    } catch (err) {
      setIsRecording(false);
      onRunningChange?.(false);
      console.error("[AutoDemoPopover] record failed:", err);
    }
  };

  // ── Open video review window when rawVideoPath arrives ────────────────────────

  const lastReviewedPath = useRef("");
  useEffect(() => {
    if (rawVideoPath && rawVideoPath !== lastReviewedPath.current) {
      lastReviewedPath.current = rawVideoPath;
      void window.electronAPI?.openVideoReview?.(rawVideoPath);
    }
  }, [rawVideoPath]);

  // ── Trigger render phase when user approves the video review ──────────────────

  const hasStartedRender = useRef(false);
  useEffect(() => {
    if (isRendering && rawVideoPath && traceJsonPath && !hasStartedRender.current) {
      hasStartedRender.current = true;
      onRunningChange?.(true);
      void window.electronAPI?.autoDemoRender?.({
        videoPath: rawVideoPath,
        traceJsonPath,
        productionUrl: formValues.productionUrl.trim() || undefined,
      }).catch((err: unknown) => {
        console.error("[AutoDemoPopover] render failed:", err);
        store.setIsRendering(false);
      });
    }
    if (!isRendering) hasStartedRender.current = false;
  }, [isRendering, rawVideoPath, traceJsonPath]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Step 2: Regenerate ────────────────────────────────────────────────────────

  const handleRegenerate = async (refinement: string) => {
    setIsGenerating(true);
    try {
      await window.electronAPI?.autoDemoGenerateScript?.({
        repoUrl: formValues.repoUrl.trim(),
        productionUrl: formValues.productionUrl.trim(),
        authEmail: formValues.authEmail.trim() || undefined,
        authPassword: formValues.authPassword || undefined,
        focusArea: `${formValues.query.trim()} ${refinement}`.trim() || undefined,
      });
    } catch (err) {
      setIsGenerating(false);
      console.error("[AutoDemoPopover] regenerate failed:", err);
    }
  };

  // ── Cancel ────────────────────────────────────────────────────────────────────

  const handleCancel = async () => {
    await window.electronAPI?.autoDemoCancel?.();
    onRunningChange?.(false);
    reset();
  };

  const handleOpenProject = () => {
    if (projectPath) window.electronAPI?.openProjectFileAtPath?.(projectPath);
  };

  const isRunning = isGenerating || isRecording || isRendering;
  const slideDir = step >= 2 ? 1 : -1;

  return (
    <HudPopover
      open={open}
      onOpenChange={(next) => {
        if (!next) { requestClose(POPOVER_ID); return; }
        requestOpen(POPOVER_ID);
      }}
      trigger={trigger}
      align="end"
      width={380}
    >
      <div
        style={{
          maxHeight: "min(540px, calc(100vh - 80px))",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          padding: 0,
        }}
      >
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
              style={{ overflowY: "auto", maxHeight: "min(540px, calc(100vh - 80px))" }}
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
              style={{ display: "flex", flexDirection: "column", height: "min(540px, calc(100vh - 80px))" }}
            >
              <Step2Script
                featureMap={featureMap}
                script={script}
                isRecording={isRecording}
                isRegenerating={isGenerating}
                onApprove={() => void handleApproveAndRecord()}
                onRegenerate={(r) => void handleRegenerate(r)}
                onBack={() => setStep(1)}
                styles={styles}
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
              style={{ display: "flex", flexDirection: "column", height: "min(540px, calc(100vh - 80px))" }}
            >
              <Step3Progress
                stages={stages}
                errorMessage={errorMessage}
                projectPath={projectPath}
                isRunning={isRunning}
                onCancel={() => void handleCancel()}
                onOpenProject={handleOpenProject}
                styles={styles}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </HudPopover>
  );
}
