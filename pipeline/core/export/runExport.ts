/**
 * Pipeline-side export request contract.
 *
 * The pipeline child (Node.js) does not create BrowserWindows — it sends an
 * ExportRequest to the Electron main process over IPC and waits for the result.
 * The main process calls createSmokeExportWindow() and resolves/rejects when
 * the hidden renderer window finishes exporting.
 *
 * Usage from the orchestrator:
 *
 *   import { requestExport } from "./runExport.js";
 *
 *   const result = await requestExport(req, {
 *     send: (msg) => process.send!(msg),
 *     waitForResult: () => new Promise(resolve => {
 *       process.once("message", (m) => resolve(m as ExportResult));
 *     }),
 *   });
 */

export interface ExportRequest {
	projectPath: string;
	videoPath: string;
	outputPath: string;
	backendPreference?: "breeze" | "webcodecs" | "auto";
	quality?: "medium" | "good" | "high" | "source";
	fps?: number;
}

export interface ExportResult {
	success: boolean;
	outputPath?: string;
	error?: string;
	elapsedMs?: number;
}

export interface ExportIpcMessage {
	type: "auto-demo:export";
	request: ExportRequest;
}

export interface ExportResultMessage {
	type: "auto-demo:export-result";
	result: ExportResult;
}

export interface ExportTransport {
	send(msg: ExportIpcMessage): void;
	waitForResult(): Promise<ExportResult>;
}

export async function requestExport(
	req: ExportRequest,
	transport: ExportTransport,
): Promise<ExportResult> {
	transport.send({ type: "auto-demo:export", request: req });
	return transport.waitForResult();
}

/**
 * Simple in-process transport for use when the pipeline runs inside the
 * Electron main process (e.g. during M2 probe, before the full IPC bridge).
 *
 * Pass the createSmokeExportWindow handler directly:
 *
 *   const transport = makeInProcessTransport(
 *     (req) => createSmokeExportWindow({ ...req }).done
 *   );
 *   const result = await requestExport(req, transport);
 */
export function makeInProcessTransport(
	handler: (req: ExportRequest) => Promise<string>,
): ExportTransport {
	let _resolve: ((result: ExportResult) => void) | null = null;
	let _reject: ((err: unknown) => void) | null = null;

	return {
		send(msg: ExportIpcMessage) {
			handler(msg.request)
				.then((outputPath) => _resolve?.({ success: true, outputPath }))
				.catch((err: unknown) =>
					_resolve?.({
						success: false,
						error: err instanceof Error ? err.message : String(err),
					}),
				);
		},
		waitForResult() {
			return new Promise<ExportResult>((resolve, reject) => {
				_resolve = resolve;
				_reject = reject;
			});
		},
	};
}
