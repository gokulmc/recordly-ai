# 0003 — Native ScreenCaptureKit dual-track capture, Playwright as fallback

Status: Accepted (2026-06)

## Context

The record phase originally produced the video from Playwright's built-in webm
recorder. The result was low fidelity (resolution, frame rate, scaling) — unfit
for a polished product demo. macOS ScreenCaptureKit can capture a specific window
at 60fps at native resolution, but it records the *screen*, not the browser's
internal coordinate space, so trace coordinates (clicks, elements) don't line up
with recorded frames out of the box.

## Decision

Use a **native ScreenCaptureKit dual-track** capture as the primary backend, with
the **Playwright** webm recorder as a fallback.

- The Electron main process spawns a `recordly-screencapturekit-helper`,
  targeting the browser window **by title** (the recorder launches and titles the
  window *before* native capture starts, so the helper can find it).
- **Fiducial** markers rendered during recording let the pipeline solve the
  **affine transform** between browser coordinates and recorded frames, so zoom
  and cursor derivation align with what's on screen.
- If native capture fails at any point, the recorder **re-runs the entire script**
  under the Playwright backend and returns *that* run's trace + video.

## Consequences

- Demos are high fidelity (60fps, native resolution) on macOS.
- A native trace and a Playwright video can **never be paired** — their clocks,
  source frames, and affine transforms differ — so a native failure forces a full
  re-run rather than a cheap video swap. Recording cost roughly doubles in the
  fallback path.
- The feature is **macOS-only** for native capture; other platforms get the
  Playwright backend.
- Capture spans process boundaries (pipeline child ↔ Electron main ↔ helper
  binary), with start/finalize ordering and SIGINT/SIGKILL stop escalation that
  must be kept in sync. The helper binary is a separate build artifact.
- Hard to reverse: the affine/fiducial machinery and the cross-process bridge are
  substantial; reverting to Playwright-only would drop fidelity back to the
  original webm quality.
