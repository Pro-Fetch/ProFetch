# Repository audit — before the Browser Intelligence Engine

Phase 1 of `docs/browser-use/`. Everything here was read from the working tree at commit
`191724e`+ on 2026-11-01, or measured by running it. Nothing is carried over from a previous
description of the project: the point of this file is that the next phase cannot assume any of it.

## 1. How a category actually integrates

The registration path a new `browser_use` category must join, with the file that owns each step:

| Step | Where | What it enforces |
| --- | --- | --- |
| Tool definition | `src/tools/<category>/<tool>.ts`, `defineTool({ name, category, description, inputSchema, handler })` | one file per tool; `additionalProperties: false` on every schema |
| Category index | `src/tools/<category>/index.ts` — imports each tool and `export default [...]` | `src/tools/browser/index.ts` lists 41 exports at lines 1-41 / 43-85 |
| Loader | `src/loader.ts:30-64` — one `import './tools/x/index.js'` side effect per category | a category not imported here does not exist at runtime |
| Schema narrowing | `src/loader.ts:66-71` → `core/schema-narrowing.ts` + `core/source-resolver.ts` | published properties are cut down to what the resolved source actually reads; a property the handler never touches is not advertised |
| Category vocabulary | `src/core/tool.ts:150-175` | per-category property unions; `applyCategorySchema` overwrites `required` for browser tools at `tool.ts:737-743` |
| Dispatch | `src/router.ts` → `src/core/tool.ts:1101-1160` → `src/core/execution-engine.ts:101-293` | one funnel: policy → concurrency gates (64 global / 16 per-category / 64 network) → timeout |
| Authorization | `src/core/security-policy.ts:84-166` | allow/deny lists, read-only, JS gate, mutating-action gate |
| Profile visibility | `src/core/profile.ts:58-79` (`CATEGORY_LEVELS`, default level 3), `PROFILE_LEVELS` | visibility only, never authorization |
| Counts | `scripts/tool-counts.json` (total 673, 42 categories, per-category numbers, profile sizes, testCount) | checked by `verify:registry` against the live registry, and by `tests/all-tools.test.ts` |
| Catalog | `npm run dump:catalog` → `docs/TOOL_CATALOG.md` | generated from the registry |
| Docs guard | `scripts/verify-static.mjs` | README/ARCHITECTURE/CONTRIBUTING/AGENTS counts must equal the manifest, and a deleted sentence fails |
| Package guard | `scripts/verify-package.mjs` | 570 files, shebang, no `.d.ts`, no credentials |

Adding a category therefore touches: `src/tools/browser_use/`, `src/loader.ts`, `src/core/profile.ts`
(a `CATEGORY_LEVELS` entry, or it silently defaults to level 3), `scripts/tool-counts.json`, and the
docs that quote counts. `npm run check` catches every one of those that is missed.

## 2. What the existing `browser` category is

41 tools, all thin wrappers. Every handler delegates to exactly two functions in
`src/core/browser-tools.ts`: `runBrowserTool` (17 tools, dispatched by tool-name string, lines
190-311) and `runBrowserAction` (24 tools, dispatched by an `action` string, lines 313-539). No
wrapper contains logic beyond injecting its action.

Capabilities actually implemented: open/close, click, `fill`-style type, form fill, login with
`storageState` export, scroll, wait, extract-after-action, `page.evaluate` (gated), console/network
log tails, viewport-only "device emulate", screenshot, PDF (Chromium-only), back/forward/reload,
get url/title/html/text/state, hover, select, press, tabs (new/list/switch/close), cookies,
dialogs, drag, upload, download, set headers, session list/close/close-all.

Runtime facts:

- Playwright is an **optionalDependency** (`package.json:88-91`), loaded lazily at
  `browser-tools.ts:81`; `playwrightAvailable()` (66-73) is the only probe, used by diagnostics.
- **Engine: Chromium only.** `chromium.launch({ headless: true })` at `browser-tools.ts:84` and again
  at `crawl-tools.ts:487`. No `firefox`/`webkit` anywhere in `src/`.
- `headless: true` is hardcoded; there is no headed mode.
- Launch args: `--disable-blink-features=AutomationControlled --no-sandbox --disable-infobars` (86).
- Product selection is one env string, `PRO_FETCH_BROWSER_CHANNEL` (82-85), also operator-settable
  through `pro_fetch_config_set` (`src/tools/admin/config_set.ts:28-29`).
