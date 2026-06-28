/**
 * Assembles a .recordly project file + cursor sidecar from pipeline outputs.
 *
 * The resulting .recordly is valid input to recordly's smoke-export path:
 *   - Passes validateProjectData() on load
 *   - editor.zoomRegions survives normalizeProjectEditor() unchanged
 *   - Cursor sidecar passes normalizeCursorTelemetrySamples() unchanged
 *
 * The editor app fills in all other defaults via normalizeProjectEditor on load;
 * the pipeline only needs to write the fields it controls.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
	CURSOR_TELEMETRY_VERSION,
	createProjectData,
	getTelemetryPathForVideo,
	normalizeCursorTelemetrySamples,
	validateProjectData,
} from "recordly-project-format";
import type { CursorTelemetryPoint, CursorVisualSettings, ZoomRegion } from "recordly-project-format";

export interface ProjectBuildInput {
	videoPath: string;
	zoomRegions: ZoomRegion[];
	samples: CursorTelemetryPoint[];
	cursorVisual: CursorVisualSettings;
	outDir: string;
	projectId?: string;
}

export interface ProjectBuildResult {
	projectPath: string;
	sidecarPath: string;
	zoomRegionCount: number;
	sampleCount: number;
}

export async function buildProject(input: ProjectBuildInput): Promise<ProjectBuildResult> {
	const { videoPath, zoomRegions, samples, cursorVisual, outDir, projectId } = input;

	const editor = {
		zoomRegions,
		showCursor: true,
		loopCursor: false,
		cursorStyle: cursorVisual.style,
		cursorClickEffect: cursorVisual.clickEffect,
		cursorClickEffectColor: cursorVisual.clickEffectColor,
		cursorClickEffectScale: cursorVisual.clickEffectScale,
		cursorClickEffectOpacity: cursorVisual.clickEffectOpacity,
		cursorClickEffectDurationMs: cursorVisual.clickEffectDurationMs,
		cursorSize: cursorVisual.size,
		cursorSmoothing: cursorVisual.smoothing,
		cursorClickBounce: cursorVisual.clickBounce,
		cursorClickBounceDuration: cursorVisual.clickBounceDuration,
		cursorSway: cursorVisual.sway,
		cursorMotionBlur: cursorVisual.motionBlur,
	};

	const projectData = createProjectData(videoPath, editor, projectId);

	if (!validateProjectData(projectData)) {
		throw new Error("BUG: generated project failed validateProjectData()");
	}

	await fs.mkdir(outDir, { recursive: true });

	const projectPath = path.join(outDir, "project.recordly");
	await fs.writeFile(projectPath, JSON.stringify(projectData, null, 2), "utf-8");

	// Write cursor sidecar — pipeline is sole owner; recordly's native cursor
	// sampling must be disabled for the duration of the auto-demo capture (M3).
	const sidecarPath = getTelemetryPathForVideo(videoPath);
	const normalizedSamples = normalizeCursorTelemetrySamples(samples);
	await fs.writeFile(
		sidecarPath,
		JSON.stringify({ version: CURSOR_TELEMETRY_VERSION, samples: normalizedSamples }, null, 2),
		"utf-8",
	);

	return {
		projectPath,
		sidecarPath,
		zoomRegionCount: zoomRegions.length,
		sampleCount: normalizedSamples.length,
	};
}
