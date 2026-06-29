import { useState, useCallback, useEffect } from "react";
import { loadAppSetting, saveAppSetting } from "@/lib/appSettings";

// ── Domain types (mirrored from pipeline, JSON-safe) ──────────────────────────

export interface AppFeature {
  name: string;
  emoji?: string;
  description: string;
  entryPath: string;
  importance: number;
  suggestedFlow: string[];
}

export interface AppFeatureMap {
  appName: string;
  appDescription: string;
  features: AppFeature[];
  primaryFlows: string[][];
  authNeeded: boolean;
  loginUrl?: string;
  authStatePath?: string;
}

export interface DemoStep {
  action: string;
  url?: string;
  selector?: string;
  value?: string;
  key?: string;
  narration?: string;
  waitMs?: number;
}

export interface RecordingScript {
  startUrl: string;
  steps: DemoStep[];
}

export type StageId = "ingest" | "crawl" | "script" | "record" | "derive" | "assemble" | "done" | "error";
export type StageStatus = "pending" | "running" | "done" | "error";

export interface StageState {
  id: StageId;
  label: string;
  status: StageStatus;
  message: string;
}

export interface AutoDemoConfig {
  id: string;
  label: string;
  repoUrl: string;
  productionUrl: string;
  authEmail?: string;
  query?: string;
  lastUsed: number;
  /** True if a demo password is stored in the OS keychain for this config */
  hasStoredPassword?: boolean;
}

/** Keychain key for a config's demo password. */
function passwordKey(id: string): string {
  return `autodemo-pw:${id}`;
}

export interface FormValues {
  repoUrl: string;
  productionUrl: string;
  authEmail: string;
  authPassword: string;
  query: string;
}

const DEFAULT_QUERY =
  "Show the core user journey — key features, real interactions, skip setup and admin screens.";

const STAGE_ORDER: Array<{ id: StageId; label: string }> = [
  { id: "ingest", label: "Read repo" },
  { id: "crawl", label: "Crawl live app" },
  { id: "script", label: "Generate script" },
  { id: "record", label: "Record demo" },
  { id: "derive", label: "Derive zoom & cursor" },
  { id: "assemble", label: "Build project" },
  { id: "done", label: "Complete" },
];

export function initialStages(): StageState[] {
  return STAGE_ORDER.map((s) => ({ ...s, status: "pending" as StageStatus, message: "" }));
}

/**
 * Stage list for the render phase (after the user approves the recording).
 * The pre-render stages (read/crawl/script/record) already happened, so show
 * them done rather than resetting the whole list to pending.
 */
