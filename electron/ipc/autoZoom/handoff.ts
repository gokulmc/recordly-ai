/**
 * Handshake between the native recording pipeline and the Auto Zoom window.
 *
 * When the Auto Zoom window is on Step 1 it "arms" capture: the next recording
 * finalized anywhere (via the normal Recordly HUD record button) is handed off
 * to Auto Zoom instead of opening the editor.
 */

import { getAutoZoomWindow, showAutoZoomWindow } from "../../windows";
import { getTelemetryPathForVideo } from "../utils";

let autoZoomArmed = false;
let onFinalized: ((videoPath: string, cursorPath: string) => void) | null = null;

export function setAutoZoomArmed(v: boolean): void {
  autoZoomArmed = v;
}

export function isAutoZoomArmed(): boolean {
  return autoZoomArmed;
}

/** Registered by the auto-zoom IPC module so it can capture the active paths. */
export function setAutoZoomFinalizedCallback(
  cb: ((videoPath: string, cursorPath: string) => void) | null,
): void {
  onFinalized = cb;
}

/**
 * One-shot: if armed, disarm, notify the Auto Zoom window with the finalized
 * video/cursor paths, and bring it back to the foreground.
 * Returns whether the handoff fired (callers use this to decide whether to
 * skip their own normal post-recording behavior, e.g. opening the editor).
 */
export function notifyAutoZoomRecordingFinalized(videoPath: string): boolean {
  if (!autoZoomArmed) return false;
  autoZoomArmed = false;

  const cursorPath = getTelemetryPathForVideo(videoPath);
  onFinalized?.(videoPath, cursorPath);

  const win = getAutoZoomWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send("auto-zoom:recording-finalized", { videoPath, cursorPath });
  }
  showAutoZoomWindow();

  return true;
}