- Session state: module-level `const sessions = new Map<string, Session>()` (18), keyed by a
  **caller-supplied `session_id` string defaulting to `'default'`** (56-58) — not by client or
  transport. Each session owns a full browser process, one context, and one tracked "active page";
  tabs mutate `session.page` (410, 433, 445). Cap: `PRO_FETCH_BROWSER_MAX_SESSIONS` default 8
  (39-42).
- One shared `~/.pro-fetch/browser-state.json` (23-26) is loaded into **every** new context (89-99)
  and written on close by any persisting session (143-153). There is no per-session isolation of
  cookies or storage.
- Fixed fingerprint: hardcoded Chrome-124/Windows UA, `en-US`, `America/New_York`, 1280×800,
  `deviceScaleFactor: 1`, `isMobile: false`, `hasTouch: false` (20-21, 91-99), plus a `STEALTH_INIT`
  init script (29-37).
- No shutdown hook closes sessions; browsers die with the process or with an explicit close tool.

## 3. Security that already applies to browsers (and is genuinely strong)

- **Every in-page request is proxied by this process.** `context.route('**/*', createProxyRouteHandler(...))`
  at `browser-tools.ts:109-119`; per-request `validateBrowserRequest` (44-50) and top-level
  `assertStableSafeUrl` (two-lookup DNS-rebinding check, `ssrf-guard.ts:172-206`). Bodies are fetched
  over a **connection pinned to the validated address** (`pinned-proxy.ts:442-496` →
  `http-client.ts:91-133`), so Chromium never resolves the name. >64 MiB bodies abort.
  `Set-Cookie` is replayed through `context.addCookies` (485-489).
- First navigation is `assertSafeUrl` (132-133, and 413-414 for `new_tab`).
- Action-level gate: `assertActionAllowed(action, tool)` at 321 against `MUTATING_ACTIONS`
  (`tool-classification.ts:141-153`); **unknown actions fail closed as mutations** (185-187).
- Sink guards: `assertWritable` before any screenshot/PDF write (166, 305), `assertReadablePath` for
  uploads (487), `assertWritablePath` for downloads checked *before* the click (503), symlink-safe
  resolution in `path-containment.ts:44-59`.
- JS gate: browser tools whose **name** matches `/evaluate|execute|script/i` need
  `PRO_FETCH_ALLOW_JS=true` (`security-policy.ts:135-143`); that flag is deliberately not
  settable through `config_set`.
- Error text is redacted by `sanitizeToolError` (`tool.ts:989-1016`).
- Known residual gap, self-documented: WebSockets are not routable through Playwright
  (`pinned-proxy.ts:37-39, 88-89, 117-119`).

## 4. Defect found during this audit — fixed in the same phase

**`pro_fetch_spa_render` bypassed the entire browser security stack.** `src/core/crawl-tools.ts:484-501`
launched its own bare `chromium.launch({ headless: true })`, called `browser.newPage()` and
`page.goto(url)` with **no `assertSafeUrl`, no `context.route`, no pinned proxy** — while
`assertSafeUrl` is imported in that same file (line 4) and used by every other crawl path (52, 184,
340, 422, 580). Chromium therefore resolved and fetched any address the caller asked for, including
`http://169.254.169.254/latest/meta-data/` and `http://127.0.0.1:6379/`. The browser category was
locked; this one door was not.

Fix: `withGuardedPage()` was added to `browser-tools.ts` — it validates the URL **before** spawning a
process, then reuses `createSession` (so it inherits the proxy, the navigation check and teardown)
instead of copying them. `spa_render` now calls it. The wrapper also stopped mislabelling a policy
refusal as "check that Playwright is installed", which sent callers off to fix something that was
never broken.

Regression tests: `tests/spa-render-ssrf.test.ts` — loopback, metadata address, `file:` scheme, the
message-is-not-a-dependency-error case, and two structural assertions that no private launch path
remains. They run in 19 ms, which is itself the evidence that no browser is spawned for a refused
address.

## 5. What does not exist anywhere in the repository

These absences are the actual requirements for the new engine — each one is a capability the design
document asks for and the code cannot provide today.

