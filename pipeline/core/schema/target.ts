/**
 * Durable, structured locator descriptors. Pure types (no Playwright) so they
 * can live in the schema and flow through the feature map, script, and trace.
 * Compiled to Playwright locators at record time by core/record/locator.ts.
 */

export type Target =
  | { kind: "testId"; value: string }
  | { kind: "role"; role: string; name: string }
  | { kind: "label"; value: string }
  | { kind: "placeholder"; value: string }
  | { kind: "text"; value: string }
  | { kind: "css"; value: string };

export interface CatalogEntry {
  /** Stable index within a feature's catalog (what the LLM references). */
  id: number;
  target: Target;
  /** Visible text / accessible name (for prompts + self-heal matching). */
  text: string;
  /** ARIA role (explicit or implicit). */
  role: string;
  tag: string;
  enabled: boolean;
  bbox: { x: number; y: number; w: number; h: number };
}
