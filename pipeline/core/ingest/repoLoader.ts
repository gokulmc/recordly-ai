/**
 * Clone a public GitHub repo to a temp directory and return the local path.
 * Also accepts a local filesystem path — if the argument starts with "/" or
 * "~" it is resolved directly (no clone needed).
 *
 * Re-uses an existing clone if the directory is present (avoids redundant
 * network round-trips during iterative smoke runs).
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface RepoLoaderResult {
  /** Absolute path to the cloned repo root */
  repoPath: string;
  /** Whether it was freshly cloned (false = reused existing) */
  freshClone: boolean;
}

/**
 * Clone `repoUrl` into `<tmpDir>/recordly-repos/<repo-name>`.
 * If the directory already exists and contains a `.git` folder the clone is
 * skipped; pass `force: true` to delete and re-clone.
 */
export async function cloneRepo(
  repoUrl: string,
  opts: { force?: boolean; tmpDir?: string } = {},
): Promise<RepoLoaderResult> {
  // Local path shortcut — no clone needed
  const expanded = repoUrl.startsWith("~")
    ? path.join(os.homedir(), repoUrl.slice(1))
    : repoUrl;
  if (expanded.startsWith("/") && fs.existsSync(expanded)) {
    console.log(`  [repo] using local path: ${expanded}`);
    return { repoPath: expanded, freshClone: false };
  }

  const base = opts.tmpDir ?? path.join(os.tmpdir(), "recordly-repos");
  fs.mkdirSync(base, { recursive: true });

  // Derive a filesystem-safe name from the URL
  const repoName = repoUrl
    .replace(/^https?:\/\//, "")
    .replace(/\.git$/, "")
    .replace(/[^a-zA-Z0-9._-]/g, "_");

  const repoPath = path.join(base, repoName);

  if (fs.existsSync(path.join(repoPath, ".git"))) {
    if (opts.force) {
      fs.rmSync(repoPath, { recursive: true, force: true });
    } else {
      console.log(`  [repo] reusing existing clone: ${repoPath}`);
      return { repoPath, freshClone: false };
    }
  }

  console.log(`  [repo] cloning ${repoUrl} → ${repoPath}`);
  execSync(`git clone --depth 1 "${repoUrl}" "${repoPath}"`, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  console.log(`  [repo] done`);

  return { repoPath, freshClone: true };
}
