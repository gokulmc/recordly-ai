/**
 * LLM-driven repo understanding.
 *
 * Reads high-signal files from the cloned repo and asks DeepSeek to produce
 * an AppFeatureMap — a structured understanding of what the app does and how
 * to demo it.
 *
 * Strategy:
 *   1. Collect: README, package.json, route files, top-level pages/screens,
 *      nav/menu components, i18n strings.
 *   2. If the collected text is large, summarise per-file with deepseek-flash.
 *   3. Synthesise AppFeatureMap with deepseek-pro (structured JSON output).
 */

import fs from "node:fs";
import path from "node:path";
import type { AppFeatureMap } from "../schema/appFeatureMap.js";
import { chat, parseJson, DEEPSEEK_FAST_MODEL, DEEPSEEK_SMART_MODEL } from "../../llm/deepseek.js";

// ── File collection ────────────────────────────────────────────────────────────

const MAX_FILE_CHARS = 12_000;   // per-file cap before summarisation
const MAX_TOTAL_CHARS = 60_000;  // total context fed to the synthesis prompt

/** Globs of high-signal files, in priority order. */
const HIGH_SIGNAL_PATTERNS: Array<{ glob: string; maxFiles: number }> = [
  { glob: "README.md", maxFiles: 1 },
  { glob: "README.{txt,rst}", maxFiles: 1 },
  { glob: "package.json", maxFiles: 1 },
  // Next.js App Router (with or without src/)
  { glob: "app/**/page.{tsx,jsx,ts,js}", maxFiles: 20 },
  { glob: "app/**/layout.{tsx,jsx}", maxFiles: 5 },
  { glob: "src/app/**/page.{tsx,jsx,ts,js}", maxFiles: 20 },
  { glob: "src/app/**/layout.{tsx,jsx}", maxFiles: 5 },
  // Next.js Pages Router
  { glob: "pages/**/*.{tsx,jsx,ts,js}", maxFiles: 20 },
  { glob: "src/pages/**/*.{tsx,jsx,ts,js}", maxFiles: 20 },
  // React Router / Vite
  { glob: "src/routes/**/*.{tsx,jsx}", maxFiles: 15 },
  { glob: "src/App.{tsx,jsx}", maxFiles: 1 },
  { glob: "src/router.{ts,tsx}", maxFiles: 1 },
  // Nav/menu components (with or without src/)
  { glob: "src/**/Nav*.{tsx,jsx}", maxFiles: 3 },
  { glob: "src/**/Sidebar*.{tsx,jsx}", maxFiles: 3 },
  { glob: "src/**/Header*.{tsx,jsx}", maxFiles: 3 },
  { glob: "**/Nav*.{tsx,jsx}", maxFiles: 3 },
  { glob: "**/Sidebar*.{tsx,jsx}", maxFiles: 3 },
  // API routes
  { glob: "app/api/**/route.{ts,js}", maxFiles: 10 },
  { glob: "src/app/api/**/route.{ts,js}", maxFiles: 10 },
  { glob: "pages/api/**/*.{ts,js}", maxFiles: 10 },
  { glob: "src/pages/api/**/*.{ts,js}", maxFiles: 10 },
];

function globFiles(repoPath: string, pattern: string, maxFiles: number): string[] {
  // Simple recursive find without an npm glob library
  const ext = pattern.match(/\{([^}]+)\}/)?.[1]?.split(",") ?? [];
  const dirPart = pattern.replace(/\/[^/]*$/, "").replace(/\*\*\/?/, "");
  const baseDir = path.join(repoPath, dirPart);

  if (!fs.existsSync(baseDir)) return [];

  const results: string[] = [];
  const walk = (dir: string) => {
    if (results.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (results.length >= maxFiles) break;
      const full = path.join(dir, e.name);
      if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") {
        walk(full);
      } else if (e.isFile()) {
        const hasExt = ext.length === 0 || ext.some((x) => e.name.endsWith(`.${x.trim()}`));
        const nameMatch = pattern.includes(e.name); // exact match like "README.md"
        if (hasExt || nameMatch) results.push(full);
      }
    }
  };
  walk(baseDir);
  return results;
}

