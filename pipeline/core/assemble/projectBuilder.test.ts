import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CURSOR_TELEMETRY_VERSION,
	DEFAULT_CURSOR_VISUAL_SETTINGS,
	normalizeCursorTelemetrySamples,
	validateProjectData,
} from "recordly-project-format";
import { deriveCursorTelemetry } from "../derive/cursorDeriver.js";
import { deriveZoomRegions } from "../derive/zoomDeriver.js";
import { sampleTrace } from "../derive/__fixtures__/sampleTrace.js";
import { buildProject } from "./projectBuilder.js";

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-pb-test-"));
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("buildProject", () => {
	it("writes a .recordly file that passes validateProjectData()", async () => {
		const videoPath = path.join(tmpDir, "demo.mp4");
		// Create a placeholder video file so the sidecar path is meaningful
		await fs.writeFile(videoPath, Buffer.alloc(0));

		const { regions } = deriveZoomRegions(sampleTrace);
		const { samples } = deriveCursorTelemetry(sampleTrace);

		const result = await buildProject({
			videoPath,
			zoomRegions: regions,
			samples,
			cursorVisual: DEFAULT_CURSOR_VISUAL_SETTINGS,
			outDir: tmpDir,
		});

		const raw = JSON.parse(await fs.readFile(result.projectPath, "utf-8"));
		expect(validateProjectData(raw)).toBe(true);
		expect(raw.version).toBe(1);
		expect(raw.videoPath).toBe(videoPath);
	});

	it("preserves zoom regions verbatim in the project file", async () => {
		const videoPath = path.join(tmpDir, "demo.mp4");
		await fs.writeFile(videoPath, Buffer.alloc(0));

		const { regions } = deriveZoomRegions(sampleTrace);
		const { samples } = deriveCursorTelemetry(sampleTrace);

		const result = await buildProject({
			videoPath,
			zoomRegions: regions,
			samples,
			cursorVisual: DEFAULT_CURSOR_VISUAL_SETTINGS,
			outDir: tmpDir,
		});

		const raw = JSON.parse(await fs.readFile(result.projectPath, "utf-8"));
		expect(raw.editor.zoomRegions).toHaveLength(regions.length);
		for (const [i, region] of regions.entries()) {
			expect(raw.editor.zoomRegions[i].id).toBe(region.id);
			expect(raw.editor.zoomRegions[i].depth).toBe(region.depth);
			expect(raw.editor.zoomRegions[i].startMs).toBe(region.startMs);
			expect(raw.editor.zoomRegions[i].endMs).toBe(region.endMs);
		}
	});

	it("writes a cursor sidecar that passes normalizeCursorTelemetrySamples()", async () => {
		const videoPath = path.join(tmpDir, "demo.mp4");
		await fs.writeFile(videoPath, Buffer.alloc(0));

		const { samples } = deriveCursorTelemetry(sampleTrace);

		const result = await buildProject({
			videoPath,
			zoomRegions: [],
			samples,
			cursorVisual: DEFAULT_CURSOR_VISUAL_SETTINGS,
			outDir: tmpDir,
		});

		expect(result.sidecarPath).toBe(`${videoPath}.cursor.json`);
		const raw = JSON.parse(await fs.readFile(result.sidecarPath, "utf-8"));
		expect(raw.version).toBe(CURSOR_TELEMETRY_VERSION);

		const normalized = normalizeCursorTelemetrySamples(raw.samples);
		expect(normalized.length).toBe(raw.samples.length);
		expect(normalized.every((s) => s.cx >= 0 && s.cx <= 1)).toBe(true);
		expect(normalized.every((s) => s.cy >= 0 && s.cy <= 1)).toBe(true);
	});

	it("reports counts matching the derived data", async () => {
		const videoPath = path.join(tmpDir, "demo.mp4");
		await fs.writeFile(videoPath, Buffer.alloc(0));

		const { regions } = deriveZoomRegions(sampleTrace);
		const { samples } = deriveCursorTelemetry(sampleTrace);

		const result = await buildProject({
			videoPath,
			zoomRegions: regions,
			samples,
			cursorVisual: DEFAULT_CURSOR_VISUAL_SETTINGS,
			outDir: tmpDir,
		});

		expect(result.zoomRegionCount).toBe(regions.length);
		expect(result.sampleCount).toBeGreaterThan(0);
		expect(result.sampleCount).toBe(samples.length); // no samples dropped (all valid)
	});

	it("embeds cursor visual settings in the project editor state", async () => {
		const videoPath = path.join(tmpDir, "demo.mp4");
		await fs.writeFile(videoPath, Buffer.alloc(0));

		const customVisual = {
			...DEFAULT_CURSOR_VISUAL_SETTINGS,
			style: "dot" as const,
			clickEffect: "ripple" as const,
			clickEffectColor: "#FF0000",
		};

		const result = await buildProject({
			videoPath,
			zoomRegions: [],
			samples: [],
			cursorVisual: customVisual,
			outDir: tmpDir,
		});

		const raw = JSON.parse(await fs.readFile(result.projectPath, "utf-8"));
		expect(raw.editor.cursorStyle).toBe("dot");
		expect(raw.editor.cursorClickEffect).toBe("ripple");
		expect(raw.editor.cursorClickEffectColor).toBe("#FF0000");
		expect(raw.editor.showCursor).toBe(true);
	});
});
