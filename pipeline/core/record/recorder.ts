/**
 * Demo-script recorder — M3.
 *
 * Drives a browser via Playwright, captures DOM trace events, and returns the
 * recorded video + InteractionTrace.
 *
 * Two capture backends are supported:
 *
 *   "playwright" (default / M3 MVP):
 *     Playwright's built-in chromium video recorder.  M≈identity (viewport px =
 *     source-frame px).  Headless-capable.  Lower fidelity (VP8/webm).
 *
 *   "native" (M3 dual-track / production):
 *     recordly native capture (ScreenCaptureKit / WGC) provides 60fps pixels.
 *     Playwright drives the browser + renders fiducial markers at each segment
 *     boundary.  An affine M is solved from the fiducial detections and stored
 *     per CalibrationSegment.  Requires a display and the Electron main process.
 *     Set `config.backend = "native"` and provide `config.nativeOpts`.
 *
 * For each navigation in the script a new CalibrationSegment is created so the
 * clock stays valid across SPA route changes and cross-origin navigations.
 */

import { performance } from "node:perf_hooks";
import type { Page } from "playwright";
import type { InteractionTrace } from "../schema/interactionTrace.js";
import { capturePageContext, injectSyncBeacon } from "./domCapture.js";
import { FIDUCIAL_SPECS, detectFiducialsFromScreenshot, detectFiducialsFromVideoFrame, injectFiducials } from "./fiducials.js";
import {
	buildFiducialSegment,
	buildScaleOnlySegment,
	type FiducialObservation,
} from "../derive/registration.js";
import {
	buildPlaywrightVideoSegment,
	captureBeaconClock,
} from "./syncBeacon.js";
import {
	ACTION_TIMEOUT_MS,
	traceClick,
	traceDblClick,
	traceFill,
	traceHover,
	traceNavigate,
	traceScroll,
} from "./traceCapture.js";
import type { DemoStep, RecorderConfig, RecordingResult, RecordingScript } from "./types.js";
import { startPlaywrightVideoRecording } from "./captureBackends/playwrightVideo.js";
import type { NativeRecordlyOpts } from "./captureBackends/nativeRecordly.js";

const DEFAULT_POST_SETTLE_MS = 300;

/** Maximum allowed residual for a fiducial-solved segment (0-1 normalized). */
const MAX_FIDUCIAL_RESIDUAL = 0.01;

// ── Extended config types for dual-track ─────────────────────────────────────