function collectFiles(repoPath: string): Array<{ relPath: string; content: string }> {
  const seen = new Set<string>();
  const files: Array<{ relPath: string; content: string }> = [];

  for (const { glob, maxFiles } of HIGH_SIGNAL_PATTERNS) {
    const paths = globFiles(repoPath, glob, maxFiles);
    for (const abs of paths) {
      if (seen.has(abs)) continue;
      seen.add(abs);
      try {
        const raw = fs.readFileSync(abs, "utf8");
        files.push({
          relPath: path.relative(repoPath, abs),
          content: raw.slice(0, MAX_FILE_CHARS),
        });
      } catch { /* skip unreadable */ }
    }
  }

  // Auth-signal files are the strongest evidence of whether the app gates
  // content behind login: framework middleware, auth config/modules, and env
  // templates (which name the provider: NextAuth/Clerk/Cognito/Supabase…).
  // Search recursively — monorepos keep these under apps/<x>/src, not the root.
  for (const { relPath, content } of findAuthSignalFiles(repoPath, seen)) {
    files.push({ relPath, content });
  }
  return files;
}

/** True if a file's path/name is strong evidence of auth in the app. */
function isAuthSignalFile(relPath: string): boolean {
  const base = path.basename(relPath).toLowerCase();
  const lower = relPath.toLowerCase();
  if (/^middleware\.(ts|js|tsx|jsx)$/.test(base)) return true;
  if (/^auth(\.config)?\.(ts|tsx|js|jsx)$/.test(base)) return true;
  if (/^\.env.*\.(example|sample|template)$/.test(base) || /^\.env\.(example|sample|template)$/.test(base)) return true;
  // an auth route/module directory (but not test files)
  if (/(^|\/)auth(\/|$)/.test(lower) && !/\.(spec|test)\./.test(lower)) return true;
  return false;
}

/** Recursively collect up to a handful of auth-signal files (env values stripped). */
function findAuthSignalFiles(
  repoPath: string,
  seen: Set<string>,
  maxFiles = 6,
): Array<{ relPath: string; content: string }> {
  const out: Array<{ relPath: string; content: string }> = [];
  const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);

  const walk = (dir: string, depth: number) => {
    if (out.length >= maxFiles || depth > 6) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= maxFiles) break;
      if (e.name.startsWith(".") && !e.name.startsWith(".env")) continue;
      if (SKIP.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(abs, depth + 1);
      } else if (e.isFile()) {
        const rel = path.relative(repoPath, abs);
        if (seen.has(abs) || !isAuthSignalFile(rel)) continue;
        seen.add(abs);
        try {
          let raw = fs.readFileSync(abs, "utf8");
          if (path.basename(rel).startsWith(".env")) {
            // keep only KEY names — never the secret values
            raw = raw.split("\n").map((l) => l.replace(/=.*/, "=")).join("\n");
          }
          out.push({ relPath: rel, content: raw.slice(0, MAX_FILE_CHARS) });
        } catch { /* skip unreadable */ }
      }
    }
  };
  walk(repoPath, 0);
  return out;
}

// ── Summarisation ──────────────────────────────────────────────────────────────

async function summariseFile(relPath: string, content: string): Promise<string> {
  const prompt = `Summarise this file from a web app repo in ≤150 words, focusing on:
- What routes/pages/features it defines
- Key UI components or API endpoints
- Any auth/permission gating

File: ${relPath}
---
${content.slice(0, 8000)}`;

  return chat([{ role: "user", content: prompt }], {
    model: DEEPSEEK_FAST_MODEL,
    maxTokens: 256,
  });
}

// ── Synthesis ──────────────────────────────────────────────────────────────────

const FEATURE_MAP_SCHEMA = `{
  "appName": "string",
  "appDescription": "string (1 paragraph)",
  "features": [
    {
      "name": "string",
      "emoji": "single emoji that represents this feature",
      "description": "string",
      "entryPath": "string (URL path, e.g. /dashboard)",
      "importance": "number 1-5",
      "likelySelectors": ["CSS or role selectors"],
      "suggestedFlow": ["step 1", "step 2"]
    }
  ],
  "primaryFlows": [["feature A", "feature B"]],
  "authNeeded": "boolean",
  "appVibe": "consumer|productivity|dev-tool|creative|research"
}`;

/**
 * Deterministic auth detection from the collected files. The LLM is unreliable
 * here — it anchors on a public landing page and reports authNeeded:false even
 * when the app clearly gates features. A hard signal overrides that.
 */
