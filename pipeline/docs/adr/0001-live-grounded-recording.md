# 0001 — Live-grounded recording: script against a real authenticated catalog

Status: Accepted (2026-06)

## Context

Early Auto Demo runs failed the same way every time: feature clicks missed and
the record phase crashed. Root cause was architectural, not a selector typo.

- Selectors were **guessed from repo source code**. For forkai.in the LLM picked
  `#ft-new` / `#ft-win-btn` / `#ft-undo` — IDs from `ForkTraceGame.tsx`, an
  easter-egg puzzle game — because it reads repo files, not the running app.
- The crawl only enriched from the **logged-out landing page**, so it never saw
  the real, login-gated feature elements.
- Selector strings were raw CSS / `:has-text`, emitted unescaped, and broke when
  passed from crawl to record.

The demo therefore exercised elements that often did not exist on the live,
authenticated app.

## Decision

Recording is **live-grounded**: the script is built from real elements observed
on the running app, not inferred from code.

1. The crawl logs in (see [ADR 0002](./0002-on-camera-login.md)) and extracts a
   **Live Catalog** of the actual interactive elements on each feature's
   authenticated page.
2. Every element is captured as a structured, durable **Target**
   (`testId` / `role`+name / `label` / `placeholder` / `text` → `css` last
   resort), compiled to a Playwright locator only at record time. The same
   browser-side extractor produces the catalog and powers self-heal, so what the
   LLM plans against is exactly what the recorder can resolve.
3. The LLM references catalog entries by `id`; it does not emit free-form
   selectors.
4. **Deterministic post-parse validation**: every scripted step must map to an
   existing catalog entry and be action-compatible (click→clickable,
   fill→input), or it is dropped / converted to narration. Prose constraints in
   the prompt are not trusted.

## Consequences

- Demos exercise elements that actually exist on the live app; recorded event
  counts rose substantially (e.g. forkai.in: 3 → 8 events, 1 → 6 zoom regions).
- The catalog is only as good as where the crawl reaches — auth and navigation
  coverage now directly bound demo quality.
- A new shared vocabulary (`Target`, `CatalogEntry`) couples the crawl, script
  generator, and recorder. Changing the locator model touches all three.
- Hard to reverse: removing the catalog would mean returning to code-guessed
  selectors and the original failure mode.
