/**
 * Electron main-process IPC bridge for the auto-demo pipeline.
 *
 * Responsibilities:
 *   1. On `auto-demo:start`: fork the pipeline child, relay its StageEvents to
 *      the Auto-demo window via `webContents.send('auto-demo:progress', evt)`.
 *   2. Bridge the dual-track native capture:
 *      - Listen for `native-capture:start` messages from the child
 *      - Find the browser window source by its unique title
 *      - Start native recording in "no-cursor-telemetry" mode
 *      - Send back `native-capture:started` (or `native-capture:error`)
 *      - On `native-capture:stop`: stop recording and send `native-capture:finished`
 *   3. On `auto-demo:cancel`: kill the child process.
 *
 * Message protocol (pipeline child → Electron main):
 *   { type: "native-capture:start",  windowTitle, outputPath, noCursorTelemetry }
 *   { type: "native-capture:stop" }
 *
 * Message protocol (Electron main → pipeline child):
 *   { type: "native-capture:started", outputPath, sourceWidth, sourceHeight }
 *   { type: "native-capture:finished", videoPath }
 *   { type: "native-capture:error", message }
 *
 * Stage event protocol (pipeline child → Electron main → renderer):
 *   StageEvent objects are forwarded verbatim via IPC to the Auto-demo window.
 *
 * Implementation note: the actual native recording start/stop calls the
 * `start-native-screen-recording` / `stop-native-screen-recording` IPC handler
 * logic. Rather than duplicating it, in M6 we will refactor recording.ts to
 * export `invokeStartNativeRecording(source, options)` and call it here.
 * For M3 the pipeline-child-side protocol (nativeRecordly.ts) is complete;
 * the Electron-main side will be wired in M6 when the Auto-demo window and
 * the `auto-demo:start` fork path are implemented.
 */

import { fork } from "node:child_process";
import path from "node:path";
import { desktopCapturer, ipcMain, type WebContents } from "electron";
import {
	nativeScreenRecordingActive,
	setNoCursorTelemetryMode,
} from "../state";
import type { SelectedSource } from "../types";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AutoDemoStartOpts {
	/** GitHub repo URL or local filesystem path. */
	repoUrl: string;
	/** Production URL of the running app. */
	productionUrl: string;
	/** Demo account email (optional). */
	authEmail?: string;
	/** Demo account password (optional). */
	authPassword?: string;
}

interface NativeCaptureStartMsg {
	type: "native-capture:start";
	windowTitle: string;
	outputPath: string;
	noCursorTelemetry: true;
}


// ── Source discovery ──────────────────────────────────────────────────────────

/**
 * Find a desktop capture source whose window title matches `title`.
 * Returns null if no source is found within the timeout.
 */
async function findSourceByWindowTitle(
	title: string,
	timeoutMs = 8000,
): Promise<SelectedSource | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const sources = await desktopCapturer.getSources({
			types: ["window"],
			thumbnailSize: { width: 1, height: 1 },
			fetchWindowIcons: false,
		});
		type Src = { name: string; id: string; appName: string; windowTitle?: string };
		const match = (sources as unknown as Src[]).find(
			(s) => s.name === title || s.windowTitle === title,
		);
		if (match) {
			return {
				id: match.id,
				name: match.name,
				sourceType: "window",
				appName: match.appName,
				windowTitle: title,
			};
		}
		await new Promise((r) => setTimeout(r, 300));
	}
	return null;
}

// ── Native-capture bridge ─────────────────────────────────────────────────────

/**
 * Handle a `native-capture:start` message from the pipeline child.
 *
 * Finds the browser window by its unique title, starts native recording in
 * no-cursor-telemetry mode, and replies with `native-capture:started` (on
 * success) or `native-capture:error`.
 *
 * NOTE (M6 TODO): This currently stubs the actual native-recording start.
 * In M6, extract `invokeStartNativeRecording(source)` from recording.ts and
 * call it here. The IPC handler in recording.ts cannot be invoked from main;
 * it must be refactored to expose the underlying function.
 */