function detectAuthSignal(
  files: Array<{ relPath: string; content: string }>,
): { detected: boolean; reason?: string } {
  const AUTH_DEPS =
    /(next-auth|@auth\/core|@clerk\/|@auth0\/|aws-amplify|amazon-cognito|@supabase\/auth|firebase\/auth|passport|lucia-auth|"lucia"|better-auth|@workos|stytch|supertokens)/i;
  const ENV_AUTH_KEYS =
    /\b(COGNITO|CLERK|NEXTAUTH|AUTH0|SUPABASE_(?:URL|ANON|SERVICE)|FIREBASE_(?:API|AUTH)|OAUTH|JWT_SECRET|SESSION_SECRET|AUTH_SECRET|IDENTITY_POOL|USER_POOL)\b/i;
  const MIDDLEWARE_AUTH =
    /(withAuth|getToken|getServerSession|auth\(\)|isAuthenticated|requireAuth|redirect\([^)]*(login|signin|sign-in)|clerkMiddleware|authMiddleware)/i;

  for (const f of files) {
    const base = f.relPath.split("/").pop()?.toLowerCase() ?? "";
    if (/^auth(\.config)?\.(ts|tsx|js|jsx)$/.test(base)) {
      return { detected: true, reason: `auth module ${f.relPath}` };
    }
    if (/^middleware\./.test(base) && MIDDLEWARE_AUTH.test(f.content)) {
      return { detected: true, reason: `auth in ${f.relPath}` };
    }
    if (base.startsWith(".env") && ENV_AUTH_KEYS.test(f.content)) {
      return { detected: true, reason: `auth keys in ${f.relPath}` };
    }
    if (base === "package.json" && AUTH_DEPS.test(f.content)) {
      return { detected: true, reason: "auth dependency in package.json" };
    }
    if (/(^|\/)auth(\/|$)/.test(f.relPath.toLowerCase()) && !/\.(spec|test)\./.test(f.relPath.toLowerCase())) {
      return { detected: true, reason: `auth route/module ${f.relPath}` };
    }
  }
  return { detected: false };
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function understandRepo(repoPath: string): Promise<AppFeatureMap> {
  console.log("  [ingest] collecting high-signal files …");
  const files = collectFiles(repoPath);
  console.log(`  [ingest] found ${files.length} files`);

  // Build context string
  let contextParts: string[] = [];
  let totalChars = 0;

  for (const { relPath, content } of files) {
    const entry = `\n### ${relPath}\n${content}`;
    if (totalChars + entry.length > MAX_TOTAL_CHARS) {
      // Summarise this file instead of including it verbatim
      console.log(`  [ingest] summarising ${relPath} …`);
      const summary = await summariseFile(relPath, content);
      const summarised = `\n### ${relPath} (summary)\n${summary}`;
      contextParts.push(summarised);
      totalChars += summarised.length;
    } else {
      contextParts.push(entry);
      totalChars += entry.length;
    }
    if (totalChars > MAX_TOTAL_CHARS * 1.5) break;
  }

  const context = contextParts.join("\n");

  console.log(`  [ingest] synthesising feature map (${Math.round(totalChars / 1000)}k chars) …`);

  const prompt = `You are analysing a web app repository to produce a structured demo plan.

Below are the key files from the repo (README, routes, pages, nav components, API handlers).
Produce an AppFeatureMap JSON object identifying the app's main features and how to demo them.

SCHEMA (return ONLY this JSON, no markdown):
${FEATURE_MAP_SCHEMA}

Rules:
- List at most 6 features; pick the most demo-worthy ones.
- emoji: exactly one emoji that visually captures the feature (e.g. 🔍 for search, 🗺️ for a map, ✏️ for editing).
- entryPath must be a real navigable URL path (start with /).
- likelySelectors: guess CSS selectors or role-based selectors (e.g. button[data-testid="submit"]).
- suggestedFlow: 2-5 concrete Playwright-style steps (click X, type Y, press Enter).
- Sort features by importance desc (5 = must show, 1 = optional).
- authNeeded: set TRUE if the repo shows ANY sign that core features sit behind login — e.g. framework middleware guarding routes (middleware.ts redirecting unauthenticated users), a login/signin page or /api/auth route, session/JWT/cookie checks, an auth provider in deps or .env (NextAuth, Clerk, Auth0, Cognito, Supabase Auth, Firebase Auth), protected API handlers returning 401/redirect, or server actions gated by getSession()/auth(). Set FALSE only when the app is clearly fully public (no login UI, no protected routes, no auth provider). When unsure, prefer TRUE.
- appVibe: pick one of consumer|productivity|dev-tool|creative|research.

REPO FILES:
${context}`;

  const raw = await chat([{ role: "user", content: prompt }], {
    model: DEEPSEEK_SMART_MODEL,
    maxTokens: 3000,
  });

  const parsed = parseJson<AppFeatureMap>(raw);
  console.log(`  [ingest] found ${parsed.features?.length ?? 0} features: ${(parsed.features ?? []).map((f) => f.name).join(", ")}`);

  // Deterministic auth override — trust hard repo evidence over the LLM's guess.
  const authSignal = detectAuthSignal(files);
  if (authSignal.detected && !parsed.authNeeded) {
    console.log(`  [ingest] authNeeded forced true (${authSignal.reason})`);
    parsed.authNeeded = true;
  }

  return parsed;
}
