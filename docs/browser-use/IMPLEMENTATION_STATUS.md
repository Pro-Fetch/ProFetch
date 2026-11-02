# Implementation status — Browser Intelligence Engine

Living tracker for `docs/browser-use/` work. Statuses: `NOT_STARTED · IN_PROGRESS · IMPLEMENTED ·
TESTED · VERIFIED · BLOCKED`. A task is `TESTED` only when tests exist and pass; `VERIFIED` only when
the evidence is reproducible by someone else. Nothing in this file is rounded up.

## Checkpoint — 2026-11-02, after Phase 5 and most of Phase 4

|                     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phases complete     | 5 of 13; Phase 4 has one host's worth of rows left (touch, mobile-UA emulation, web sockets, persistence) and no other OS                                                                                                                                                                                                                                                                                                                                                  |
| Verified by running | 52 probe steps × 2 browsers (Chrome 156.0.8078.74, Edge 156.0.4314.58) across 25 step kinds: launch, navigate, DOM read, evaluate, geometry, AX, perception, stale detection, obstruction, grouping, world model, viewport/element/full-page capture, visual diff, coordinates, pointer and keyboard input, console, interception and network events, dialogs, downloads, uploads, cookies, storage state, tabs, viewport emulation, 2× pixel ratio, native CDP attachment |
| Offline tests       | 215 across eleven `tests/browser-use-*.test.ts` files plus `spa-render-ssrf`, about 2 seconds                                                                                                                                                                                                                                                                                                                                                                              |
| Matrix              | 50 `VERIFIED_MANAGED`, 519 `p`, 49 `N`, 52 `E`, 50 `?` — every `Y*` names the probe step that produced it                                                                                                                                                                                                                                                                                                                                                                  |
| Evidence is checked | verified facts cite a step; a test opens the JSON and fails if that step is missing or `ok: false`; a second test requires every step a driven browser ran to have passed, and pins the wording of the claims it depends on                                                                                                                                                                                                                                                |
| Not yet verified    | touch input, device emulation with a mobile UA, web sockets, persistence across a relaunch, **every Firefox / Safari / WebKit / mobile / non-Windows row**                                                                                                                                                                                                                                                                                                                 |
| Artifact            | `benchmarks/browser-use/artifacts/probe-2026-11-02T14-16-09-767Z.json`                                                                                                                                                                                                                                                                                                                                                                                                     |
| Run log             | `docs/browser-use/BROWSER_COMPATIBILITY_RESULTS.md` runs 1–5                                                                                                                                                                                                                                                                                                                                                                                                               |

What Phase 5 established, each item with a live run behind it: identity is a structural fingerprint
**plus** a node-lifetime token, because structure alone cannot tell a replaced element from the original
(`ID_RECYCLED`, both browsers); a covered element is not interactable and says which conflict made it so;
grouping a real DOM yields `[list, form, navigation]` with evidence for every group; and the world model
re-labels a renamed element instead of reporting a death and a birth, then refuses every identity of the
previous document after a real navigation to a page whose button looks identical.

Run 4 was the first probe step to navigate anywhere; run 5 added the rest of the protocol surface. What
Phase 4 now claims is deliberately narrow: these things worked **on Windows, on Chromium products, in a
managed launch, with no network involved**. Device emulation is claimed only as viewport geometry plus
pixel ratio — a mobile user agent and touch were never driven, so those cells stay `p`. `attachToRunning`
is verified as a loopback CDP connection to a browser this project started itself, not as attachment to a
browser somebody else left running, and the same step shows a public endpoint being refused.

## Checkpoint — 2026-11-01, during Phase 4

|                     |                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phases complete     | 3 of 13; Phase 4 started on one host                                                                                                              |
| Verified by running | 10 capability rows (launch, navigate, DOM read, geometry, accessibility) on Chrome 156 and Edge 156, Windows                                      |
| Offline tests       | 113 across five browser-use suites, about 1 second                                                                                                |
| Not yet verified    | screenshots, input, interception, downloads, cookies, dialogs, multi-session, **native attachment**, every Firefox / Safari / WebKit / mobile row |
| Artifact            | `benchmarks/browser-use/artifacts/probe-2026-11-01T13-49-38-153Z.json`                                                                            |
| Run log             | `docs/browser-use/BROWSER_COMPATIBILITY_RESULTS.md`                                                                                               |

Two same-day defects were caught by the first probe run. Playwright rejects `--user-data-dir` inside
`launch()`, so profile isolation had to move to `launchPersistentContext`; and `chrome.exe --version`
prints a localised message on Windows rather than a version, which arrived as mojibake and would have
been stored as one. Windows now reads the file-version resource. Neither was visible from unit tests,
because unit tests never touch a browser — which is the argument for the probe existing at all.