export interface DualTrackConfig extends RecorderConfig {
	backend: "native";
	/** Unique title to set on the Playwright browser window for source selection. */
	windowTitle: string;
	/** Native backend transport (wraps process.send + onMessage). */
	nativeOpts: Pick<NativeRecordlyOpts, "send" | "onMessage">;
	/**
	 * Path to the native video output file as agreed with the Electron main.
	 * The native backend resolves this from the `native-capture:started` response.
	 */
	nativeOutputPath: string;
	/** Pixel dimensions of the recorded source frame (from native-capture:started). */
	sourceFrameWidth?: number;
	sourceFrameHeight?: number;
	/** ffmpeg binary path for frame extraction during fiducial detection. */
	ffmpegPath?: string;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Record a demo script and return the video + trace.
 *
 * The caller owns the output directory — callers should clean it up if the
 * recording fails mid-way.
 *
 * Backend selection:
 *   - `config.backend` unset / "playwright": use Playwright built-in video
 *   - `config.backend` = "native": dual-track (native capture + Playwright trace)
 */
export async function record(
	script: RecordingScript,
	config: RecorderConfig | DualTrackConfig,
): Promise<RecordingResult> {
	if ("backend" in config && config.backend === "native") {
		return recordDualTrack(script, config as DualTrackConfig);
	}
	return recordPlaywright(script, config);
}

// ── Playwright-video backend ──────────────────────────────────────────────────

async function recordPlaywright(
	script: RecordingScript,
	config: RecorderConfig,
): Promise<RecordingResult> {
	const vw = script.viewportWidth ?? 1280;
	const vh = script.viewportHeight ?? 720;
	const settleMs = config.postActionSettleMs ?? DEFAULT_POST_SETTLE_MS;

	const backend = await startPlaywrightVideoRecording({
		videoDir: config.videoDir,
		viewportWidth: vw,
		viewportHeight: vh,
		headless: config.headless ?? true,
	});

	const { page } = backend;
	const recordingStartMs = performance.now();

	const trace: InteractionTrace = {
		events: [],
		segments: [],
		totalMs: 0,
		sourceFrame: { width: vw, height: vh },
	};

	// Segment 0: inject sync beacon + fiducials for validation
	await openPlaywrightSegment(page, trace, recordingStartMs, vw, vh);

	// Navigate to the start URL
	await traceNavigate(page, trace, script.startUrl);

	// Execute each demo step
	for (const step of script.steps) {
		await executeStep(page, trace, step, settleMs, recordingStartMs, "playwright");
	}

	trace.totalMs = performance.now() - recordingStartMs;
	const videoPath = await backend.finalize();
	return { videoPath, trace };
}

// ── Dual-track backend ────────────────────────────────────────────────────────

async function recordDualTrack(
	script: RecordingScript,
	config: DualTrackConfig,
): Promise<RecordingResult> {
	const vw = script.viewportWidth ?? 1280;
	const vh = script.viewportHeight ?? 720;
	const settleMs = config.postActionSettleMs ?? DEFAULT_POST_SETTLE_MS;

	// Dynamic import to avoid importing native-backend IPC types in headless builds
	const { createNativeRecordlyBackend } = await import(
		"./captureBackends/nativeRecordly.js"
	);

	const nativeBackend = createNativeRecordlyBackend({
		windowTitle: config.windowTitle,
		outputPath: config.nativeOutputPath,
		send: config.nativeOpts.send,
		onMessage: config.nativeOpts.onMessage,
	});

	// Launch Playwright FIRST so the browser window exists and carries our unique
	// title BEFORE native capture searches for it by title. (Native capture keys
	// on the resolved windowId, so later navigations changing the title are fine.)
	const { chromium } = await import("playwright");
	const browser = await chromium.launch({ headless: false });
	const context = await browser.newContext({
		viewport: { width: vw, height: vh },
		deviceScaleFactor: 1,
	});
	const page = await context.newPage();

	// Give the window a unique, stable title for source discovery, then let the
	// OS window manager pick it up before we ask Electron to find the source.
	await page.goto("about:blank");
	await page.evaluate((title) => { document.title = title; }, config.windowTitle);
	await page.bringToFront();
	await page.waitForTimeout(800);

	// Now start native capture — the window exists and is titled. The started
	// response carries the real captured-source pixel dimensions.
	const started = await nativeBackend.start();
	const srcW = config.sourceFrameWidth ?? (started.sourceWidth > 0 ? started.sourceWidth : vw);
	const srcH = config.sourceFrameHeight ?? (started.sourceHeight > 0 ? started.sourceHeight : vh);

	const recordingStartMs = performance.now();

	const trace: InteractionTrace = {
		events: [],
		segments: [],
		totalMs: 0,
		sourceFrame: { width: srcW, height: srcH },
	};

	// Segment 0: inject fiducials + placeholder segment (post-solved after finalize)
	await openDualTrackSegment(page, trace, recordingStartMs, vw, vh, srcW, srcH);

	// Navigate to the start URL
	await traceNavigate(page, trace, script.startUrl);

	// Execute demo steps
	for (const step of script.steps) {
		await executeStep(page, trace, step, settleMs, recordingStartMs, "native", config, srcW, srcH);
	}

	trace.totalMs = performance.now() - recordingStartMs;

	await page.close();
	await context.close();
	await browser.close();

	const videoPath = await nativeBackend.finalize();

	// Post-solve: now that the native video is finalized, extract frames at each
	// segment's beacon timestamp and solve the true affine M from fiducial detections.
	if (config.ffmpegPath) {
		await postSolveSegments(trace, videoPath, config.ffmpegPath);
	}

	return { videoPath, trace };
}

// ── Segment helpers ───────────────────────────────────────────────────────────

/**
 * Open a new calibration segment for the Playwright-video path (M≈identity).
 * Also injects fiducials for optional validation — residual stays 0 since we
 * use buildPlaywrightVideoSegment (scale-only, exact for this backend).
 */
async function openPlaywrightSegment(
	page: Page,
	trace: InteractionTrace,
	recordingStartMs: number,
	vw: number,
	vh: number,
): Promise<void> {
	await injectSyncBeacon(page);
	await injectFiducials(page);

	const clock = captureBeaconClock(recordingStartMs);
	const dpr = await page.evaluate(() => window.devicePixelRatio || 1);
	const segment = buildPlaywrightVideoSegment({
		id: trace.segments.length,
		viewport: { w: vw, h: vh, dpr },
		clock,
	});
	trace.segments.push(segment);
}

/**
 * Open a new calibration segment for the dual-track path.
 *
 * Injects fiducials + sync beacon and creates a placeholder scale-only segment.
 * The M will be updated post-recording by `postSolveSegments` once the native
 * video is finalized and frames can be extracted.
 *
 * We record the viewport dimensions in the segment so post-solve can reference
 * the source-frame size from the segment itself.
 */
async function openDualTrackSegment(
	page: Page,
	trace: InteractionTrace,
	recordingStartMs: number,
	vw: number,
	vh: number,
	srcW: number,
	srcH: number,
): Promise<void> {
	await injectSyncBeacon(page);
	await injectFiducials(page);

	const clock = captureBeaconClock(recordingStartMs);
	const dpr = await page.evaluate(() => window.devicePixelRatio || 1);

	// Placeholder: scale-only segment, residual > MAX marks it as needs-post-solve
	const placeholder = buildScaleOnlySegment({
		id: trace.segments.length,
		viewport: { w: vw, h: vh, dpr },
		anchor: clock,
	});
	// Residual > MAX_FIDUCIAL_RESIDUAL → isSegmentTrusted() returns false until post-solve
	const pending = { ...placeholder, residual: MAX_FIDUCIAL_RESIDUAL + 0.001 };

	// Remember source dimensions in the segment for post-solve (stored as part of viewport)
	// We'll use the trace.sourceFrame for srcW/srcH in postSolveSegments.
	void srcW; void srcH; // used in postSolveSegments via trace.sourceFrame
	trace.segments.push(pending);
}

/**
 * Post-solve all pending calibration segments in the dual-track trace.
 *
 * For each segment whose residual > MAX_FIDUCIAL_RESIDUAL (i.e. placeholder),
 * extract the native video frame at the segment's clock anchor, detect the
 * fiducials, and solve the affine M. Segments that fail detection remain
 * with the placeholder M (still fail-closed via isSegmentTrusted).
 */
async function postSolveSegments(
	trace: InteractionTrace,
	videoPath: string,
	ffmpegPath: string,
): Promise<void> {
	const srcW = trace.sourceFrame.width;
	const srcH = trace.sourceFrame.height;

	for (let i = 0; i < trace.segments.length; i++) {
		const seg = trace.segments[i];
		if (!seg || seg.residual <= MAX_FIDUCIAL_RESIDUAL) continue;

		const vw = seg.viewport.w;
		const vh = seg.viewport.h;
		const dpr = seg.viewport.dpr;

		const detections = await detectFiducialsFromVideoFrame({
			videoPath,
			timeMs: seg.anchor.videoTimeMs,
			viewportWidth: vw,
			viewportHeight: vh,
			sourceFrameWidth: srcW,
			sourceFrameHeight: srcH,
			ffmpegPath,
		});

		if (!detections || detections.length < 3) continue;

		const fiducials: FiducialObservation[] = detections.map((d) => ({
			// Where we injected (CSS px in viewport) = expectedX/Y
			viewport: { x: d.expectedX, y: d.expectedY },
			// Where detected in the native frame, normalized 0-1
			frameNorm: { u: d.detectedX / srcW, v: d.detectedY / srcH },
		}));

		try {
			const solved = buildFiducialSegment({
				id: seg.id,
				viewport: { w: vw, h: vh, dpr },
				anchor: seg.anchor,
				fiducials,
			});
			trace.segments[i] = solved;
		} catch {
			// Leave as placeholder — isSegmentTrusted() will gate it out
		}
	}
}

// ── Step execution ────────────────────────────────────────────────────────────

async function executeStep(
	page: Page,
	trace: InteractionTrace,
	step: DemoStep,
	settleMs: number,
	recordingStartMs: number,
	backendType: "playwright" | "native",
	_dualTrackConfig?: DualTrackConfig,
	srcW?: number,
	srcH?: number,
): Promise<void> {
	// Remember viewport before the step to detect changes (navigation, resize)
	const vpBefore = trace.segments[trace.segments.length - 1]?.viewport;

	switch (step.action) {
		case "navigate": {
			if (!step.url) throw new Error("navigate step requires a url");
			await traceNavigate(page, trace, step.url);
			// After navigation: re-inject fiducials + open a fresh calibration segment
			const ctx = await capturePageContext(page);
			if (backendType === "native" && srcW && srcH) {
				await openDualTrackSegment(
					page, trace, recordingStartMs,
					ctx.viewport.w, ctx.viewport.h, srcW, srcH,
				);
			} else {
				await openPlaywrightSegment(
					page, trace, recordingStartMs,
					ctx.viewport.w, ctx.viewport.h,
				);
			}
			break;
		}
		case "click": {
			if (!step.selector) throw new Error("click step requires a selector");
			try {
				await traceClick(page, trace, step.selector);
			} catch (err) {
				console.warn(`  [recorder] click "${step.selector}" failed, skipping: ${String(err).split("\n")[0]}`);
			}
			break;
		}
		case "dblclick": {
			if (!step.selector) throw new Error("dblclick step requires a selector");
			try {
				await traceDblClick(page, trace, step.selector);
			} catch (err) {
				console.warn(`  [recorder] dblclick "${step.selector}" failed, skipping: ${String(err).split("\n")[0]}`);
			}
			break;
		}
		case "fill": {
			if (!step.selector) throw new Error("fill step requires a selector");
			try {
				await traceFill(page, trace, step.selector, step.value ?? "");
			} catch (err) {
				console.warn(`  [recorder] fill "${step.selector}" failed, skipping: ${String(err).split("\n")[0]}`);
			}
			break;
		}
		case "hover": {
			if (!step.selector) throw new Error("hover step requires a selector");
			try {
				await traceHover(page, trace, step.selector);
			} catch (err) {
				console.warn(`  [recorder] hover "${step.selector}" failed, skipping: ${String(err).split("\n")[0]}`);
			}
			break;
		}
		case "scroll": {
			await traceScroll(page, trace, step.scrollDeltaY ?? 300);
			break;
		}
		case "wait": {
			await page.waitForTimeout(step.waitMs ?? 500);
			break;
		}
		case "keypress": {
			if (!step.key) throw new Error("keypress step requires a key");
			await page.keyboard.press(step.key);
			break;
		}
		case "type": {
			if (!step.selector) throw new Error("type step requires a selector");
			try {
				await page.locator(step.selector).first().pressSequentially(step.value ?? "", { timeout: ACTION_TIMEOUT_MS });
			} catch (err) {
				console.warn(`  [recorder] type "${step.selector}" failed, skipping: ${String(err).split("\n")[0]}`);
			}
			break;
		}
	}

	// If the viewport changed (SPA resize triggered by the action), re-calibrate
	const vpAfter = await page.evaluate(() => ({
		w: window.innerWidth,
		h: window.innerHeight,
		dpr: window.devicePixelRatio || 1,
	}));
	if (
		vpBefore &&
		(vpAfter.w !== vpBefore.w ||
			vpAfter.h !== vpBefore.h ||
			vpAfter.dpr !== vpBefore.dpr)
	) {
		if (backendType === "native" && srcW && srcH) {
			await openDualTrackSegment(
				page, trace, recordingStartMs,
				vpAfter.w, vpAfter.h, srcW, srcH,
			);
		} else {
			await openPlaywrightSegment(
				page, trace, recordingStartMs,
				vpAfter.w, vpAfter.h,
			);
		}
	}

	if (settleMs > 0) {
		await page.waitForTimeout(settleMs);
	}
}
