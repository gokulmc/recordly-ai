import { useState, useEffect, useRef } from "react";
import {
  CheckCircleIcon,
  CircleNotchIcon,
  WarningCircleIcon,
  RocketLaunchIcon,
  XCircleIcon,
  FolderOpenIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// ── Types ─────────────────────────────────────────────────────────────────────

type StageId = "ingest" | "crawl" | "script" | "record" | "derive" | "assemble" | "done" | "error";
type StageStatus = "pending" | "running" | "done" | "error";

interface StageState {
  id: StageId;
  label: string;
  status: StageStatus;
  message: string;
}

const STAGE_ORDER: Array<{ id: StageId; label: string }> = [
  { id: "ingest", label: "Read repo" },
  { id: "crawl", label: "Crawl live app" },
  { id: "script", label: "Generate script" },
  { id: "record", label: "Record demo" },
  { id: "derive", label: "Derive zoom & cursor" },
  { id: "assemble", label: "Build project" },
  { id: "done", label: "Complete" },
];

// ── Sub-components ────────────────────────────────────────────────────────────

function StageIcon({ status }: { status: StageStatus }) {
  if (status === "running") {
    return <CircleNotchIcon className="w-4 h-4 text-blue-400 animate-spin shrink-0" />;
  }
  if (status === "done") {
    return <CheckCircleIcon className="w-4 h-4 text-green-400 shrink-0" />;
  }
  if (status === "error") {
    return <WarningCircleIcon className="w-4 h-4 text-red-400 shrink-0" />;
  }
  return <div className="w-4 h-4 rounded-full border border-white/20 shrink-0" />;
}

function StageRow({ stage }: { stage: StageState }) {
  return (
    <div className="flex items-start gap-3 py-2">
      <StageIcon status={stage.status} />
      <div className="min-w-0">
        <p
          className={`text-sm font-medium leading-none ${
            stage.status === "pending"
              ? "text-white/30"
              : stage.status === "error"
                ? "text-red-300"
                : "text-white/90"
          }`}
        >
          {stage.label}
        </p>
        {stage.message && stage.status !== "pending" && (
          <p className="text-xs text-white/40 mt-0.5 leading-relaxed">{stage.message}</p>
        )}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function AutoDemoWindow() {
  const [repoUrl, setRepoUrl] = useState("");
  const [productionUrl, setProductionUrl] = useState("");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [showAuth, setShowAuth] = useState(false);

  const [running, setRunning] = useState(false);
  const [stages, setStages] = useState<StageState[]>(
    STAGE_ORDER.map((s) => ({ ...s, status: "pending", message: "" })),
  );
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const cleanupRef = useRef<(() => void) | null>(null);

  // Wire up the progress listener once
  useEffect(() => {
    if (!window.electronAPI?.onAutoDemoProgress) return;
    const remove = window.electronAPI.onAutoDemoProgress((evt) => {
      if (evt.type !== "stage") return;

      const safeStatus = (["pending", "running", "done", "error"] as const).includes(
        evt.status as StageStatus,
      )
        ? (evt.status as StageStatus)
        : "error";
      setStages((prev) =>
        prev.map((s) =>
          s.id === evt.stageId ? { ...s, status: safeStatus, message: evt.message } : s,
        ),
      );

      if (evt.stageId === "done" && evt.status === "done") {
        setRunning(false);
        const path = (evt.payload as { kind: "done"; projectPath: string } | undefined)
          ?.projectPath;
        if (path) setProjectPath(path);
      }

      if (evt.stageId === "error" || evt.status === "error") {
        setRunning(false);
        setErrorMessage(evt.message);
      }
    });
    cleanupRef.current = remove;
    return () => remove();
  }, []);

  const handleGenerate = async () => {
    if (!repoUrl.trim() || !productionUrl.trim()) return;
    setRunning(true);
    setErrorMessage(null);
    setProjectPath(null);
    setStages(STAGE_ORDER.map((s) => ({ ...s, status: "pending", message: "" })));

    try {
      await window.electronAPI?.autoDemoStart?.({
        repoUrl: repoUrl.trim(),
        productionUrl: productionUrl.trim(),
        authEmail: authEmail.trim() || undefined,
        authPassword: authPassword || undefined,
      });
    } catch (err) {
      setRunning(false);
      setErrorMessage(String(err));
    }
  };

  const handleCancel = async () => {
    await window.electronAPI?.autoDemoCancel?.();
    setRunning(false);
    cleanupRef.current?.();
  };

  const handleOpenProject = () => {
    if (projectPath) {
      window.electronAPI?.openProjectFileAtPath?.(projectPath);
    }
  };

  const isReady = repoUrl.trim() && productionUrl.trim();
  const isDone = stages.some((s) => s.id === "done" && s.status === "done");

  return (
    <div className="flex flex-col h-screen bg-[#1a1a1a] text-white select-none">
      {/* Drag region */}
      <div className="h-8 w-full [-webkit-app-region:drag] shrink-0" />

      <div className="flex-1 overflow-y-auto px-6 pb-6 flex flex-col gap-5">
        {/* Header */}
        <div className="flex items-center gap-2">
          <RocketLaunchIcon className="w-5 h-5 text-blue-400" />
          <h1 className="text-base font-semibold text-white/90">Auto Demo</h1>
        </div>

        {/* Inputs */}
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-white/50">GitHub repo URL or local path</Label>
            <Input
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/org/app  or  /path/to/app"
              disabled={running}
              className="bg-white/5 border-white/10 text-sm h-8"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-xs text-white/50">Production URL</Label>
            <Input
              value={productionUrl}
              onChange={(e) => setProductionUrl(e.target.value)}
              placeholder="https://myapp.com"
              disabled={running}
              className="bg-white/5 border-white/10 text-sm h-8"
            />
          </div>

          {/* Auth — collapsed by default */}
          <button
            type="button"
            onClick={() => setShowAuth((v) => !v)}
            disabled={running}
            className="text-xs text-white/30 hover:text-white/50 text-left transition-colors"
          >
            {showAuth ? "▾ Demo user credentials" : "▸ Demo user credentials (optional)"}
          </button>

          {showAuth && (
            <div className="flex flex-col gap-2 pl-3 border-l border-white/10">
              <Input
                value={authEmail}
                onChange={(e) => setAuthEmail(e.target.value)}
                placeholder="demo@example.com"
                disabled={running}
                className="bg-white/5 border-white/10 text-sm h-8"
              />
              <Input
                type="password"
                value={authPassword}
                onChange={(e) => setAuthPassword(e.target.value)}
                placeholder="password"
                disabled={running}
                className="bg-white/5 border-white/10 text-sm h-8"
              />
            </div>
          )}
        </div>

        {/* Stage list */}
        {(running || isDone || errorMessage) && (
          <div className="rounded-lg bg-white/[0.04] border border-white/[0.08] px-4 py-2 flex flex-col divide-y divide-white/[0.06]">
            {stages.map((stage) => (
              <StageRow key={stage.id} stage={stage} />
            ))}
            {errorMessage && (
              <div className="flex items-start gap-3 py-2">
                <XCircleIcon className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                <p className="text-xs text-red-300 leading-relaxed">{errorMessage}</p>
              </div>
            )}
          </div>
        )}

        {/* Open project button */}
        {isDone && projectPath && (
          <Button
            onClick={handleOpenProject}
            className="w-full h-8 text-sm bg-green-600 hover:bg-green-500 text-white"
          >
            <FolderOpenIcon className="w-4 h-4 mr-1.5" />
            Open in Editor
          </Button>
        )}
      </div>

      {/* Footer actions */}
      <div className="px-6 pb-5 flex gap-2 shrink-0">
        {running ? (
          <Button
            onClick={handleCancel}
            variant="outline"
            className="flex-1 h-8 text-sm border-white/10 text-white/70 hover:text-white bg-transparent"
          >
            Cancel
          </Button>
        ) : (
          <Button
            onClick={handleGenerate}
            disabled={!isReady}
            className="flex-1 h-8 text-sm bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40"
          >
            Generate Demo
          </Button>
        )}
      </div>
    </div>
  );
}