const PRE_RENDER_STAGES = new Set<StageId>(["ingest", "crawl", "script", "record"]);
export function renderStartStages(): StageState[] {
  return STAGE_ORDER.map((s) => ({
    ...s,
    status: (PRE_RENDER_STAGES.has(s.id) ? "done" : "pending") as StageStatus,
    message: PRE_RENDER_STAGES.has(s.id) ? "Done" : "",
  }));
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useAutoDemoStore() {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [formValues, setFormValues] = useState<FormValues>({
    repoUrl: "",
    productionUrl: "",
    authEmail: "",
    authPassword: "",
    query: DEFAULT_QUERY,
  });
  const [repoStatus, setRepoStatus] = useState<"unchecked" | "ok" | "needs-pat">("unchecked");
  const [githubPat, setGithubPat] = useState("");

  const [featureMap, setFeatureMap] = useState<AppFeatureMap | null>(null);
  const [script, setScript] = useState<RecordingScript | null>(null);
  const [rawVideoPath, setRawVideoPath] = useState<string | null>(null);
  const [traceJsonPath, setTraceJsonPath] = useState<string | null>(null);
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [stages, setStages] = useState<StageState[]>(initialStages());
  const [isGenerating, setIsGenerating] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isRendering, setIsRendering] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  /** Zoom density chosen in the video review window (1=subtle … 5=aggressive) */
  const [zoomAggressiveness, setZoomAggressiveness] = useState(3);

  const [savedConfigs, setSavedConfigs] = useState<AutoDemoConfig[]>(() => {
    return loadAppSetting<AutoDemoConfig[]>("autoDemoConfigs") ?? [];
  });

  const updateFormField = useCallback(<K extends keyof FormValues>(key: K, value: FormValues[K]) => {
    setFormValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  // Persist the demo password to the OS keychain (encrypted), keyed by config id.
  const persistPassword = useCallback((id: string, password: string) => {
    if (password) {
      const ok = window.electronAPI?.secureStoreSet?.(passwordKey(id), password) ?? false;
      return ok;
    }
    window.electronAPI?.secureStoreDelete?.(passwordKey(id));
    return false;
  }, []);

  const saveConfig = useCallback((form: FormValues) => {
    const existing = loadAppSetting<AutoDemoConfig[]>("autoDemoConfigs") ?? [];
    const duplicate = existing.find((c) => c.repoUrl === form.repoUrl && c.productionUrl === form.productionUrl);
    if (duplicate) {
      const stored = persistPassword(duplicate.id, form.authPassword);
      const updated = existing.map((c) =>
        c.id === duplicate.id ? { ...c, query: form.query, authEmail: form.authEmail, hasStoredPassword: stored, lastUsed: Date.now() } : c,
      );
      saveAppSetting("autoDemoConfigs", updated);
      setSavedConfigs(updated);
      return;
    }
    const label = form.repoUrl.split("/").slice(-1)[0] ?? form.repoUrl;
    const id = generateId();
    const stored = persistPassword(id, form.authPassword);
    const newConfig: AutoDemoConfig = {
      id,
      label,
      repoUrl: form.repoUrl,
      productionUrl: form.productionUrl,
      authEmail: form.authEmail || undefined,
      query: form.query,
      lastUsed: Date.now(),
      hasStoredPassword: stored,
    };
    const updated = [newConfig, ...existing].slice(0, 5);
    saveAppSetting("autoDemoConfigs", updated);
    setSavedConfigs(updated);
  }, [persistPassword]);

  const deleteConfig = useCallback((id: string) => {
    window.electronAPI?.secureStoreDelete?.(passwordKey(id));
    setSavedConfigs((prev) => {
      const updated = prev.filter((c) => c.id !== id);
      saveAppSetting("autoDemoConfigs", updated);
      return updated;
    });
  }, []);

  const loadConfig = useCallback((config: AutoDemoConfig) => {
    const storedPassword = config.hasStoredPassword
      ? (window.electronAPI?.secureStoreGet?.(passwordKey(config.id)) ?? "")
      : "";
    setFormValues((prev) => ({
      ...prev,
      repoUrl: config.repoUrl,
      productionUrl: config.productionUrl,
      authEmail: config.authEmail ?? "",
      authPassword: storedPassword,
      query: config.query ?? DEFAULT_QUERY,
    }));
    setRepoStatus("unchecked");
  }, []);

  const applyStageEvent = useCallback((evt: { type: string; stageId?: string; status?: string; message: string; payload?: unknown }) => {
    if (evt.type === "llm-token") {
      setLogLines((prev) => {
        const last = prev[prev.length - 1] ?? "";
        return [...prev.slice(0, -1), last + evt.message];
      });
      return;
    }
    if (evt.type !== "stage") return;
    const safeStatus = (["running", "done", "error"] as const).includes(evt.status as "running" | "done" | "error")
      ? (evt.status as StageStatus)
      : "error";
    setStages((prev) =>
      prev.map((s) => (s.id === evt.stageId ? { ...s, status: safeStatus, message: evt.message } : s)),
    );
    if (evt.message) {
      setLogLines((prev) => [...prev, evt.message]);
    }
    // Extract payload data
    const payload = evt.payload as Record<string, unknown> | undefined;
    if (payload?.kind === "script" && safeStatus === "done") {
      setFeatureMap(payload.featureMap as AppFeatureMap);
      setScript(payload.script as RecordingScript);
    }
    if (payload?.kind === "record" && safeStatus === "done") {
      setRawVideoPath(payload.videoPath as string);
      setTraceJsonPath(payload.traceJsonPath as string);
    }
    if (payload?.kind === "assemble" && safeStatus === "done") {
      setProjectPath(payload.projectPath as string);
    }
    if (evt.stageId === "error" || safeStatus === "error") {
      setErrorMessage(evt.message);
      setIsGenerating(false);
      setIsRecording(false);
      setIsRendering(false);
    }
  }, []);

  const reset = useCallback(() => {
    setStep(1);
    setFeatureMap(null);
    setScript(null);
    setRawVideoPath(null);
    setTraceJsonPath(null);
    setProjectPath(null);
    setStages(initialStages());
    setErrorMessage(null);
    setIsGenerating(false);
    setIsRecording(false);
    setIsRendering(false);
    setLogLines([]);
  }, []);

  // Listen for progress events from the main process
  useEffect(() => {
    const remove = window.electronAPI?.onAutoDemoProgress?.((evt) => applyStageEvent(evt));
    return () => remove?.();
  }, [applyStageEvent]);

  // Listen for phase-result events (featureMap + script, videoPath, projectPath)
  useEffect(() => {
    const remove = window.electronAPI?.onAutoDemoPhaseResult?.((result) => {
      const r = result as Record<string, unknown> | null;
      if (!r) return;
      if ("featureMap" in r && "script" in r) {
        setFeatureMap(r.featureMap as AppFeatureMap);
        setScript(r.script as RecordingScript);
        setIsGenerating(false);
        setStep(2);
      } else if ("videoPath" in r && "traceJsonPath" in r) {
        setRawVideoPath(r.videoPath as string);
        setTraceJsonPath(r.traceJsonPath as string);
        setIsRecording(false);
      } else if ("projectPath" in r) {
        setProjectPath(r.projectPath as string);
        setIsRendering(false);
      }
    });
    return () => remove?.();
  }, []);

  // Listen for video-review decisions
  useEffect(() => {
    const remove = window.electronAPI?.onVideoReviewDecision?.((decision, aggressiveness) => {
      if (decision === "modify") {
        setStep(2);
      } else if (decision === "approve") {
        if (typeof aggressiveness === "number") setZoomAggressiveness(aggressiveness);
        setIsRendering(true);
        setStep(3);
        setStages(renderStartStages());
      }
    });
    return () => remove?.();
  }, []);

  return {
    step, setStep,
    formValues, updateFormField,
    repoStatus, setRepoStatus,
    githubPat, setGithubPat,
    featureMap, script,
    rawVideoPath, traceJsonPath, projectPath,
    stages, setStages,
    isGenerating, setIsGenerating,
    isRecording, setIsRecording,
    isRendering, setIsRendering,
    errorMessage, setErrorMessage,
    logLines, setLogLines,
    zoomAggressiveness, setZoomAggressiveness,
    savedConfigs, saveConfig, deleteConfig, loadConfig,
    reset,
    applyStageEvent,
  };
}
