# Implementation status — Browser Intelligence Engine

Living tracker for `docs/browser-use/` work. Statuses: `NOT_STARTED · IN_PROGRESS · IMPLEMENTED ·
TESTED · VERIFIED · BLOCKED`. A task is `TESTED` only when tests exist and pass; `VERIFIED` only when
the evidence is reproducible by someone else. Nothing in this file is rounded up.

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

## Phase 3 — Registry, adapter contract, protocols — IN_PROGRESS

| ID    | Task                                                                                                                                                      | Status      | Notes                                                 |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------- |
| P3-01 | Core types: product, engine, channel, protocol, capability, mode                                                                                          | IN_PROGRESS | `src/core/browser_use/types.ts`                       |
| P3-02 | Adapter contract (§3.4 of the brief): identify, version, discover executable, launch, attach, tabs, lifecycle, capabilities, normalize, validate, cleanup | NOT_STARTED | must be one interface, not a per-browser copy         |
| P3-03 | Capability-aware connection resolver (managed vs native, protocol selection)                                                                              | NOT_STARTED | the survey says no single protocol covers the need    |
| P3-04 | Browser registry: detect installed products, versions, channels, OS, protocols                                                                            | NOT_STARTED | Windows-first, but the detection table must be per-OS |
| P3-05 | Capability profile per product, with `UNSUPPORTED` distinct from `UNKNOWN`                                                                                | NOT_STARTED | BiDi-without-AX is the concrete case                  |
| P3-06 | Unit tests for detection + selection, offline                                                                                                             | NOT_STARTED | no test may require a browser to be installed         |
| P3-07 | `ENGINE_SUPPORT_MATRIX.md`                                                                                                                                | NOT_STARTED |                                                       |

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
