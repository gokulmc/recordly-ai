/**
 * Demo-script types consumed by the recorder (M3) and produced by the
 * script-gen stage (M5). Kept intentionally minimal — M3 only needs enough to
 * drive Playwright and capture the trace.
 */

import type { InteractionTrace } from "../schema/interactionTrace.js";

export type DemoAction =
	| "navigate"
	| "click"
	| "dblclick"
	| "rightclick"
	| "fill"
	| "type"
	| "hover"
	| "scroll"
	| "wait"
	| "keypress";

export interface DemoStep {
	action: DemoAction;
	/** For navigate */
	url?: string;
	/** CSS selector or Playwright text/role locator string */
	selector?: string;
	/** Value for fill / type */
	value?: string;
	/** Key name for keypress (e.g. "Enter") */
	key?: string;
	/** For scroll — positive = down */
	scrollDeltaY?: number;
	/** For wait — explicit pause in ms */
	waitMs?: number;
	/** Optional LLM narration hint (used by M4 saliency) */
	narration?: string;
}

export interface RecordingScript {
	startUrl: string;
	steps: DemoStep[];
	viewportWidth?: number;
	viewportHeight?: number;
}

export interface RecorderConfig {
	/** Directory where the recorded video will be saved */
	videoDir: string;
	headless?: boolean;
	/** How long to wait after each action for the page to settle (ms) */
	postActionSettleMs?: number;
}

export interface RecordingResult {
	videoPath: string;
	trace: InteractionTrace;
}
