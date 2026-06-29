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

import { fork, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { desktopCapturer, ipcMain, type WebContents } from "electron";
import { openVideoReviewWindow, closeVideoReviewWindow, getHudOverlayWindow, getAutoDemoWindow, createAutoDemoWindow } from "../../windows";
import { rememberApprovedLocalReadPath } from "../project/manager";
import { ensureNativeCaptureHelperBinary } from "../paths/binaries";
import { getFfmpegBinaryPath } from "../ffmpeg/binary";
import { parseWindowId } from "../utils";
import {
	nativeScreenRecordingActive,
	setNativeScreenRecordingActive,
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
		// Chromium window names may be the bare document.title or include a suffix
		// (" - Chromium"), so match by substring as well as exact.
		const match = (sources as unknown as Src[]).find(
			(s) =>
				s.name === title ||
				s.windowTitle === title ||
				s.name?.includes(title) ||
				s.windowTitle?.includes(title),
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
/** The ScreenCaptureKit helper process backing the active auto-demo capture. */
let activeNativeCapture: { proc: ChildProcessWithoutNullStreams; outputPath: string; stdout: string } | null = null;

async function handleNativeCaptureStart(
	msg: NativeCaptureStartMsg,
	send: (resp: unknown) => void,
): Promise<void> {
	if (nativeScreenRecordingActive || activeNativeCapture) {
		send({ type: "native-capture:error", message: "A native recording is already active" });
		return;
	}
	if (process.platform !== "darwin") {
		send({ type: "native-capture:error", message: "Native capture is only supported on macOS" });
		return;
	}

	const source = await findSourceByWindowTitle(msg.windowTitle);
	if (!source) {
		send({ type: "native-capture:error", message: `No desktop source found with window title "${msg.windowTitle}"` });
		return;
	}

	const windowId = parseWindowId(source.id);
	if (!Number.isFinite(windowId) || !windowId) {
		send({ type: "native-capture:error", message: `Could not resolve a window id for "${msg.windowTitle}"` });
		return;
	}

	// No-cursor-telemetry: the pipeline owns the cursor sidecar, so the native
	// helper must not draw/sample the system cursor.
	setNoCursorTelemetryMode(true);

	try {
		const helperPath = await ensureNativeCaptureHelperBinary();
		const config = {
			fps: 60,
			outputPath: msg.outputPath,
			windowId,
			capturesSystemAudio: false,
			capturesMicrophone: false,
		};
		const proc = spawn(helperPath, [JSON.stringify(config)], { stdio: ["pipe", "pipe", "pipe"] });
		const capture = { proc, outputPath: msg.outputPath, stdout: "" };
		activeNativeCapture = capture;
		setNativeScreenRecordingActive(true);

		const onData = (chunk: Buffer) => { capture.stdout += chunk.toString(); };
		proc.stdout.on("data", onData);
		proc.stderr.on("data", onData);

		// Resolve once the helper confirms it is recording.
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("ScreenCaptureKit helper did not start within 12s")), 12_000);
			const check = () => {
				if (capture.stdout.includes("Recording started")) { cleanup(); resolve(); }
			};
			const interval = setInterval(check, 100);
			const onExit = (code: number | null) => { cleanup(); reject(new Error(`helper exited (code ${code}) before starting: ${capture.stdout.slice(-300)}`)); };
			proc.once("exit", onExit);
			function cleanup() { clearTimeout(timer); clearInterval(interval); proc.off("exit", onExit); }
		});

		send({ type: "native-capture:started", outputPath: msg.outputPath, sourceWidth: 0, sourceHeight: 0 });
	} catch (err) {
		setNativeScreenRecordingActive(false);
		setNoCursorTelemetryMode(false);
		if (activeNativeCapture) { try { activeNativeCapture.proc.kill(); } catch { /* ignore */ } activeNativeCapture = null; }
		send({ type: "native-capture:error", message: `Failed to start native capture: ${String(err)}` });
	}
}

