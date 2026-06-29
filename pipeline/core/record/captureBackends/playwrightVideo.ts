/**
 * Playwright-video capture backend.
 *
 * Video is recorded by Playwright's built-in chromium video recorder (VP8/webm)
 * at the same resolution as the viewport. The video clock is the same as the
 * Playwright event clock, so M≈identity and residual = 0.
 *
 * The returned `videoPath` is the webm file written by Playwright after the
 * page/context are closed.
 */

import path from "node:path";
import type { BrowserContext, Page } from "playwright";

export interface PlaywrightVideoBackend {
	context: BrowserContext;
	page: Page;
	/**
	 * Close the page + context and wait for the video file to be finalized.
	 * Returns the absolute path to the recorded .webm file.
	 */
	finalize(): Promise<string>;
}

export interface PlaywrightVideoOpts {
	videoDir: string;
	viewportWidth: number;
	viewportHeight: number;
	headless?: boolean;
	/** Playwright storageState file to start the context already authenticated. */
	storageState?: string;
}

/**
 * Launch a Chromium browser context with video recording enabled.
 * Must call `finalize()` to flush and receive the video path.
 */
export async function startPlaywrightVideoRecording(
	opts: PlaywrightVideoOpts,
): Promise<PlaywrightVideoBackend> {
	// Dynamic import so this module doesn't fail when playwright isn't installed
	const { chromium } = await import("playwright");

	const browser = await chromium.launch({ headless: opts.headless ?? true });

	const context = await browser.newContext({
		viewport: { width: opts.viewportWidth, height: opts.viewportHeight },
		recordVideo: {
			dir: opts.videoDir,
			size: { width: opts.viewportWidth, height: opts.viewportHeight },
		},
		deviceScaleFactor: 1,
		...(opts.storageState ? { storageState: opts.storageState } : {}),
	});

	const page = await context.newPage();

	const finalize = async (): Promise<string> => {
		const video = page.video();
		await page.close();
		await context.close();
		await browser.close();

		if (!video) {
			throw new Error("Playwright did not record a video for this page");
		}

		const rawPath = await video.path();
		if (!rawPath) {
			throw new Error("Playwright video path is null after closing the context");
		}

		return path.resolve(rawPath);
	};

	return { context, page, finalize };
}
