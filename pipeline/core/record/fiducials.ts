/**
 * Fiducial marker injection + detection for dual-track calibration.
 *
 * Renders 8 colored squares at the corners and edge midpoints of the viewport.
 * These appear in both the Playwright screenshot and the native video frame,
 * letting registration.ts solve the affine M that maps viewport CSS px → the
 * raw source-video normalized (0-1) frame.
 *
 * Detection strategy:
 *   - Playwright-video / validation:  page.screenshot() → sample known positions
 *   - Native video:  ffmpeg extract frame at videoTimeMs → sample raw RGB
 *
 * Fiducial colors are vivid, saturated, and mutually distinct so they survive
 * H.264/VP8 chroma compression. The 24×24 px size means the center pixel is
 * unambiguous even with DCT-block artifacts.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Page } from "playwright";

const execFileAsync = promisify(execFile);

// ── Spec ──────────────────────────────────────────────────────────────────────

export interface FiducialSpec {
	/** Normalized position in the viewport (0-1 each axis). */
	normX: number;
	normY: number;
	/** CSS hex color e.g. "#FF0000". */
	color: string;
	/** Human label for debug. */
	label: string;
}

/** 8 fiducials: corners + edge midpoints. */
export const FIDUCIAL_SPECS: FiducialSpec[] = [
	{ normX: 0, normY: 0, color: "#FF0000", label: "TL" },
	{ normX: 1, normY: 0, color: "#00FF00", label: "TR" },
	{ normX: 0, normY: 1, color: "#0000FF", label: "BL" },
	{ normX: 1, normY: 1, color: "#FFFF00", label: "BR" },
	{ normX: 0.5, normY: 0, color: "#FF00FF", label: "TM" },
	{ normX: 0, normY: 0.5, color: "#00FFFF", label: "ML" },
	{ normX: 1, normY: 0.5, color: "#FF8800", label: "MR" },
	{ normX: 0.5, normY: 1, color: "#7700FF", label: "BM" },
];

/** px size of each fiducial square (post-DPR: CSS px). */
const FIDUCIAL_SIZE_PX = 24;
/** px inset from the viewport edge so markers aren't clipped. */
const FIDUCIAL_INSET_PX = 4;
/** Unique id for the overlay element so we can remove it later. */
const OVERLAY_ID = "__recordly_fiducials__";

// ── Injection ─────────────────────────────────────────────────────────────────

/**
 * Inject an overlay of 8 fiducial markers into the page.
 * Call this BEFORE recording starts so the markers appear from frame-0.
 * The overlay sits above all page content (z-index: 2147483647) and does not
 * affect layout.
 */
export async function injectFiducials(page: Page): Promise<void> {
	await page.evaluate(
		({ specs, size, inset, overlayId }) => {
			const existing = document.getElementById(overlayId);
			if (existing) existing.remove();

			const overlay = document.createElement("div");
			overlay.id = overlayId;
			overlay.style.cssText =
				"position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2147483647;overflow:hidden;";

			for (const spec of specs) {
				const el = document.createElement("div");
				const vw = window.innerWidth;
				const vh = window.innerHeight;
				const cx = Math.round(spec.normX * vw);
				const cy = Math.round(spec.normY * vh);
				const half = Math.round(size / 2);
				const rawLeft = cx - half;
				const rawTop = cy - half;
				// Clamp to inset so markers stay visible
				const left = Math.max(inset, Math.min(vw - size - inset, rawLeft));
				const top = Math.max(inset, Math.min(vh - size - inset, rawTop));
				el.style.cssText = `position:absolute;left:${left}px;top:${top}px;width:${size}px;height:${size}px;background:${spec.color};`;
				overlay.appendChild(el);
			}

			document.body.appendChild(overlay);
		},
		{ specs: FIDUCIAL_SPECS, size: FIDUCIAL_SIZE_PX, inset: FIDUCIAL_INSET_PX, overlayId: OVERLAY_ID },
	);
}

/**
 * Remove the fiducial overlay from the page.
 */
