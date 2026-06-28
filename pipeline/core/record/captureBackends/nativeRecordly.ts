/**
 * Native recordly capture backend.
 *
 * This backend is used for the dual-track production path where:
 *   - recordly native capture (ScreenCaptureKit / WGC) provides 60fps pixels
 *   - Playwright drives the browser + captures the interaction trace + fiducials
 *   - An affine M (from fiducial detection) maps viewport px → source frame
 *
 * The pipeline child process cannot call Electron IPC directly.  Instead it
 * sends messages over its IPC channel to the Electron main process, which
 * dispatches them to the recordly native capture layer.
 *
 * Message protocol (pipeline child → Electron main via IPC):
 *
 *   { type: "native-capture:start",
 *     windowTitle: string,           // unique browser window title for source selection
 *     outputPath: string,            // where to write the mp4
 *     noCursorTelemetry: true }      // always true — pipeline owns the sidecar
 *
 *   { type: "native-capture:stop" }  // stop and finalize
 *
 * The Electron main side (`electron/ipc/register/autoDemo.ts`) listens for
 * these messages and calls the native capture IPC handlers on behalf of the child.
 *
 * The backend returns once `native-capture:started` is confirmed, and the
 * finalize() call blocks until the video file is ready.
 */

export interface NativeRecordlyBackend {
	/** Tells the Electron main process to start native capture. */
	start(): Promise<void>;
	/**
	 * Stop capture and return the path to the recorded video file.
	 * Blocks until the native backend confirms finalization.
	 */
	finalize(): Promise<string>;
}

export interface NativeRecordlyOpts {
	/**
	 * A unique window title that identifies the Playwright browser window.
	 * The Electron main process will look for a matching `SelectedSource` by
	 * window title and select it for capture.
	 */
	windowTitle: string;
	/** Absolute path for the output video file (mp4). */
	outputPath: string;
	/**
	 * Send a structured message to the Electron main process.
	 * In the forked-child scenario this is `process.send()`.
	 * In tests this can be a mock.
	 */
	send: (msg: NativeCaptureMessage) => void;
	/**
	 * Register a listener for messages from Electron main.
	 * Returns an unsubscribe function.
	 */
	onMessage: (handler: (msg: NativeCaptureResponse) => void) => () => void;
}

// ── Message types (pipeline child ↔ Electron main) ────────────────────────────

export interface NativeCaptureStartMsg {
	type: "native-capture:start";
	windowTitle: string;
	outputPath: string;
	noCursorTelemetry: true;
}

export interface NativeCaptureStopMsg {
	type: "native-capture:stop";
}

export type NativeCaptureMessage = NativeCaptureStartMsg | NativeCaptureStopMsg;

export interface NativeCaptureStartedResponse {
	type: "native-capture:started";
	/** Actual output path that native capture will write to. */
	outputPath: string;
	/** Pixel dimensions of the captured source (before any crop). */
	sourceWidth: number;
	sourceHeight: number;
}

export interface NativeCaptureFinishedResponse {
	type: "native-capture:finished";
	videoPath: string;
}

export interface NativeCaptureErrorResponse {
	type: "native-capture:error";
	message: string;
}

export type NativeCaptureResponse =
	| NativeCaptureStartedResponse
	| NativeCaptureFinishedResponse
	| NativeCaptureErrorResponse;

// ── Factory ────────────────────────────────────────────────────────────────────

/**
 * Create a native recordly capture backend that communicates with the Electron
 * main process over the child-process IPC channel.
 */
export function createNativeRecordlyBackend(opts: NativeRecordlyOpts): NativeRecordlyBackend {
	const { windowTitle, outputPath, send, onMessage } = opts;

	return {
		async start(): Promise<void> {
			return new Promise((resolve, reject) => {
				const unsubscribe = onMessage((msg) => {
					if (msg.type === "native-capture:started") {
						unsubscribe();
						resolve();
					} else if (msg.type === "native-capture:error") {
						unsubscribe();
						reject(new Error(`native-capture start failed: ${msg.message}`));
					}
				});

				send({
					type: "native-capture:start",
					windowTitle,
					outputPath,
					noCursorTelemetry: true,
				});

				// Timeout guard: Electron main must respond within 10s
				const t = setTimeout(() => {
					unsubscribe();
					reject(new Error("native-capture:start timed out after 10s"));
				}, 10_000);
				void t;
			});
		},

		async finalize(): Promise<string> {
			return new Promise((resolve, reject) => {
				const unsubscribe = onMessage((msg) => {
					if (msg.type === "native-capture:finished") {
						unsubscribe();
						resolve(msg.videoPath);
					} else if (msg.type === "native-capture:error") {
						unsubscribe();
						reject(new Error(`native-capture stop failed: ${msg.message}`));
					}
				});

				send({ type: "native-capture:stop" });

				const t = setTimeout(() => {
					unsubscribe();
					reject(new Error("native-capture:stop timed out after 60s"));
				}, 60_000);
				void t;
			});
		},
	};
}

/**
 * Build an IPC transport pair from Node.js child_process IPC.
 * Use this when the pipeline runs as a forked child (`fork()`).
 */
export function makeProcessIpcTransport(): Pick<NativeRecordlyOpts, "send" | "onMessage"> {
	return {
		send(msg: NativeCaptureMessage) {
			if (process.send) {
				process.send(msg);
			} else {
				throw new Error("makeProcessIpcTransport: process.send is not available (not a forked child)");
			}
		},
		onMessage(handler: (msg: NativeCaptureResponse) => void) {
			const listener = (msg: unknown) => {
				handler(msg as NativeCaptureResponse);
			};
			process.on("message", listener);
			return () => process.off("message", listener);
		},
	};
}
