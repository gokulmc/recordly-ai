/**
 * Structured understanding of a web app produced by LLM repo analysis.
 * Enriched by the Playwright crawl stage before demo-script generation.
 */

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
  /** Suggested interaction flow for this feature */
  suggestedFlow: string[];
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
  /** App type hint used by saliency for cursor styling */
  appVibe?: string;
}
