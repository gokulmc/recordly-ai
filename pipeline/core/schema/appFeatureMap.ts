/**
 * Structured understanding of a web app produced by LLM repo analysis.
 * Enriched by the Playwright crawl stage before demo-script generation.
 */

import type { CatalogEntry, Target } from "./target.js";
import type { DemoStep } from "../record/types.js";

export interface AppFeature {
  /** Short human-readable name */
  name: string;
  /** Single emoji that best represents this feature (LLM-assigned) */
  emoji?: string;
  /** One-sentence description of what this feature does */
  description: string;
  /** URL path relative to the production root (e.g. "/dashboard") */
  entryPath: string;
  /** 1 (low) – 5 (critical) importance for the demo */
  importance: number;
  /** LLM-guessed CSS/role selectors — crawl stage overwrites these with live DOM */
  likelySelectors?: string[];
  /** Real interactive elements found on this feature's page (authenticated crawl) */
  liveElements?: CatalogEntry[];
  /**
   * Bounded, durable-Target interactions the crawl performed to reveal result-state
   * elements (e.g. fill a query → click Generate → wait). Replayed by the recorder
   * before interacting with any element flagged `revealed`, so the demo reaches the
   * state where that element exists.
   */
  revealSteps?: DemoStep[];
  /** Suggested interaction flow for this feature */
  suggestedFlow: string[];
}

/**
 * Exact, verified login interaction captured by the crawl's attemptLogin. The
 * demo script replays these instead of guessing selectors.
 */
export interface LoginSelectors {
  /** URL where login begins (home page for modal logins) */
  url: string;
  /** Control that opens an inline/modal login form (when login isn't at a URL) */
  trigger?: Target;
  /** Target that matched the email/username field */
  email: Target;
  /** How the form advances from email to password */
  advance?: "enter" | "click";
  /** Next/Continue control, when advance === "click" */
  next?: Target;
  /** Target that matched the password field */
  password: Target;
}

export interface AppFeatureMap {
  /** App name inferred from package.json / README */
  appName: string;
  /** One-paragraph description of the product */
  appDescription: string;
  /** All discovered features, sorted by importance desc */
  features: AppFeature[];
  /** High-level demo flows (ordered list of feature names) */
  primaryFlows: string[][];
  /** True if any feature requires authentication */
  authNeeded: boolean;
  /** URL where the crawl successfully logged in (set at crawl time, if creds given) */
  loginUrl?: string;
  /** Verified login selectors captured by the crawl (drives the demo's login steps) */
  loginSelectors?: LoginSelectors;
  /** Path to a Playwright storageState file from a successful crawl login */
  authStatePath?: string;
  /** App type hint used by saliency for cursor styling */
  appVibe?: string;
}
