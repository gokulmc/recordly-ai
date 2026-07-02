# 0002 — Login on camera, with storage state as a safety net

Status: Accepted (2026-06)

## Context

The demo needs to be authenticated to show real features, and the crawl needs to
be authenticated to catalog them ([ADR 0001](./0001-live-grounded-recording.md)).
Two questions arose:

1. *How* does login work on the target app? The original code navigated to a
   login **URL** and advanced email→password by clicking a **Next** button.
   forkai.in's real flow, verified live, is a **2-step modal**: click "Login" →
   fill email → press **Enter** → fill password → press **Enter**. The guessed
   flow never completed, so no login selectors were ever captured.

2. Should the *recording* start pre-authenticated (load a saved session) or
   replay the sign-in **on camera**? Pre-authenticating is more reliable, but a
   product demo that skips the login screen is a worse demo — and if steps tagged
   as login run against an already-authenticated app, the Login button is gone
   and those steps fail.

## Decision

- The crawl **captures the real login flow** as structured Targets
  (`LoginSelectors`: optional `trigger`, `email`, `advance` = press-Enter vs.
  click-Next, optional `next`, `password`) and **verifies success** (URL change
  / modal gone / auth-only element) before trusting it.
- The demo **replays login on camera** — the captured flow becomes the first
  steps, tagged `phase: "login"`, so the viewer sees the sign-in.
- A Playwright **storage state** (`authStatePath`) is saved after the verified
  crawl login and carried into the record phase as a **safety net**, so the demo
  ends up authenticated even if the on-camera replay is imperfect.

## Consequences

- Demos open with a genuine sign-in, which is what users expect to see.
- The crawl must model app-specific login mechanics (modal trigger, Enter-to-
  advance) rather than assuming a login URL; new apps may need new advance modes.
- Login captured for the camera and storage state for reliability are kept as
  two complementary mechanisms — neither alone is sufficient.
- Credentials never touch disk in the project; see the secure-store note in
  [CONTEXT.md](../../CONTEXT.md). Passwords are redacted in the trace.
- Rejected alternative: preload storage state only (no on-camera login). It made
  the login steps no-ops and produced a demo that skipped sign-in entirely.