## Checkpoint — 2026-11-01, after Phase 2

|                   |                                                                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phases complete   | 2 of 13                                                                                                                                               |
| Tasks verified    | 2                                                                                                                                                     |
| Tasks tested      | 1 (the audit's regression suite)                                                                                                                      |
| Tasks in progress | 1 (Phase 3)                                                                                                                                           |
| Blocked           | 0                                                                                                                                                     |
| Files created     | `docs/browser-use/REPOSITORY_AUDIT.md`, `COMPETITIVE_ANALYSIS.md`, this file, `tests/spa-render-ssrf.test.ts`, `src/core/browser_use/*` (in progress) |
| Files modified    | `src/core/browser-tools.ts`, `src/core/crawl-tools.ts`, `scripts/run-tests.mjs`, `README.md`, `scripts/tool-counts.json`                              |
| Suite             | 71 files / 1237 tests, `TEST_RUN_PASS`, `verify:registry` 673 tools / 42 categories, `verify:package` 570 files / 0 credentials, format clean         |
| Commits           | `e5e2cfe` security fix · `d3cb567` badge syncer · `60006bd` audit                                                                                     |

## Phase 1 — Repository audit and baseline — VERIFIED

| ID    | Task                                                                                 | Status   | Files                                                  | Evidence                                                                             |
| ----- | ------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| P1-01 | Read every browser launch site rather than the descriptions                          | VERIFIED | —                                                      | `docs/browser-use/REPOSITORY_AUDIT.md` §2, §4                                        |
| P1-02 | Map the category integration contract (loader, profile, narrowing, manifest, guards) | VERIFIED | —                                                      | audit §1                                                                             |
| P1-03 | Record the absence list that drives the design                                       | VERIFIED | —                                                      | audit §5                                                                             |
| P1-04 | Baseline measurements (tools, categories, profiles, tests, CI, tarball)              | VERIFIED | `scripts/tool-counts.json`                             | audit §7                                                                             |
| P1-05 | Defect found: `spa_render` bypassed the SSRF guard                                   | VERIFIED | `src/core/crawl-tools.ts`, `src/core/browser-tools.ts` | `tests/spa-render-ssrf.test.ts`, 6 tests, 19 ms (proves no browser spawn on refusal) |
| P1-06 | Badge/table auto-sync silently stopped matching after the README redesign            | VERIFIED | `scripts/run-tests.mjs`                                | next run reports `2 ta yangilandi` instead of a refusal                              |

## Phase 2 — Competitive research — VERIFIED

| ID    | Task                                                | Status                           | Evidence                                                                                                   |
| ----- | --------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| P2-01 | Stagehand 4.3.0 at `b7a4b899`, source-level         | VERIFIED                         | `COMPETITIVE_ANALYSIS.md` §2; three-tier execution, hybrid AX snapshot, server-side-only cache             |
| P2-02 | Browserbase SDK 2.24.0 at `v2.24.0`                 | VERIFIED                         | §2; REST client, 5-minute connect window, search/fetch overlap                                             |
| P2-03 | browser-use 0.13.14 at `b49a68e4`                   | VERIFIED                         | §2; `backendNodeId` indexing with no re-validation, CDP-not-Playwright, secret placeholders                |
| P2-04 | Skyvern 1.0.56 at `50237377`                        | VERIFIED                         | §2; detach/re-query + structural hash, verification agent, `ENABLE_URL_VALIDATION` default False           |
| P2-05 | Midscene.js                                         | DOCUMENTED-only, flagged as such | §2 + §6 — internals not read at a pinned commit                                                            |
| P2-06 | Protocol capability matrix (CDP / BiDi / WebDriver) | VERIFIED against spec text       | §3; BiDi has **no accessibility module**, CDP is the only AX + hit-test source, Firefox dropped CDP at 129 |
| P2-07 | Benchmark feasibility on this machine               | VERIFIED                         | §4; BrowserGym core feasible, WebArena/VisualWebArena/WorkArena are not                                    |
| P2-08 | Open questions left open rather than guessed        | VERIFIED                         | §6                                                                                                         |

## Phase 3 — Registry, adapter contract, protocols — VERIFIED

| ID    | Task                                                                                            | Status   | Files / evidence                                                                                          |
| ----- | ----------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| P3-01 | Core types: product, engine, channel, protocol, capability, status, evidence class              | VERIFIED | `src/core/browser-use-contract.ts`                                                                        |
| P3-02 | Adapter contract (§3.4): one interface, per-product launch plans rather than a copy per browser | VERIFIED | `src/core/browser-use-adapters.ts` — 20 adapters, `browser-use-adapters.test.ts`                          |
| P3-03 | Capability-aware connection resolver (managed vs native, protocol selection, never conflated)   | VERIFIED | `src/core/browser-use-registry.ts` `selectBrowser`, `browser-use-registry.test.ts`                        |
| P3-04 | Browser registry: 21 products, per-OS executable candidates, version reading                    | VERIFIED | `src/core/browser-use-detect.ts`, `browser-use-detect.test.ts`; live `detect` step, runs 1–4              |
| P3-05 | Capability profile per product, with `UNSUPPORTED` distinct from `UNKNOWN`                      | VERIFIED | `src/core/browser-use-capabilities.ts` — 24 profiles × 30 capabilities, `supports()` refuses on `UNKNOWN` |
| P3-06 | Offline tests for detection + selection that require no installed browser                       | VERIFIED | injected `exists` / `which` / `readVersion`; 174 tests, ~2 s                                              |
| P3-07 | `ENGINE_SUPPORT_MATRIX.md`                                                                      | VERIFIED | generated by `npm run gen:browser-matrix`; `browser-use-matrix.test.ts` compares it byte for byte         |
| P3-08 | Attach endpoint validation: loopback allowed, private needs opt-in, public never                | VERIFIED | `validateAttachEndpoint` in `browser-use-registry.ts`                                                     |

## Phase 4 — Live compatibility — IN_PROGRESS (one host)

| ID    | Task                                                                                                                                                | Status      | Evidence                                                                                                                |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| P4-01 | A probe that can be re-run by anyone                                                                                                                | VERIFIED    | `scripts/browser-use-probe.mts` (`npm run probe:browser-use`)                                                           |
| P4-02 | Launch, navigate, DOM read, evaluate, geometry, AX                                                                                                  | VERIFIED    | runs 1–5, Chrome 156 and Edge 156 on Windows                                                                            |
| P4-03 | Hit testing (a covered element is not interactable)                                                                                                 | VERIFIED    | `obstruction` step from run 2 on; its wording is pinned by a test                                                       |
| P4-04 | Verified facts must name the step that proves them                                                                                                  | VERIFIED    | `browser-use-verified.ts` `probeStep`; tests open the JSON                                                              |
| P4-05 | Screenshots (viewport, element, full page) and visual diff                                                                                          | VERIFIED    | `screenshot`, `visual-diff` steps, run 5                                                                                |
| P4-06 | Pointer and keyboard input, console, interception and network events, dialogs, downloads, uploads, cookies, storage state, tabs, viewport emulation | VERIFIED    | `input`, `console`, `network`, `dialogs`, `downloads`, `uploads`, `cookies`, `storage`, `tabs`, `viewport` steps, run 5 |
| P4-07 | Native attachment to a running browser                                                                                                              | VERIFIED    | `attach-native`: `connectOverCDP` on a loopback endpoint, public endpoint refused in the same step                      |
| P4-08 | Touch input, device emulation with a mobile UA                                                                                                      | NOT_STARTED | never driven; `device-scale` proves pixel ratio, not a phone                                                            |
| P4-09 | Web sockets, persistence across a relaunch                                                                                                          | NOT_STARTED | `websockets` is `N` by protocol; persistence is genuinely unproven                                                      |
| P4-10 | macOS / Linux / Firefox / Safari / mobile rows                                                                                                      | BLOCKED     | not installable or launchable from this host; recorded as blocked, not skipped                                          |

## Phase 5 — Perception, object intelligence, world model — VERIFIED

| ID    | Task                                                                          | Status   | Evidence                                                                                                           |
| ----- | ----------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| P5-01 | One snapshot from DOM + AX + style + geometry + hit-test, each signal sourced | VERIFIED | `browser-use-perception.ts`, `perceive` step in runs 2–4                                                           |
| P5-02 | Identity that survives a replacement (structural hash + node-lifetime token)  | VERIFIED | `stale-detection` step: `ID_RECYCLED` on Chrome and Edge; first version of this failed the probe and was rewritten |
| P5-03 | Conservative visibility with the conflict named                               | VERIFIED | `obstruction` step, `conflicts` on the node                                                                        |
| P5-04 | A budgeted outline that reports what it dropped                               | VERIFIED | `serializeOutline`, `browser-use-perception.test.ts`                                                               |
| P5-05 | Object intelligence: group by structure, label only on evidence               | VERIFIED | `browser-use-objects.ts`; `group` step on a live shop fixture (run 3)                                              |
| P5-06 | World model: versioned per tab, immutable updates, incremental diff           | VERIFIED | `browser-use-world.ts`, `browser-use-world.test.ts` (23 tests)                                                     |
| P5-07 | A re-label is the same element with new words, not death and birth            | VERIFIED | `relabelled` in `diffSnapshots`; probe `world-model` step, both browsers                                           |
| P5-08 | Navigation voids the previous document, even for a look-alike element         | VERIFIED | `world-model` step navigates to a `data:` document (run 4)                                                         |
| P5-09 | Coverage: budget omissions, frames, scrolled region, unknown height as a gap  | VERIFIED | `Coverage` + `gaps`, tested offline                                                                                |
| P5-10 | Bounds that count what they drop (history, identities, transitions)           | VERIFIED | `browser-use-world.test.ts` bounds suite; eviction is reported in the delta                                        |
| P5-11 | Mutation-proved guards (no vacuous green)                                     | VERIFIED | each of P5-02/07/08 was re-broken deliberately and the suite failed as predicted                                   |

## Phase 6 — Coordinates and visual intelligence — IMPLEMENTED, partially VERIFIED

| ID    | Task                                                                         | Status      | Evidence                                                                                  |
| ----- | ---------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------- |
| P6-01 | Named coordinate spaces: CSS viewport, CSS page, device image, element-local | VERIFIED    | `browser-use-coordinates.ts`; 27 offline tests, arithmetic exact                          |
| P6-02 | Viewport ↔ page conversion with the scroll offset, outward rounding at scale | VERIFIED    | `cssToDevice` tests; `screenshot` step maps a DOM box to 97% blue                         |
| P6-03 | Three capture origins handled separately (viewport, full page, element)      | VERIFIED    | `boxInScreenshot`; all three driven against live captures in run 5                        |
| P6-04 | Device pixel ratio 2 mapping                                                 | VERIFIED    | `device-scale` step: 800x600 CSS → 1600x1200 image, button still on its box               |
| P6-05 | Hit-test revalidation before acting, with reported drift                     | VERIFIED    | `coordinates` step: a remembered point refused after a 400 px scroll and under an overlay |
| P6-06 | Frame offsets: refuse to guess an unmeasured one                             | TESTED      | `toTopFrame` returns null, mutation-proved; the collector does not yet measure offsets    |
| P6-07 | Pixel diff over raw RGBA with tolerance, bounding box and a region grid      | VERIFIED    | `browser-use-visual.ts`, 14 tests; `visual-diff` step on real captures                    |
| P6-08 | Screenshot annotation overlay as SVG (index, clamped labels, escaped text)   | TESTED      | `annotationOverlay` + offline tests; not yet drawn onto a live capture                    |
| P6-09 | Full-page stitching and per-frame screenshot offsets                         | NOT_STARTED | needs the frame-offset measurement in P6-06 first                                         |

## Decisions carried into the design, with the evidence behind each

| Decision                                                                                            | Why                                                                                                                                      | Evidence                                                                        |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Perception is DOM + accessibility + geometry, never vision-only                                     | CDP is the only protocol that exposes an AX tree; vision-only loses reversibility                                                        | §3 table; Stagehand and browser-use both converged on hybrid text serialization |
| Element identity must be revalidated before every action                                            | browser-use resolves a raw `backendNodeId` and can silently hit the wrong node; Skyvern's detach/re-query is the counter-example         | §2, §5                                                                          |
| Managed and native are separate modes and must never be conflated                                   | the brief forbids it; Stagehand's branded-handle rule shows how easily it drifts                                                         | §2 Stagehand                                                                    |
| Firefox goes over BiDi or not at all                                                                | Firefox removed CDP support at 129                                                                                                       | §3                                                                              |
| Safari claims are macOS + W3C WebDriver class only, and AX-tree features are reported `UNSUPPORTED` | no AX module in WebDriver; `safaridriver` is classic WebDriver                                                                           | §3                                                                              |
| Benchmarks ship raw artifacts (JSON + CSV + HTML) or they are not reported                          | every competitor number surveyed lacks a committed result artifact                                                                       | §5 traps                                                                        |
| Security defaults stay on                                                                           | Skyvern ships URL validation defaulting to **false**; Pro-Fetch's guard defaults to on and the audit just closed a door that bypassed it | §5, P1-05                                                                       |
| Cache hits must not decide whether a run is counted                                                 | Stagehand's cache exists only in the paid tier, so a cached benchmark is a benchmark of the cache                                        | §5                                                                              |