async function handleNativeCaptureStop(send: (resp: unknown) => void): Promise<void> {
	const capture = activeNativeCapture;
	if (!capture) {
		send({ type: "native-capture:error", message: "No active native capture to stop" });
		return;
	}
	try {
		const videoPath = await new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("ScreenCaptureKit helper did not stop within 60s")), 60_000);
			capture.proc.once("exit", (code) => {
				clearTimeout(timer);
				const match = capture.stdout.match(/Recording stopped\. Output path: (.+)/);
				if (match?.[1]) return resolve(match[1].trim());
				if (code === 0) return resolve(capture.outputPath);
				reject(new Error(`helper exited with code ${code}: ${capture.stdout.slice(-300)}`));
			});
			// Ask the helper to finalize.
			try { capture.proc.stdin.write("stop\n"); } catch { /* helper may already be closing */ }
		});
		send({ type: "native-capture:finished", videoPath });
	} catch (err) {
		send({ type: "native-capture:error", message: `Failed to stop native capture: ${String(err)}` });
	} finally {
		setNativeScreenRecordingActive(false);
		setNoCursorTelemetryMode(false);
		activeNativeCapture = null;
	}
}

// ── Child-process lifecycle ───────────────────────────────────────────────────

interface ActivePipeline {
	/** The forked child process. */
	child: ReturnType<typeof fork>;
	/** The renderer window to relay progress events to. */
	rendererContents: WebContents;
}

let activePipeline: ActivePipeline | null = null;

// ── Pipeline CLI resolution (dev vs prod) ─────────────────────────────────────

/**
 * Repo/app root. main.ts sets process.env.APP_ROOT = dirname(main) + "..".
 * The main process is bundled to dist-electron/main.cjs, so __dirname at
 * runtime is dist-electron — NOT this source file's directory. Anchor on
 * APP_ROOT instead so the pipeline path is correct in dev and packaged builds.
 */
function getPipelineRoot(): string {
	const appRoot = process.env.APP_ROOT ?? path.resolve(__dirname, "..");
	return path.join(appRoot, "pipeline");
}

interface PipelineForkTarget {
	modulePath: string;
	/** Node-compatible executable to run the child with. */
	execPath: string;
	/** Extra Node flags (e.g. the tsx ESM loader for running .ts directly). */
	execArgv: string[];
	/** Env additions required by the chosen executable. */
	extraEnv: Record<string, string>;
}

/**
 * Resolve how to fork the pipeline child.
 *
 * Always runs through Electron's OWN bundled Node (`process.execPath` +
 * `ELECTRON_RUN_AS_NODE`). This avoids any dependency on a system `node` being
 * present on `PATH` — which it usually is NOT when the app is launched from the
 * GUI/IDE. (tsx's `#!/usr/bin/env node` shebang fails with exit 127 in that
 * case, killing the child before it can emit a single event.)
 *
 *   - Prod: run the precompiled `pipeline/dist/cli.js` directly.
 *   - Dev:  run `pipeline/cli.ts` with the tsx ESM loader via `--import`.
 */
