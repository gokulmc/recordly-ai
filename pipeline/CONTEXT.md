# Auto Demo — Context Glossary

The shared language of the Auto Demo pipeline: the engine that turns a repo URL
+ production URL (+ optional credentials) into a finished `.recordly` demo
project. This file is a glossary only — definitions of terms, not implementation
detail. Architectural decisions live in [docs/adr/](./docs/adr/).

---

## Pipeline & phases

**Pipeline** — the staged process that produces a demo: ingest → understand →
crawl → generate-script → record → render. Runs as a forked child process
(`pipeline/cli.ts`) using Electron's bundled Node, driven by the desktop app.

**Phase** — a coarse, independently-invokable segment of the pipeline. The three
the UI drives directly are **generate-script**, **record**, and **render**. The
active phase is selected by the `PIPELINE_PHASE` environment variable.

**Stage** — a fine-grained unit of work within a phase that emits progress
(`StageEvent`) to the UI flow view (e.g. `ingest`, `crawl`, `derive`, `build`).
A **Feature** (below) may have its own per-feature steps in the flow.

## Understanding the app

**Feature Map** (`AppFeatureMap`) — the structured understanding of the target
app: its features, primary flows, whether auth is needed, and the captured login
flow. Produced by LLM repo analysis, then **enriched** by the crawl.

**Feature** (`AppFeature`) — one capability of the app (name, emoji, description,
entry path, importance, suggested flow). Carries a **Live Catalog** once crawled.

**Primary Flow** — an ordered list of feature names describing a high-level
journey through the app that the demo should follow.

## Locating elements

**Target** — a durable, structured descriptor of a UI element, independent of
Playwright. One of: `testId`, `role`+`name`, `label`, `placeholder`, `text`, or
`css` (last resort). The single currency shared by the catalog, the script, and
the recorder. Replaces fragile raw-CSS / `:has-text` strings. See
[ADR 0001](./docs/adr/0001-live-grounded-recording.md).

**Live Catalog** / **Catalog Entry** — the set of *real* interactive elements
found on a feature's page during an **authenticated** crawl, each captured as a
`CatalogEntry` (stable `id`, `Target`, visible text, role, tag, enabled, bbox).
The LLM scripts against catalog `id`s; the recorder compiles their `Target`s.
This is what makes recording **live-grounded** rather than guessed-from-code.

**Compile** — resolving a `Target` to a concrete Playwright `Locator` at record
time (`compileTarget`).

## Authentication

**On-camera login** — replaying the captured login flow live during recording so
the viewer *sees* the sign-in, rather than starting pre-authenticated. The demo's
first steps are tagged `phase: "login"`. See
[ADR 0002](./docs/adr/0002-on-camera-login.md).

**Login Flow** (`LoginSelectors`) — the exact, verified sign-in interaction
captured by the crawl: optional `trigger` (opens a modal form), `email` target,
how it `advance`s (press **Enter** vs. click a **Next** control), and `password`
target. Replayed verbatim instead of guessed.

**Storage State** / **auth carry** — a Playwright `storageState` file written by
the crawl after a verified login (`authStatePath`). Carried into the record phase
as a *safety net* so the demo is authenticated even if the on-camera replay is
imperfect.

**Auth verification** — confirming login actually succeeded (URL change / modal
gone / an auth-only element appeared), not merely that fields were filled. Only a
verified login yields a `LoginSelectors` + storage state.

## Recording

**Recorder** — replays the demo script against the live app, capturing a video
plus an **Interaction Trace**.

**Fail-soft recording** — every step is wrapped so one failure degrades
gracefully instead of aborting; the recorder always finalizes and returns
whatever trace exists ("never exits early").

**Self-heal** — when a step's `Target` no longer resolves, a *bounded,
high-confidence* re-resolution against the current live DOM: accepted only when
action-compatible, role matches, accessible name is exact/near-exact, and the
element is visible+enabled. Never guesses on weak signals.

**Requested vs. resolved selector** — the trace records both what a step asked
for and what actually matched, so self-heals are auditable.

**Native dual-track capture** — high-fidelity recording via macOS
ScreenCaptureKit (60fps, window-by-title), with **fiducial** markers used to
solve the affine transform mapping browser coordinates to recorded frames.
Falls back to the lower-fidelity **Playwright** webm backend, re-running the
whole script, if native capture fails. See
[ADR 0003](./docs/adr/0003-native-dual-track-capture.md).

**Interaction Trace** — the timed record of what happened during recording
(events, coordinates, selectors). Drives zoom + cursor derivation.

## Rendering

**Zoom derivation** — turning the trace into zoom regions. Only emphasized
actions (click/dblclick/rightclick by default) create regions; nearby events
merge within `mergeGapMs`.

**Zoom aggressiveness** — a 1–5 knob (set in the video-review window) controlling
how *many* zooms appear: higher tightens the merge gap and widens which actions
are emphasized, producing more, tighter zooms.

**Saliency** — LLM-derived hints about what matters on screen, layered over the
deterministic zoom/cursor derivation to refine emphasis and cursor styling.

**Project** (`.recordly`) — the final editable demo artifact assembled from the
video, zoom regions, and cursor telemetry, openable in the Recordly editor.

## Secure credentials

**Secure store** — demo passwords are kept in the OS keychain via Electron
`safeStorage`, never written into `.recordly` projects or logs. Credentials pass
through the pipeline run in memory only.
