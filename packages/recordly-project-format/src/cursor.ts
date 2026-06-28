/**
 * Cursor telemetry helpers — pure path math + sample normalization (no Electron).
 * writeCursorTelemetry uses Node.js fs and is safe in the pipeline child process.
 */

import fs from "node:fs/promises";
import type { CursorTelemetryPoint } from "./types.js";
import { CURSOR_TELEMETRY_VERSION } from "./types.js";

export function getTelemetryPathForVideo(videoPath: string): string {
	return `${videoPath}.cursor.json`;
}

const MAX_CURSOR_SAMPLES = 60 * 60 * 30; // 1 hour @ 30Hz

export function normalizeCursorTelemetrySamples(rawSamples: unknown): CursorTelemetryPoint[] {
	const samples = Array.isArray(rawSamples)
		? rawSamples
		: Array.isArray(
				(rawSamples as { samples?: unknown[] } | null | undefined)?.samples,
			)
			? ((rawSamples as { samples: unknown[] }).samples ?? [])
			: [];

	const boundedSamples = samples.slice(0, MAX_CURSOR_SAMPLES);

	return boundedSamples
		.filter((sample: unknown) => Boolean(sample && typeof sample === "object"))
		.map((sample: unknown) => {
			const point = sample as Partial<CursorTelemetryPoint>;
			const clamp = (v: number) => Math.min(1, Math.max(0, v));
			return {
				timeMs:
					typeof point.timeMs === "number" && Number.isFinite(point.timeMs)
						? Math.max(0, point.timeMs)
						: 0,
				cx:
					typeof point.cx === "number" && Number.isFinite(point.cx)
						? clamp(point.cx)
						: 0.5,
				cy:
					typeof point.cy === "number" && Number.isFinite(point.cy)
						? clamp(point.cy)
						: 0.5,
				interactionType:
					point.interactionType === "click" ||
					point.interactionType === "double-click" ||
					point.interactionType === "right-click" ||
					point.interactionType === "middle-click" ||
					point.interactionType === "move" ||
					point.interactionType === "mouseup"
						? point.interactionType
						: undefined,
				cursorType:
					point.cursorType === "arrow" ||
					point.cursorType === "text" ||
					point.cursorType === "pointer" ||
					point.cursorType === "crosshair" ||
					point.cursorType === "open-hand" ||
					point.cursorType === "closed-hand" ||
					point.cursorType === "resize-ew" ||
					point.cursorType === "resize-ns" ||
					point.cursorType === "not-allowed"
						? point.cursorType
						: undefined,
			};
		})
		.sort((a, b) => a.timeMs - b.timeMs);
}

export async function writeCursorTelemetry(
	videoPath: string,
	samples: unknown,
): Promise<CursorTelemetryPoint[]> {
	const telemetryPath = getTelemetryPathForVideo(videoPath);
	const normalizedSamples = normalizeCursorTelemetrySamples(samples);

	if (normalizedSamples.length === 0) {
		await fs.rm(telemetryPath, { force: true });
		return normalizedSamples;
	}

	await fs.writeFile(
		telemetryPath,
		JSON.stringify({ version: CURSOR_TELEMETRY_VERSION, samples: normalizedSamples }, null, 2),
		"utf-8",
	);

	return normalizedSamples;
}
