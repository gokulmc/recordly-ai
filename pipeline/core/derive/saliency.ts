/**
 * LLM saliency layer (M4).
 *
 * Takes the interaction trace and the mechanically-derived zoom regions, sends
 * a compact summary to DeepSeek, and returns:
 *   1. A SaliencyResolver for deriveZoomRegions — each event is marked
 *      emphasize/skip with an optional depthBias and holdMs.
 *   2. A CursorVisualSettings override chosen from the app context.
 *
 * Falls back to defaultSaliency + default cursor settings if the LLM call
 * fails or the key is missing.
 */

import type { InteractionTrace } from "../schema/interactionTrace.js";
import type { CursorVisualSettings } from "../schema/recordlyContract.js";
import { chat, parseJson, DEEPSEEK_FAST_MODEL } from "../../llm/deepseek.js";
import {
  defaultSaliency,
  type SaliencyHint,
  type SaliencyResolver,
} from "./zoomDeriver.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LlmSaliencyResult {
  /** Per-event resolver — pass as `options.saliency` to deriveZoomRegions */
  saliency: SaliencyResolver;
  /** Cursor style chosen for the whole project (override deriveCursorTelemetry default) */
  cursorVisual: CursorVisualSettings;
}

interface LlmEventJudgement {
  index: number;
  emphasize: boolean;
  depthBias?: number;   // -2..+2
  holdMs?: number;      // extra hold on the zoom (ms)
  reason?: string;
}

interface LlmSaliencyResponse {
  events: LlmEventJudgement[];
  cursorStyle: "macos" | "tahoe" | "dot" | "figma";
  cursorClickEffect: "none" | "spotlight" | "ripple" | "echo";
  appVibe?: string;
}

const CURSOR_VISUAL_STYLES = ["macos", "tahoe", "dot", "figma"] as const;
const CURSOR_CLICK_EFFECTS = ["none", "spotlight", "ripple", "echo"] as const;

const DEFAULT_CURSOR_VISUAL: CursorVisualSettings = {
  style: "macos",
  size: 1,
  smoothing: 0.5,
  motionBlur: 0,
  clickBounce: 0.15,
  clickBounceDuration: 150,
  clickEffect: "spotlight",
  clickEffectColor: "#ffffff",
  clickEffectScale: 1,
  clickEffectOpacity: 0.7,
  clickEffectDurationMs: 400,
  sway: 0,
};

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Ask DeepSeek which events deserve zoom emphasis, and pick cursor styling.
 *
 * @param trace     The InteractionTrace from the recorder.
 * @param appUrl    The production URL (used to characterise the app type).
 */
export async function applySaliency(
  trace: InteractionTrace,
  appUrl = "",
): Promise<LlmSaliencyResult> {
  // Build a compact event summary for the prompt.
  const eventSummaries = trace.events.map((e, i) => ({
    index: i,
    action: e.action,
    role: e.role ?? "unknown",
    text: e.text?.slice(0, 60) ?? "",
    accessibleName: e.accessibleName?.slice(0, 60) ?? "",
    selector: e.selector.slice(0, 80),
    tMs: Math.round(e.tMs),
    computedCursor: e.computedCursor ?? "auto",
  }));

  const prompt = `You are a demo-video editor for a product demo of "${appUrl || "a web app"}".

Below is a JSON array of user interaction events captured during a Playwright recording.
Each event has: index, action, role, text, accessibleName, selector, tMs (ms from start), computedCursor.

EVENTS:
${JSON.stringify(eventSummaries, null, 2)}

Task: Decide which events deserve a camera zoom-in to highlight a key product feature.
Rules:
- Emphasize: typing into a key input, clicking a primary CTA, opening a meaningful result, filling an important field.
- Skip: incidental navigation, large scrolls, waits, page-load clicks with no visible output.
- Adjust depthBias (+1 = slightly deeper zoom, -1 = shallower); range -2 to +2.
- Set holdMs (0-2000) to hold the zoom longer on high-importance moments.
- Also pick a cursor style that matches the app's vibe:
    - "macos": polished consumer apps
    - "tahoe": clean productivity tools
    - "dot": precise design/dev tools
    - "figma": collaborative creation tools
- And a click effect: "none" | "spotlight" | "ripple" | "echo"

Return ONLY valid JSON (no markdown) matching this schema:
{
  "events": [
    { "index": 0, "emphasize": true, "depthBias": 0, "holdMs": 500, "reason": "..." },
    ...
  ],
  "cursorStyle": "macos",
  "cursorClickEffect": "spotlight",
  "appVibe": "one sentence description"
}

Include ALL events in the array (emphasize: false for skipped ones).`;

  try {
    const raw = await chat(
      [{ role: "user", content: prompt }],
      { model: DEEPSEEK_FAST_MODEL, maxTokens: 2048 },
    );

    const parsed = parseJson<LlmSaliencyResponse>(raw);

    // Build per-event lookup map
    const judgements = new Map<number, LlmEventJudgement>();
    for (const j of (parsed.events ?? [])) {
      judgements.set(j.index, j);
    }

    const saliency: SaliencyResolver = (event, index) => {
      const j = judgements.get(index);
      if (!j) return defaultSaliency(event, index);
      const hint: SaliencyHint = {
        emphasize: j.emphasize ?? false,
        depthBias: j.depthBias,
        holdMs: j.holdMs,
      };
      return hint;
    };

    const style = CURSOR_VISUAL_STYLES.includes(parsed.cursorStyle as typeof CURSOR_VISUAL_STYLES[number])
      ? parsed.cursorStyle
      : "macos";
    const clickEffect = CURSOR_CLICK_EFFECTS.includes(parsed.cursorClickEffect as typeof CURSOR_CLICK_EFFECTS[number])
      ? parsed.cursorClickEffect
      : "spotlight";

    const cursorVisual: CursorVisualSettings = {
      ...DEFAULT_CURSOR_VISUAL,
      style,
      clickEffect,
    };

    if (parsed.appVibe) {
      console.log(`  LLM app vibe: "${parsed.appVibe}"`);
    }
    console.log(`  LLM cursor: style=${style}, clickEffect=${clickEffect}`);

    const emphasized = [...judgements.values()].filter((j) => j.emphasize).length;
    console.log(`  LLM saliency: ${emphasized}/${trace.events.length} events emphasized`);

    return { saliency, cursorVisual };
  } catch (err) {
    console.warn(`  [saliency] LLM call failed, using defaults: ${String(err)}`);
    return {
      saliency: defaultSaliency,
      cursorVisual: DEFAULT_CURSOR_VISUAL,
    };
  }
}
