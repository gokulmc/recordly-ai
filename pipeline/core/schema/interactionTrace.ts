/**
 * The interaction trace — the cross-stage data contract produced by the recorder
 * (Playwright) and consumed by the derive/ stage. This is "the unlock": DOM/CSS
 * geometry captured at record time that the OS-level recorder never sees.
 *
 * Coordinate spaces:
 *  - All `bbox`/`containerBbox`/`visibleBbox` are in **CSS px within the layout
 *    viewport** (what Playwright `boundingBox()` returns), captured AFTER the
 *    action settles (+2× rAF).
 *  - They are mapped to **normalized source-frame coords (0-1)** by the affine
 *    `M` of the event's `CalibrationSegment` (see registration.ts).
 */

export interface Bbox {
	x: number;
	y: number;
	w: number;
	h: number;
}

export type InteractionAction =
	| "click"
	| "dblclick"
	| "rightclick"
	| "fill"
	| "type"
	| "hover"
	| "scroll"
	| "navigate"
	| "keypress"
	| "mousedown"
	| "mouseup";

export interface InteractionEvent {
	/** monotonic ms from recording frame-0 of this event's segment */
	tMs: number;
	/** which CalibrationSegment (and thus which affine M + clock anchor) applies */
	segmentId: number;
	action: InteractionAction;

	/** raw target bbox, CSS px in layout viewport (post-settle) */
	bbox: Bbox;
	/** bbox ∩ viewport, minus fixed/sticky occluders; preferred for framing */
	visibleBbox?: Bbox;
	/** elementFromPoint(focus) !== target → flag for vision fallback */
	occluded?: boolean;
	/** when geometry was sampled (post-settle), for debugging */
	layoutStableAtMs?: number;

	selector: string;
	/** What the script asked for (Target/selector), before any self-heal. */
	requestedSelector?: string;
	/** What actually matched (after fallback/heal), if different from requested. */
	resolvedSelector?: string;
	role?: string;
	accessibleName?: string;
	/** getComputedStyle(el).cursor — raw CSS value, mapped to recordly enum later */
	computedCursor?: string;
	text?: string;

	/** smallest meaningful enclosing container (form/dialog/region/listbox/card) */
	containerBbox?: Bbox;

	/** page scroll at sample time (bbox is viewport-relative) */
	scroll?: { x: number; y: number };
	visualViewport?: { w: number; h: number; offsetLeft: number; offsetTop: number };
	viewport: { w: number; h: number; dpr: number };

	url?: string;
}

/** A 2D affine: [u,v] = M·[x,y,1], mapping viewport CSS px → normalized source frame (0-1). */
export interface AffineTransform {
	/** u = a·x + b·y + c */
	a: number;
	b: number;
	c: number;
	/** v = d·x + e·y + f */
	d: number;
	e: number;
	f: number;
}

/**
 * One calibration epoch. A new segment begins at record start and after any
 * navigation / viewport-resize / DPR-change / capture-restart. Each owns its
 * own affine `M` and clock anchor, so a mid-demo change can't desync the trace.
 */
export interface CalibrationSegment {
	id: number;
	/** viewport CSS px → normalized source frame (0-1) */
	M: AffineTransform;
	/** least-squares residual (normalized units) — gate quality / fail closed */
	residual: number;
	/** clock anchors captured at the segment's beacon */
	anchor: {
		videoTimeMs: number;
		traceMonotonicMs: number;
		wallEpochMs: number;
	};
	viewport: { w: number; h: number; dpr: number };
}

export interface InteractionTrace {
	events: InteractionEvent[];
	segments: CalibrationSegment[];
	/** total duration of the recording in ms (frame-0 to end) */
	totalMs: number;
	/** raw source video pixel dimensions (the frame M maps into, normalized) */
	sourceFrame: { width: number; height: number };
}
