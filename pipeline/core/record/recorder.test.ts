/**
 * M3 recorder tests.
 *
 * Unit tests: pure syncBeacon helpers (no browser required).
 * Integration tests: full Playwright recording — only run when
 *   PLAYWRIGHT_INTEGRATION=1 env var is set (requires installed Chromium).
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPlaywrightVideoSegment, captureBeaconClock, perfNowToEventTms } from "./syncBeacon.js";
import type { RecordingScript } from "./types.js";

// ─────────────────────────────────────────────────────────────
// Unit: syncBeacon pure helpers
// ─────────────────────────────────────────────────────────────

describe("captureBeaconClock", () => {
	it("returns a non-negative videoTimeMs relative to recording start", () => {
		// recordingStartMonotonicMs must be a performance.now() value (not Date.now())
		const start = performance.now() - 1000; // pretend we started 1 second ago
		const clock = captureBeaconClock(start);
		expect(clock.videoTimeMs).toBeGreaterThanOrEqual(900); // at least ~1 s (allow ±100 ms jitter)
		expect(clock.traceMonotonicMs).toBeGreaterThanOrEqual(0);
		expect(clock.wallEpochMs).toBeGreaterThan(0);
	});

	it("videoTimeMs grows when called later", async () => {
		const start = performance.now(); // monotonic start
		const clock1 = captureBeaconClock(start);
		await new Promise((r) => setTimeout(r, 50));
		const clock2 = captureBeaconClock(start);
		expect(clock2.videoTimeMs).toBeGreaterThan(clock1.videoTimeMs);
	});
});

describe("buildPlaywrightVideoSegment", () => {
	it("produces a trusted scale-only segment (residual=0, M identity for 1:1 viewport)", () => {
		const clock = captureBeaconClock(0);
		const segment = buildPlaywrightVideoSegment({
			id: 0,
			viewport: { w: 1280, h: 720, dpr: 1 },
			clock,
		});
		expect(segment.residual).toBe(0);
		expect(segment.id).toBe(0);
		// Scale-only: M.a=1/1280, M.e=1/720, b=d=0, c=f=0
		expect(segment.M.a).toBeCloseTo(1 / 1280, 9);
		expect(segment.M.e).toBeCloseTo(1 / 720, 9);
		expect(segment.M.b).toBe(0);
		expect(segment.M.d).toBe(0);
		expect(segment.M.c).toBe(0);
		expect(segment.M.f).toBe(0);
	});

	it("stores the clock anchor verbatim", () => {
		const clock = captureBeaconClock(0);
		const segment = buildPlaywrightVideoSegment({
			id: 1,
			viewport: { w: 1920, h: 1080, dpr: 2 },
			clock,
		});
		expect(segment.anchor.traceMonotonicMs).toBe(clock.traceMonotonicMs);
		expect(segment.anchor.wallEpochMs).toBe(clock.wallEpochMs);
		expect(segment.anchor.videoTimeMs).toBe(clock.videoTimeMs);
		expect(segment.viewport).toEqual({ w: 1920, h: 1080, dpr: 2 });
	});
});

describe("perfNowToEventTms", () => {
	it("gives 0 for the anchor timestamp itself", () => {
		const clock = captureBeaconClock(0);
		const segment = buildPlaywrightVideoSegment({
			id: 0,
			viewport: { w: 1280, h: 720, dpr: 1 },
			clock,
		});
		expect(perfNowToEventTms(clock.traceMonotonicMs, segment)).toBe(0);
	});

	it("gives a positive value for a later timestamp", () => {
		const clock = captureBeaconClock(0);
		const segment = buildPlaywrightVideoSegment({
			id: 0,
			viewport: { w: 1280, h: 720, dpr: 1 },
			clock,
		});
		const later = clock.traceMonotonicMs + 500;
		expect(perfNowToEventTms(later, segment)).toBeCloseTo(500, 5);
	});

	it("clamps to 0 for timestamps before the anchor (clock skew guard)", () => {
		const clock = captureBeaconClock(0);
		const segment = buildPlaywrightVideoSegment({
			id: 0,
			viewport: { w: 1280, h: 720, dpr: 1 },
			clock,
		});
		const before = clock.traceMonotonicMs - 100;
		expect(perfNowToEventTms(before, segment)).toBe(0);
	});
});

// ─────────────────────────────────────────────────────────────
// Integration: full Playwright recording
// Only runs when PLAYWRIGHT_INTEGRATION=1
// ─────────────────────────────────────────────────────────────

const runIntegration = process.env["PLAYWRIGHT_INTEGRATION"] === "1";

describe.skipIf(!runIntegration)("recorder integration (PLAYWRIGHT_INTEGRATION=1)", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-rec-"));
	});
	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it("produces a video + trace from a minimal HTML page", async () => {
		// Write a minimal local HTML page to serve as the demo target
		const htmlPath = path.join(tmpDir, "index.html");
		await fs.writeFile(
			htmlPath,
			`<!DOCTYPE html>
<html>
<body>
  <button id="btn" style="cursor:pointer;padding:20px">Click me</button>
  <input id="inp" type="text" style="display:block;margin-top:20px" />
</body>
</html>`,
			"utf-8",
		);

		const { record } = await import("./recorder.js");

		const script: RecordingScript = {
			startUrl: `file://${htmlPath}`,
			steps: [
				{ action: "click", selector: "#btn" },
				{ action: "fill", selector: "#inp", value: "hello world" },
				{ action: "wait", waitMs: 200 },
			],
			viewportWidth: 1280,
			viewportHeight: 720,
		};

		const result = await record(script, { videoDir: tmpDir, headless: true });

		// Video file must exist and be non-empty
		const stat = await fs.stat(result.videoPath);
		expect(stat.size).toBeGreaterThan(0);

		// Trace must have at least the navigate + 2 interaction events
		expect(result.trace.events.length).toBeGreaterThanOrEqual(3);
		expect(result.trace.segments.length).toBeGreaterThanOrEqual(1);
		expect(result.trace.totalMs).toBeGreaterThan(0);
		expect(result.trace.sourceFrame).toEqual({ width: 1280, height: 720 });

		// Segment 0 must be trusted (residual=0 for scale-only)
		const seg0 = result.trace.segments[0]!;
		expect(seg0.residual).toBe(0);
		expect(seg0.M.a).toBeCloseTo(1 / 1280, 9);

		// The click event must have captured DOM facts
		const clickEvt = result.trace.events.find((e) => e.action === "click");
		expect(clickEvt).toBeDefined();
		expect(clickEvt?.bbox.w).toBeGreaterThan(0);
		expect(clickEvt?.bbox.h).toBeGreaterThan(0);
		expect(clickEvt?.computedCursor).toBe("pointer");

		// The fill event must capture text content
		const fillEvt = result.trace.events.find((e) => e.action === "fill");
		expect(fillEvt).toBeDefined();
		expect(fillEvt?.selector).toBe("#inp");
	});

	it("creates a new segment after a navigate step", async () => {
		const html1 = path.join(tmpDir, "page1.html");
		const html2 = path.join(tmpDir, "page2.html");
		await fs.writeFile(html1, "<html><body><a id='lnk' href='page2.html'>go</a></body></html>");
		await fs.writeFile(html2, "<html><body><p id='p'>arrived</p></body></html>");

		const { record } = await import("./recorder.js");

		const script: RecordingScript = {
			startUrl: `file://${html1}`,
			steps: [{ action: "navigate", url: `file://${html2}` }],
		};

		const result = await record(script, { videoDir: tmpDir, headless: true });
		// Initial beacon segment + navigate step creates another segment
		expect(result.trace.segments.length).toBeGreaterThanOrEqual(2);
	});
});