function resolvePipelineForkTarget(): PipelineForkTarget {
	const pipelineRoot = getPipelineRoot();
	const baseEnv = { ELECTRON_RUN_AS_NODE: "1" };

	const compiledCli = path.join(pipelineRoot, "dist/cli.js");
	if (fs.existsSync(compiledCli)) {
		return {
			modulePath: compiledCli,
			execPath: process.execPath,
			execArgv: [],
			extraEnv: baseEnv,
		};
	}

	// Dev: run the TypeScript source directly via the tsx loader.
	const tsxLoader = path.join(pipelineRoot, "node_modules/tsx/dist/loader.mjs");
	const execArgv = fs.existsSync(tsxLoader)
		? ["--import", pathToFileURL(tsxLoader).href]
		: [];
	return {
		modulePath: path.join(pipelineRoot, "cli.ts"),
		execPath: process.execPath,
		execArgv,
		extraEnv: baseEnv,
	};
}

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

	const { modulePath: pipelineCliPath, execPath, execArgv, extraEnv } = resolvePipelineForkTarget();
	const pipelineRoot = getPipelineRoot();

	const child = fork(pipelineCliPath, [], {
		cwd: pipelineRoot,
		env: {
			...process.env,
			...extraEnv,
			PIPELINE_REPO_URL: opts.repoUrl,
			PIPELINE_PRODUCTION_URL: opts.productionUrl,
			PIPELINE_AUTH_EMAIL: opts.authEmail ?? "",
			PIPELINE_AUTH_PASSWORD: opts.authPassword ?? "",
		},
		execPath,
		execArgv,
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

// ── Granular phase IPC handlers ───────────────────────────────────────────────

function forkPhasedChild(
	phase: string,
	env: Record<string, string>,
	rendererContents: WebContents,
): void {
	if (activePipeline) {
		activePipeline.child.kill();
		activePipeline = null;
	}

	const { modulePath: pipelineCliPath, execPath, execArgv, extraEnv } = resolvePipelineForkTarget();
	const pipelineRoot = getPipelineRoot();

	const relay = (msg: unknown) => {
		if (!rendererContents.isDestroyed()) {
			rendererContents.send("auto-demo:progress", msg);
		}
	};

	// Surface the first heartbeat immediately so the UI leaves "Initialising…".
	// Use the first real stage of the phase so the right stage row lights up.
	const HEARTBEAT_STAGE: Record<string, string> = {
		"generate-script": "ingest",
		record: "record",
		render: "derive",
	};
	const heartbeatStage = HEARTBEAT_STAGE[phase] ?? "ingest";
	relay({ type: "stage", stageId: heartbeatStage, status: "running", message: "Starting pipeline …" });

	let child: ReturnType<typeof fork>;
	try {
		child = fork(pipelineCliPath, [], {
			cwd: pipelineRoot,
			env: { ...process.env, ...extraEnv, PIPELINE_PHASE: phase, ...env },
			execPath,
			execArgv,
			// Capture stderr so we can report crashes; keep an IPC channel.
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
	} catch (err) {
		relay({ type: "stage", stageId: "error", status: "error", message: `Failed to start pipeline: ${String(err)}`, payload: { kind: "error", error: String(err) } });
		return;
	}

	activePipeline = { child, rendererContents };

	let sawPhaseResult = false;
	let stderrTail = "";

	child.stdout?.on("data", (buf: Buffer) => {
		// Plain progress logs from the pipeline ([ingest] …); useful for the log box.
		const text = buf.toString();
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (trimmed) relay({ type: "stage", stageId: phase, status: "running", message: trimmed });
		}
	});

	child.stderr?.on("data", (buf: Buffer) => {
		const text = buf.toString();
		stderrTail = (stderrTail + text).slice(-4000);
		console.error("[auto-demo pipeline]", text);
	});

	child.on("error", (err) => {
		relay({ type: "stage", stageId: "error", status: "error", message: `Pipeline process error: ${err.message}`, payload: { kind: "error", error: err.message } });
	});

	child.on("message", (msg: unknown) => {
		if (!msg || typeof msg !== "object") return;
		const m = msg as Record<string, unknown>;

		if (m["type"] === "phase-result") {
			sawPhaseResult = true;
			if (!rendererContents.isDestroyed()) {
				rendererContents.send("auto-demo:phase-result", m["result"]);
			}
			return;
		}

		// Native-capture bridge: the pipeline child asks Electron to drive the
		// ScreenCaptureKit helper (it cannot call Electron APIs directly).
		if (m["type"] === "native-capture:start") {
			void handleNativeCaptureStart(m as unknown as NativeCaptureStartMsg, (resp) => {
				child.send(resp as Parameters<typeof child.send>[0]);
			});
			return;
		}
		if (m["type"] === "native-capture:stop") {
			void handleNativeCaptureStop((resp) => {
				child.send(resp as Parameters<typeof child.send>[0]);
			});
			return;
		}

		relay(msg);
	});

	child.once("exit", (code) => {
		if (activePipeline?.child === child) {
			activePipeline = null;
		}
		// If the record child died mid-capture, tear down the helper so it doesn't leak.
		if (activeNativeCapture) {
			try { activeNativeCapture.proc.kill(); } catch { /* ignore */ }
			activeNativeCapture = null;
			setNativeScreenRecordingActive(false);
			setNoCursorTelemetryMode(false);
		}
		// If the child died without delivering a result, surface why.
		if (!sawPhaseResult && code !== 0) {
			const detail = stderrTail.trim().split("\n").slice(-6).join("\n") || `exit code ${code}`;
			relay({ type: "stage", stageId: "error", status: "error", message: `Pipeline exited early:\n${detail}`, payload: { kind: "error", error: detail } });
		}
	});
}

/**
 * Register all auto-demo IPC handlers.
 * Call this from `electron/main.ts` alongside other `registerXxxHandlers()` calls.
 */
export function registerAutoDemoHandlers(): void {
	ipcMain.handle("auto-demo:open-window", () => {
		createAutoDemoWindow();
		return { success: true };
	});

	ipcMain.handle(
		"auto-demo:start",
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

	// Check repo accessibility
	ipcMain.handle("auto-demo:check-repo", (_event, url: string) => {
		if (!url || url.startsWith("/") || url.startsWith("~")) {
			return { accessible: true, needsPat: false };
		}
		try {
			const { execSync } = require("node:child_process") as typeof import("node:child_process");
			execSync(`git ls-remote --exit-code "${url}"`, { timeout: 8000, stdio: "pipe" });
			return { accessible: true, needsPat: false };
		} catch {
			return { accessible: false, needsPat: true };
		}
	});

	// Generate script phase
	ipcMain.handle(
		"auto-demo:generate-script",
		(event: { sender: WebContents }, opts: {
			repoUrl: string;
			productionUrl: string;
			authEmail?: string;
			authPassword?: string;
			githubToken?: string;
			focusArea?: string;
		}) => {
			forkPhasedChild(
				"generate-script",
				{
					PIPELINE_REPO_URL: opts.repoUrl,
					PIPELINE_PRODUCTION_URL: opts.productionUrl,
					...(opts.authEmail ? { PIPELINE_AUTH_EMAIL: opts.authEmail } : {}),
					...(opts.authPassword ? { PIPELINE_AUTH_PASSWORD: opts.authPassword } : {}),
					...(opts.githubToken ? { PIPELINE_GITHUB_TOKEN: opts.githubToken } : {}),
					...(opts.focusArea ? { PIPELINE_FOCUS_AREA: opts.focusArea } : {}),
				},
				event.sender,
			);
			return { success: true };
		},
	);

	// Record phase — use the high-fidelity native ScreenCaptureKit backend on
	// macOS (falls back to Playwright webm elsewhere or if the helper is missing).
	ipcMain.handle(
		"auto-demo:record",
		(event: { sender: WebContents }, opts: { scriptJson: string; outDir?: string }) => {
			const nativeEnv: Record<string, string> = {};
			if (process.platform === "darwin") {
				nativeEnv.PIPELINE_RECORD_BACKEND = "native";
				try {
					nativeEnv.PIPELINE_FFMPEG_PATH = getFfmpegBinaryPath();
				} catch { /* fiducial post-solve falls back to scale-only segments */ }
			}
			forkPhasedChild(
				"record",
				{
					PIPELINE_SCRIPT_JSON: opts.scriptJson,
					...(opts.outDir ? { PIPELINE_OUT_DIR: opts.outDir } : {}),
					...nativeEnv,
				},
				event.sender,
			);
			return { success: true };
		},
	);

	// Render phase
	ipcMain.handle(
		"auto-demo:render",
		(event: { sender: WebContents }, opts: {
			videoPath: string;
			traceJsonPath: string;
			productionUrl?: string;
			outDir?: string;
			zoomAggressiveness?: number;
		}) => {
			forkPhasedChild(
				"render",
				{
					PIPELINE_VIDEO_PATH: opts.videoPath,
					PIPELINE_TRACE_JSON_PATH: opts.traceJsonPath,
					...(opts.productionUrl ? { PIPELINE_PRODUCTION_URL: opts.productionUrl } : {}),
					...(opts.outDir ? { PIPELINE_OUT_DIR: opts.outDir } : {}),
					...(opts.zoomAggressiveness ? { PIPELINE_ZOOM_AGGRESSIVENESS: String(opts.zoomAggressiveness) } : {}),
				},
				event.sender,
			);
			return { success: true };
		},
	);

	// Video review window
	ipcMain.handle("video-review:open", async (_event, videoPath: string) => {
		// The auto-demo writes to ~/Desktop/recordly-auto-demo, which is outside
		// the media allowlist. Approve this specific file so the loopback media
		// server (get-local-media-url) will serve it to the review <video>.
		await rememberApprovedLocalReadPath(videoPath);
		openVideoReviewWindow(videoPath);
	});

	ipcMain.handle("video-review:close", () => {
		closeVideoReviewWindow();
	});

	// User decision from the video-review window — relay to the Auto Demo window
	// (which mounts useAutoDemoStore and listens for "video-review:decision").
	ipcMain.on("video-review:user-decision", (_event, decision: "approve" | "modify", zoomAggressiveness?: number) => {
		closeVideoReviewWindow();
		const target = getAutoDemoWindow() ?? getHudOverlayWindow();
		if (target && !target.isDestroyed()) {
			target.webContents.send("video-review:decision", decision, zoomAggressiveness);
		}
	});
}