export async function removeFiducials(page: Page): Promise<void> {
	await page.evaluate((overlayId) => {
		document.getElementById(overlayId)?.remove();
	}, OVERLAY_ID);
}

// ── Detection from Playwright screenshot ──────────────────────────────────────

export interface FiducialDetection {
	spec: FiducialSpec;
	/** Detected pixel position in the screenshot (CSS px, integer). */
	detectedX: number;
	detectedY: number;
	/** Expected position (what we injected). */
	expectedX: number;
	expectedY: number;
}

/**
 * Detect fiducials from a Playwright page screenshot.
 *
 * Takes a screenshot, samples a small region around each expected fiducial
 * position, and finds the pixel closest to the expected color.
 *
 * For the Playwright-video backend the result should be near-perfect (same
 * rendering engine), so this is used both for validation and for building the
 * CalibrationSegment.
 */
export async function detectFiducialsFromScreenshot(
	page: Page,
): Promise<FiducialDetection[]> {
	// Playwright returns a PNG buffer from screenshots
	const pngBuf = await page.screenshot({ type: "png" });

	// Parse viewport size from the page
	const viewport = await page.evaluate(() => ({
		w: window.innerWidth,
		h: window.innerHeight,
		dpr: window.devicePixelRatio || 1,
	}));

	// Decode the PNG to raw RGBA using Playwright's built-in PNG support
	// We'll use a minimal PNG parser using Node.js Uint8Array chunks
	const rgba = decodePngToRgba(pngBuf);
	if (!rgba) {
		throw new Error("fiducials: failed to decode screenshot PNG");
	}

	const { data, width, height } = rgba;

	const detections: FiducialDetection[] = [];
	const half = Math.round(FIDUCIAL_SIZE_PX / 2);
	const searchR = FIDUCIAL_SIZE_PX + 8; // search radius in screen px

	for (const spec of FIDUCIAL_SPECS) {
		const vw = viewport.w;
		const vh = viewport.h;
		const cx = Math.round(spec.normX * vw);
		const cy = Math.round(spec.normY * vh);
		const rawLeft = cx - half;
		const rawTop = cy - half;
		const expectedX = Math.max(FIDUCIAL_INSET_PX, Math.min(vw - FIDUCIAL_SIZE_PX - FIDUCIAL_INSET_PX, rawLeft)) + half;
		const expectedY = Math.max(FIDUCIAL_INSET_PX, Math.min(vh - FIDUCIAL_SIZE_PX - FIDUCIAL_INSET_PX, rawTop)) + half;

		// Expected pixel position in the screenshot (accounting for DPR)
		const imgX = Math.round(expectedX * viewport.dpr);
		const imgY = Math.round(expectedY * viewport.dpr);

		const targetRgb = hexToRgb(spec.color);
		if (!targetRgb) continue;

		// Search a region around the expected position for the best color match
		const searchPx = Math.round(searchR * viewport.dpr);
		let bestDist = Infinity;
		let bestX = imgX;
		let bestY = imgY;

		for (let dy = -searchPx; dy <= searchPx; dy++) {
			for (let dx = -searchPx; dx <= searchPx; dx++) {
				const px = imgX + dx;
				const py = imgY + dy;
				if (px < 0 || py < 0 || px >= width || py >= height) continue;
				const idx = (py * width + px) * 4;
				const r = data[idx] ?? 0;
				const g = data[idx + 1] ?? 0;
				const b = data[idx + 2] ?? 0;
				const dist = colorDistSq(r, g, b, targetRgb.r, targetRgb.g, targetRgb.b);
				if (dist < bestDist) {
					bestDist = dist;
					bestX = px;
					bestY = py;
				}
			}
		}

		// Convert back to CSS px
		detections.push({
			spec,
			detectedX: Math.round(bestX / viewport.dpr),
			detectedY: Math.round(bestY / viewport.dpr),
			expectedX,
			expectedY,
		});
	}

	return detections;
}

// ── Detection from native video frame ─────────────────────────────────────────