async function handleNativeCaptureStart(
	msg: NativeCaptureStartMsg,
	send: (resp: unknown) => void,
): Promise<void> {
	if (nativeScreenRecordingActive) {
		send({
			type: "native-capture:error",
			message: "A native recording is already active",
		});
		return;
	}

	const source = await findSourceByWindowTitle(msg.windowTitle);
	if (!source) {
		send({
			type: "native-capture:error",
			message: `No desktop source found with window title "${msg.windowTitle}"`,
		});
		return;
	}

	// Set no-cursor-telemetry mode BEFORE starting native capture so that
	// set-recording-state(true) skips cursor sampling entirely.
	setNoCursorTelemetryMode(true);

	// M6 TODO: call invokeStartNativeRecording(source, { noCursorTelemetry: true })
	// For now, emit the "started" acknowledgement so the pipeline can proceed.
	// The actual recording start will be wired in M6.
	send({
		type: "native-capture:started",
		outputPath: msg.outputPath,
		// Placeholder dimensions — real values come from the capture helper after M6
		sourceWidth: 0,
		sourceHeight: 0,
	});
}

// ── Child-process lifecycle ───────────────────────────────────────────────────

interface ActivePipeline {
	/** The forked child process. */
	child: ReturnType<typeof fork>;
	/** The renderer window to relay progress events to. */
	rendererContents: WebContents;
}

let activePipeline: ActivePipeline | null = null;

/**
 * Fork the pipeline child and wire up the IPC bridge.
 *
 * The child process path is `<repo>/pipeline/dist/cli.js` (the compiled output
 * of `pipeline/cli.ts`). The child receives its configuration via environment
 * variables and communicates via `process.send()` / `process.on('message')`.
 */
export function forkPipelineChild(
	opts: AutoDemoStartOpts,
	rendererContents: WebContents,
): { cancel(): void } {
	if (activePipeline) {
		activePipeline.child.kill();
		activePipeline = null;
	}

	const pipelineCliPath = path.resolve(__dirname, "../../../pipeline/dist/cli.js");

	const child = fork(pipelineCliPath, [], {
		env: {
			...process.env,
			PIPELINE_REPO_URL: opts.repoUrl,
			PIPELINE_PRODUCTION_URL: opts.productionUrl,
			PIPELINE_AUTH_EMAIL: opts.authEmail ?? "",
			PIPELINE_AUTH_PASSWORD: opts.authPassword ?? "",
		},
		silent: false,
	});

	activePipeline = { child, rendererContents };

	child.on("message", (msg: unknown) => {
		if (!msg || typeof msg !== "object") return;
		const m = msg as Record<string, unknown>;

		switch (m["type"]) {
			case "native-capture:start":
				void handleNativeCaptureStart(m as unknown as NativeCaptureStartMsg, (resp) => {
					child.send(resp as Parameters<typeof child.send>[0]);
				});
				break;

			case "native-capture:stop":
				// M6 TODO: call invokeStopNativeRecording(), then send finished.
				// For now, acknowledge immediately (Playwright-video path needs no native stop).
				child.send({ type: "native-capture:finished", videoPath: "" });
				break;

			default:
				// Stage events from the orchestrator → relay to the renderer window
				if (!rendererContents.isDestroyed()) {
					rendererContents.send("auto-demo:progress", msg);
				}
				break;
		}
	});

	child.once("exit", () => {
		if (activePipeline?.child === child) {
			activePipeline = null;
		}
	});

	return {
		cancel() {
			if (activePipeline?.child === child) {
				child.kill();
				activePipeline = null;
			}
		},
	};
}

// ── IPC registration ──────────────────────────────────────────────────────────

/**
 * Register all auto-demo IPC handlers.
 * Call this from `electron/main.ts` alongside other `registerXxxHandlers()` calls.
 */
export function registerAutoDemoHandlers(): void {
	ipcMain.handle(
		"auto-demo:start",
		// event.sender is WebContents — the renderer that called invoke()
		(event: { sender: WebContents }, opts: AutoDemoStartOpts) => {
			forkPipelineChild(opts, event.sender);
			return { success: true };
		},
	);

	ipcMain.handle("auto-demo:cancel", () => {
		if (activePipeline) {
			activePipeline.child.kill();
			activePipeline = null;
		}
		return { success: true };
	});
}
