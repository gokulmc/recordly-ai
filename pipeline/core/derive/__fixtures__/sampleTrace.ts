/**
 * A hand-authored InteractionTrace fixture standing in for an M1 Playwright
 * recording: a 1280×720 source frame with a scale-only (frame===viewport)
 * calibration segment, and a handful of actions.
 */

import { buildScaleOnlySegment } from "../registration.js";
import type { InteractionEvent, InteractionTrace } from "../../schema/interactionTrace.js";

const VIEWPORT = { w: 1280, h: 720, dpr: 1 };

const segment = buildScaleOnlySegment({
	id: 0,
	viewport: VIEWPORT,
	anchor: { videoTimeMs: 0, traceMonotonicMs: 0, wallEpochMs: 1_700_000_000_000 },
});

function ev(partial: Partial<InteractionEvent> & Pick<InteractionEvent, "tMs" | "action" | "bbox">): InteractionEvent {
	return {
		segmentId: 0,
		selector: "button",
		viewport: VIEWPORT,
		...partial,
	};
}

const events: InteractionEvent[] = [
	// Cluster 1: two clicks on a large card, ~0.5s apart (merge into one zoom).
	ev({
		tMs: 1000,
		action: "click",
		bbox: { x: 600, y: 300, w: 80, h: 32 },
		containerBbox: { x: 500, y: 250, w: 300, h: 200 },
		role: "button",
		computedCursor: "pointer",
		text: "Create",
	}),
	ev({
		tMs: 1500,
		action: "click",
		bbox: { x: 600, y: 360, w: 80, h: 32 },
		containerBbox: { x: 500, y: 250, w: 300, h: 200 },
		role: "button",
		computedCursor: "pointer",
		text: "Confirm",
	}),
	// Cluster 2: a single click on a tiny icon (small element → deep zoom).
	ev({
		tMs: 6000,
		action: "click",
		bbox: { x: 100, y: 100, w: 24, h: 24 },
		containerBbox: { x: 90, y: 90, w: 44, h: 44 },
		role: "button",
		computedCursor: "pointer",
		text: "",
		accessibleName: "Settings",
	}),
	// A text-field fill — NOT an explicit click, so no zoom; but it shapes the cursor (I-beam).
	ev({
		tMs: 9000,
		action: "fill",
		bbox: { x: 300, y: 500, w: 400, h: 40 },
		role: "textbox",
		computedCursor: "text",
		text: "hello@example.com",
	}),
];

export const sampleTrace: InteractionTrace = {
	events,
	segments: [segment],
	totalMs: 11_000,
	sourceFrame: { width: 1280, height: 720 },
};