/**
 * Extract a single frame from a native video at `timeMs` using ffmpeg,
 * detect fiducials in the raw RGB frame, and return their positions in the
 * source frame's normalized (0-1) space.
 *
 * Requires: `ffmpegPath` (the ffmpeg binary used by recordly).
 *
 * Returns `null` if ffmpeg extraction fails — caller should fall back to the
 * scale-only segment and mark the segment as untrusted.
 */
export async function detectFiducialsFromVideoFrame(opts: {
	videoPath: string;
	timeMs: number;
	viewportWidth: number;
	viewportHeight: number;
	sourceFrameWidth: number;
	sourceFrameHeight: number;
	ffmpegPath: string;
}): Promise<FiducialDetection[] | null> {
	const {
		videoPath,
		timeMs,
		viewportWidth,
		viewportHeight,
		sourceFrameWidth,
		sourceFrameHeight,
		ffmpegPath,
	} = opts;

	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "recordly-fid-"));
	const rawPath = path.join(tmpDir, "frame.rgb");

	try {
		// Extract a single frame at timeMs as raw 24-bit RGB
		const timeSec = (timeMs / 1000).toFixed(6);
		await execFileAsync(ffmpegPath, [
			"-ss", timeSec,
			"-i", videoPath,
			"-frames:v", "1",
			"-f", "rawvideo",
			"-pix_fmt", "rgb24",
			rawPath,
		]);

		const rawBuf = await fs.readFile(rawPath);
		const expectedBytes = sourceFrameWidth * sourceFrameHeight * 3;
		if (rawBuf.length !== expectedBytes) {
			return null;
		}

		const detections: FiducialDetection[] = [];
		const half = Math.round(FIDUCIAL_SIZE_PX / 2);
		const searchR = FIDUCIAL_SIZE_PX + 8;

		for (const spec of FIDUCIAL_SPECS) {
			const vw = viewportWidth;
			const vh = viewportHeight;
			const cx = Math.round(spec.normX * vw);
			const cy = Math.round(spec.normY * vh);
			const rawLeft = cx - half;
			const rawTop = cy - half;
			const expectedCssX = Math.max(FIDUCIAL_INSET_PX, Math.min(vw - FIDUCIAL_SIZE_PX - FIDUCIAL_INSET_PX, rawLeft)) + half;
			const expectedCssY = Math.max(FIDUCIAL_INSET_PX, Math.min(vh - FIDUCIAL_SIZE_PX - FIDUCIAL_INSET_PX, rawTop)) + half;

			// The native frame is sourceFrameWidth×sourceFrameHeight; the browser
			// viewport is viewportWidth×viewportHeight. We need an estimated scale
			// factor for the search, assuming the window fills the frame.
			const scaleX = sourceFrameWidth / vw;
			const scaleY = sourceFrameHeight / vh;
			const imgX = Math.round(expectedCssX * scaleX);
			const imgY = Math.round(expectedCssY * scaleY);

			const targetRgb = hexToRgb(spec.color);
			if (!targetRgb) continue;

			const searchPxX = Math.round(searchR * scaleX);
			const searchPxY = Math.round(searchR * scaleY);
			let bestDist = Infinity;
			let bestX = imgX;
			let bestY = imgY;

			for (let dy = -searchPxY; dy <= searchPxY; dy++) {
				for (let dx = -searchPxX; dx <= searchPxX; dx++) {
					const px = imgX + dx;
					const py = imgY + dy;
					if (px < 0 || py < 0 || px >= sourceFrameWidth || py >= sourceFrameHeight) continue;
					const idx = (py * sourceFrameWidth + px) * 3;
					const r = rawBuf[idx] ?? 0;
					const g = rawBuf[idx + 1] ?? 0;
					const b = rawBuf[idx + 2] ?? 0;
					const dist = colorDistSq(r, g, b, targetRgb.r, targetRgb.g, targetRgb.b);
					if (dist < bestDist) {
						bestDist = dist;
						bestX = px;
						bestY = py;
					}
				}
			}

			detections.push({
				spec,
				detectedX: bestX,
				detectedY: bestY,
				expectedX: Math.round(expectedCssX * scaleX),
				expectedY: Math.round(expectedCssY * scaleY),
			});
		}

		return detections;
	} catch {
		return null;
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => void 0);
	}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
	const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
	if (!m || !m[1] || !m[2] || !m[3]) return null;
	return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

