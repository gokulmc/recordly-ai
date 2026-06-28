import { useState, useRef, useEffect } from "react";
import {
  RocketLaunchIcon,
  TrashIcon,
  ClockCountdownIcon,
  LockKeyIcon,
  ArrowRightIcon,
} from "@phosphor-icons/react";
import { GeneratingLog } from "../GeneratingLog";
import type { FormValues, AutoDemoConfig, StageState } from "../useAutoDemoStore";

const GITHUB_TOKEN_URL = "https://github.com/settings/tokens/new?scopes=repo&description=recordly-auto-demo";

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontSize: 10, fontWeight: 600, color: "var(--launch-label)", textTransform: "uppercase", letterSpacing: "0.07em" }}>
      {children}
    </span>
  );
}

function FieldInput({
  value,
  onChange,
  onBlur,
  onFocus,
  placeholder,
  type = "text",
  disabled,
  style,
}: {
  value: string;
  onChange: (v: string) => void;
  onBlur?: (e: React.FocusEvent<HTMLInputElement>) => void;
  onFocus?: () => void;
  placeholder?: string;
  type?: string;
  disabled?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      onFocus={onFocus}
      placeholder={placeholder}
      disabled={disabled}
      style={{
        width: "100%",
        height: 38,
        padding: "0 12px",
        fontSize: 14,
        color: "var(--launch-text)",
        background: "var(--launch-panel)",
        border: "1px solid var(--launch-border)",
        borderRadius: 9,
        outline: "none",
        transition: "border-color 0.12s",
        opacity: disabled ? 0.5 : 1,
        boxSizing: "border-box",
        ...style,
      }}
    />
  );
}

interface Props {
  formValues: FormValues;
  updateFormField: <K extends keyof FormValues>(key: K, value: FormValues[K]) => void;
  repoStatus: "unchecked" | "ok" | "needs-pat";
  setRepoStatus: (s: "unchecked" | "ok" | "needs-pat") => void;
  githubPat: string;
  setGithubPat: (s: string) => void;
  savedConfigs: AutoDemoConfig[];
  onLoadConfig: (c: AutoDemoConfig) => void;
  onDeleteConfig: (id: string) => void;
  isGenerating: boolean;
  onGenerate: () => void;
  stages: StageState[];
  logLines: string[];
  styles: Record<string, string>;
}