- **No coordinate geometry at all.** No `boundingBox()`, no `getBoundingClientRect()`, no
  `mouse.click(x, y)`, no touchscreen API. Interaction addressing is CSS-selector-only. The only
  geometry ever returned is `{x, y}` scroll position (`browser-tools.ts:265`) and viewport sizes (294-295).
- **No accessibility tree / ARIA snapshot.** No `ariaSnapshot`, no element handles, no role/name map.
- **No vision path.** Screenshots are written to disk and returned as a *text* path (297-298); no MCP
  image content, and nothing connects a browser screenshot to the OCR that already exists in
  `media-tools.ts`.
- **No browser discovery.** No `executablePath`, no installed-browser detection, no version or
  channel probing, no OS detection.
- **No native attachment.** No `connectOverCDP`, `connect()`, `launchServer`, WebDriver, WebDriver
  BiDi, or any way to look at a browser the user already has open.
- **No Firefox, no WebKit, no Safari** — managed or otherwise.
- **No mobile story.** `browser_device_emulate` only resizes the viewport; no ADB, no device
  emulation flags, no iOS path.
- **No session isolation by caller**, no idle eviction, no shutdown cleanup, no crash recovery.
- **No page coverage concept** — nothing records which regions of a page were inspected; no lazy-load
  or nested-scroll scanning; navigations always wait `domcontentloaded` only (133, 414, 472, 490).
- **No website-health diagnostics** as a product: console and network logs are kept as string tails
  (122-129) and returned raw; nothing classifies a failed stylesheet versus a CORS policy.
- **No verification layer**: a successful `locator.click()` is reported as success; nothing re-reads
  the world to confirm the intended state changed.

## 6. Test conventions the new code must follow

- `tests/*.test.ts`, run by `scripts/run-tests.mjs` which **fails on skipped tests** — a skipped test
  is treated as not-run, not as passing. `vitest.config.ts` uses the `forks` pool with
  `singleFork: false`, `testTimeout`/`hookTimeout` 60 s each (raised because 70 forks booting the
  673-tool registry exceed 30 s; measured, documented in the config comments).
- Live network tests gate on `tests/helpers/liveGate.ts` (`hostReachable`, `skipIfUnreachable`) so a
  dead network is reported as a skip by name, never as a product failure.
- Only one test file launches a real browser today: `tests/pinned-proxy.test.ts:92`, against a local
  loopback fixture server, with the SSRF validator stubbed (`111-116`) but the pinned transport
  exercised for real.
- `tests/security-boundaries.test.ts:410-511` reads `browser-tools.ts` **as text** and asserts every
  implemented action is classified read-or-mutate, then drives `assertToolAllowed` — the pattern this
  audit's regression test reuses.
- `tests/all-tools.test.ts` puts `browser` in its `NET` set, so browser handlers are checked for
  existence only and never dispatched. A new category that wants handler-level coverage must add its
  own tests; the shared suite will not provide them.
- No `vi.mock('playwright')` exists anywhere: handler tests that need a browser are honest about it or
  do not pretend to run one.

## 7. Baseline (measured, to be re-measured after each phase)

| Metric | Value | How measured |
| --- | --- | --- |
| Registered tools | **673** across **42** categories | `npm run verify:registry` → `registered=673; categories=42` |
| Profile sizes | minimal 74 · standard 179 · smart 12 · full 673 | same |
| `browser` category tools | **41** | `scripts/tool-counts.json`, enforced by `tests/all-tools.test.ts:51-57` |
| Test files / tests | 70 files, 1231 tests (before this phase's new file) | `npm run check` → `TEST_RUN_PASS files=70 tests=1231` |
| CI | 9/9 jobs green on the release commit | GitHub Actions, run 41219201278 |
| Published tarball | 570 files, 0 credentials, 0 source files | `npm run verify:package` |
| Engines used at runtime | 1 (Chromium, headless) | read of the two launch sites |
| Native attachment paths | 0 | grep for `connectOverCDP\|connect(\|launchServer\|webdriver` in `src/` |
| Coordinate/geometry APIs used | 0 | grep for `boundingBox\|getBoundingClientRect\|mouse.click` in `src/` |

Phase 2 must not inherit these numbers by memory: re-run `npm run check`, `verify:registry` and the
grep set, and diff against this table.