function colorDistSq(r: number, g: number, b: number, tr: number, tg: number, tb: number): number {
	return (r - tr) ** 2 + (g - tg) ** 2 + (b - tb) ** 2;
}

/**
 * Minimal PNG decoder for fiducial detection.
 *
 * We only need pixel data from Playwright screenshots. Rather than pulling in
 * a full image library, we use Node's built-in zlib to inflate the IDAT chunk
 * and reconstruct the raw RGBA scanlines with the standard PNG filter algorithms.
 *
 * Handles bit depth 8 only, color types 2 (RGB) and 6 (RGBA). Returns null
 * if the PNG is malformed or an unsupported subformat.
 */
function decodePngToRgba(
	buf: Buffer,
): { data: Uint8Array; width: number; height: number } | null {
	// PNG signature
	if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) {
		return null;
	}

	let width = 0;
	let height = 0;
	let bitDepth = 0;
	let colorType = 0;
	const idatChunks: Buffer[] = [];

	let offset = 8;
	while (offset < buf.length) {
		const length = buf.readUInt32BE(offset);
		const type = buf.toString("ascii", offset + 4, offset + 8);
		const data = buf.subarray(offset + 8, offset + 8 + length);

		if (type === "IHDR") {
			width = buf.readUInt32BE(offset + 8);
			height = buf.readUInt32BE(offset + 12);
			bitDepth = buf[offset + 16] ?? 0;
			colorType = buf[offset + 17] ?? 0;
		} else if (type === "IDAT") {
			idatChunks.push(data);
		} else if (type === "IEND") {
			break;
		}

		offset += 12 + length;
	}

	if (!width || !height || bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
		return null;
	}

	const channels = colorType === 6 ? 4 : 3;
	const rawBuf = require("zlib").inflateSync(Buffer.concat(idatChunks)) as Buffer;

	const stride = width * channels;
	const rawData = new Uint8Array(width * height * 4);

	for (let y = 0; y < height; y++) {
		const rowStart = y * (stride + 1);
		const filterType = rawBuf[rowStart] ?? 0;
		const row = rawBuf.subarray(rowStart + 1, rowStart + 1 + stride);
		const prevRow = y > 0 ? rawBuf.subarray((y - 1) * (stride + 1) + 1, (y - 1) * (stride + 1) + 1 + stride) : null;
		const recon = new Uint8Array(stride);

		for (let x = 0; x < stride; x++) {
			const raw = row[x] ?? 0;
			const a = x >= channels ? recon[x - channels] ?? 0 : 0;
			const b = prevRow ? prevRow[x] ?? 0 : 0;
			const c = (x >= channels && prevRow) ? prevRow[x - channels] ?? 0 : 0;
			switch (filterType) {
				case 0: recon[x] = raw; break;
				case 1: recon[x] = (raw + a) & 0xff; break;
				case 2: recon[x] = (raw + b) & 0xff; break;
				case 3: recon[x] = (raw + Math.floor((a + b) / 2)) & 0xff; break;
				case 4: recon[x] = (raw + paeth(a, b, c)) & 0xff; break;
				default: recon[x] = raw; break;
			}
		}

		for (let x = 0; x < width; x++) {
			const di = (y * width + x) * 4;
			const si = x * channels;
			rawData[di] = recon[si] ?? 0;
			rawData[di + 1] = recon[si + 1] ?? 0;
			rawData[di + 2] = recon[si + 2] ?? 0;
			rawData[di + 3] = channels === 4 ? recon[si + 3] ?? 255 : 255;
		}
	}

	return { data: rawData, width, height };
}

function paeth(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