export function Step1Inputs({
  formValues,
  updateFormField,
  repoStatus,
  setRepoStatus,
  githubPat,
  setGithubPat,
  savedConfigs,
  onLoadConfig,
  onDeleteConfig,
  isGenerating,
  onGenerate,
  stages,
  logLines,
  styles,
}: Props) {
  const [showRecents, setShowRecents] = useState(false);
  const [showAuth, setShowAuth] = useState(false);
  const [checkingRepo, setCheckingRepo] = useState(false);
  const recentsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showRecents) return;
    const handler = (e: MouseEvent) => {
      if (!recentsRef.current?.contains(e.target as Node)) setShowRecents(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showRecents]);

  const checkRepo = async (url: string) => {
    if (!url.trim() || url.startsWith("/") || url.startsWith("~") || !url.includes("github.com")) {
      setRepoStatus("ok");
      return;
    }
    setCheckingRepo(true);
    try {
      const result = await window.electronAPI?.autoDemoCheckRepo?.(url.trim());
      setRepoStatus(result?.needsPat ? "needs-pat" : "ok");
    } catch {
      setRepoStatus("unchecked");
    } finally {
      setCheckingRepo(false);
    }
  };

  const isReady = formValues.repoUrl.trim() && formValues.productionUrl.trim() && repoStatus !== "needs-pat";

  return (
    <div style={{ padding: "4px 0 0" }}>
      {/* Header */}
      <div style={{ padding: "10px 16px 8px", display: "flex", alignItems: "center", gap: 8 }}>
        <RocketLaunchIcon size={16} style={{ color: "#f97316", flexShrink: 0 }} weight="bold" />
        <span style={{ fontSize: 21, fontWeight: 600, color: "var(--launch-text)" }}>Auto Demo</span>
        <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--launch-label)" }}>Step 1 of 3</span>
      </div>

      <div style={{ height: 1, background: "var(--launch-border)", margin: "0 0 2px" }} />

      <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 14 }}>

        {/* Repo URL */}
        <div ref={recentsRef} style={{ position: "relative" }}>
          <div style={{ marginBottom: 6 }}><Label>Repo URL or local path</Label></div>
          <div style={{ position: "relative" }}>
            <FieldInput
              value={formValues.repoUrl}
              onChange={(v) => { updateFormField("repoUrl", v); setRepoStatus("unchecked"); }}
              onFocus={() => { if (savedConfigs.length > 0) setShowRecents(true); }}
              onBlur={(e) => {
                if (!recentsRef.current?.contains(e.relatedTarget as Node)) void checkRepo(e.target.value);
              }}
              placeholder="https://github.com/org/app  or  /path/to/app"
              disabled={isGenerating}
            />
            {checkingRepo && (
              <span style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", fontSize: 11, color: "var(--launch-label)" }}>
                checking…
              </span>
            )}
          </div>

          {/* Recents */}
          {showRecents && savedConfigs.length > 0 && (
            <div style={{
              position: "absolute", top: "100%", left: 0, right: 0, zIndex: 50, marginTop: 4,
              background: "var(--launch-surface)", border: "1px solid var(--launch-border)",
              borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.1)", overflow: "hidden",
            }}>
              {savedConfigs.map((cfg) => (
                <button
                  key={cfg.id}
                  type="button"
                  className={styles.ddItem}
                  onMouseDown={(e) => { e.preventDefault(); onLoadConfig(cfg); setShowRecents(false); }}
                  style={{ width: "100%", position: "relative" }}
                >
                  <ClockCountdownIcon size={14} style={{ color: "var(--launch-label)", flexShrink: 0 }} />
                  <div style={{ minWidth: 0, flex: 1, textAlign: "left" }}>
                    <div style={{ fontSize: 13, color: "var(--launch-text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cfg.label}</div>
                    <div style={{ fontSize: 12, color: "var(--launch-label)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cfg.productionUrl}</div>
                  </div>
                  <span
                    style={{ color: "var(--launch-label)", padding: 2, borderRadius: 4, flexShrink: 0 }}
                    onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onDeleteConfig(cfg.id); }}
                    title="Remove"
                  >
                    <TrashIcon size={13} />
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* PAT needed */}
        {repoStatus === "needs-pat" && (
          <div style={{ borderRadius: 9, border: "1px solid rgba(234,179,8,0.35)", background: "rgba(234,179,8,0.07)", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <LockKeyIcon size={14} style={{ color: "#ca8a04", flexShrink: 0 }} />
              <span style={{ fontSize: 13, color: "#92400e", fontWeight: 500 }}>Private repo — access needed</span>
            </div>
            <button
              type="button"
              onClick={() => window.electronAPI?.openExternalUrl?.(GITHUB_TOKEN_URL)}
              style={{ fontSize: 12, color: "var(--launch-accent)", textAlign: "left", textDecoration: "underline", cursor: "pointer", background: "none", border: "none", padding: 0 }}
            >
              Create a GitHub token with repo scope →
            </button>
            <FieldInput
              value={githubPat}
              onChange={setGithubPat}
              placeholder="ghp_xxxxxxxx"
              style={{ fontFamily: "monospace", fontSize: 13, height: 36 }}
            />
          </div>
        )}

        {/* Production URL */}
        <div>
          <div style={{ marginBottom: 6 }}><Label>Production URL</Label></div>
          <FieldInput
            value={formValues.productionUrl}
            onChange={(v) => updateFormField("productionUrl", v)}
            placeholder="https://myapp.com"
            disabled={isGenerating}
          />
        </div>

        {/* Demo credentials */}
        <div>
          <button
            type="button"
            onClick={() => setShowAuth((v) => !v)}
            disabled={isGenerating}
            style={{ fontSize: 13, color: "var(--launch-label)", cursor: "pointer", background: "none", border: "none", padding: 0, display: "flex", alignItems: "center", gap: 5 }}
          >
            <span>{showAuth ? "▾" : "▸"}</span>
            <span>Demo credentials</span>
            <span style={{ color: "var(--launch-border-strong)" }}>(optional)</span>
          </button>
          {showAuth && (
            <div style={{ marginTop: 8, paddingLeft: 12, borderLeft: "2px solid var(--launch-border)", display: "flex", flexDirection: "column", gap: 8 }}>
              <FieldInput
                value={formValues.authEmail}
                onChange={(v) => updateFormField("authEmail", v)}
                placeholder="demo@example.com"
                disabled={isGenerating}
              />
              <FieldInput
                type="password"
                value={formValues.authPassword}
                onChange={(v) => updateFormField("authPassword", v)}
                placeholder="password"
                disabled={isGenerating}
              />
            </div>
          )}
        </div>

        {/* Query */}
        <div>
          <div style={{ marginBottom: 6 }}><Label>What to demo</Label></div>
          <textarea
            value={formValues.query}
            onChange={(e) => updateFormField("query", e.target.value)}
            disabled={isGenerating}
            rows={4}
            style={{
              width: "100%",
              padding: "10px 12px",
              fontSize: 14,
              color: "var(--launch-text)",
              background: "var(--launch-panel)",
              border: "1px solid var(--launch-border)",
              borderRadius: 9,
              outline: "none",
              resize: "none",
              fontFamily: "inherit",
              lineHeight: 1.55,
              opacity: isGenerating ? 0.5 : 1,
              boxSizing: "border-box",
            }}
          />
        </div>
      </div>

      {/* CTA */}
      <div style={{ padding: "2px 16px 14px", display: "flex", flexDirection: "column", gap: 12 }}>
        <button
          type="button"
          onClick={onGenerate}
          disabled={!isReady || isGenerating}
          style={{
            width: "100%",
            height: 42,
            borderRadius: 10,
            border: "none",
            background: isReady && !isGenerating ? "var(--launch-accent)" : isGenerating ? "rgba(37,99,235,0.12)" : "var(--launch-hover)",
            color: isReady && !isGenerating ? "#fff" : isGenerating ? "var(--launch-accent)" : "var(--launch-label)",
            fontSize: 14,
            fontWeight: 600,
            cursor: isReady && !isGenerating ? "pointer" : "default",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 7,
            transition: "background 0.2s, color 0.2s",
          }}
        >
          {isGenerating ? (
            <>
              <span style={{ width: 14, height: 14, borderRadius: "50%", border: "2px solid rgba(37,99,235,0.25)", borderTopColor: "var(--launch-accent)", display: "inline-block", animation: "spin 0.7s linear infinite" }} />
              Generating script…
            </>
          ) : (
            <>
              Generate Script
              <ArrowRightIcon size={14} weight="bold" />
            </>
          )}
        </button>

        {isGenerating && (
          <GeneratingLog stages={stages} logLines={logLines} />
        )}
      </div>
    </div>
  );
}
