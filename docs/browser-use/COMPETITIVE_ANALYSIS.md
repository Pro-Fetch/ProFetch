# Competitive analysis — Browser Intelligence Engine

Phase 2 of `docs/browser-use/`. Every claim carries the exact version or commit it came from and a
confidence class. **No competitor weakness below is invented** — where something was not checked it
says UNKNOWN, and where a claim exists only in marketing it says DOCUMENTED.

Confidence classes:

| Class | Meaning |
| --- | --- |
| DOCUMENTED | Stated in README/docs/release notes; not read in code |
| SOURCE-CONFIRMED | The code was read at the pinned revision, file and symbol named |
| EXPERIMENTALLY-VERIFIED | Actually executed here |
| INFERRED | Reasoned from the above, not directly shown |
| UNKNOWN | Not checked — deliberately left open rather than guessed |

Nothing here was copied into Pro-Fetch source. These are ideas to be informed by, not code to be
reused; Stagehand and Skyvern are respectively MIT and AGPL, and the AGPL parts are not even read
past the interface.

## 1. Pinned revisions examined

| System | Version | Commit / tag | Where read |
| --- | --- | --- | --- |
| Stagehand (`@browserbasehq/stagehand`) | 4.3.0 | `b7a4b899079f198a0ee78a6dcb62ad02f545cf49` (main, 2026-10-29) | cloned, source read |
| Stagehand protocol package | `@browserbasehq/stagehand-protocol` 3.1.0 | same tree | source |
| Browserbase Node SDK (`@browserbasehq/sdk`) | 2.24.0 | tag `v2.24.0`, commit `0a4d1720bbd79351413ca1c25ab522ee0c79c322` | source; note the repo is `browserbase/sdk-node` — `browserbase/sdk` returns "repository not found" |
| browser-use (Python) | 0.13.14 | `b49a68e4060acb226da8f784194fef301c53a6d7` (main) | source |
| Skyvern | 1.0.56 | `50237377361f1cb45036fa1784feea0a36732576` (main), Playwright 1.61.0 | source |
| Midscene.js | docs for v1.x | — | DOCUMENTED only |
| WebDriver BiDi | Editor's Draft, 8 Oct 2026; MDN modules page modified 22 Apr 2026 | — | spec read |
| CDP | devtools-protocol viewer (Stable 1.3 / tip-of-tree) | — | spec read |
| W3C WebDriver | revision date could not be fetched (HTTP 402) | — | UNKNOWN |
| BrowserGym / MiniWoB++ / WebArena / VisualWebArena / WorkArena | BrowserGym (ServiceNow, Apache-2.0), MiniWoB++ (Farama, MIT), WebArena v0.2.0 | — | DOCUMENTED |

## 2. What each system actually is

### Stagehand 4.3.0 — and the fact that v4 is a different product from v1–v3

**SOURCE-CONFIRMED.** `packages/sdk-ts` has **no puppeteer and no playwright dependency** at all
(`packages/sdk-ts/package.json`); it is a JSON-RPC client. All automation lives in
`packages/extension` ("understudy"), an MV3 service worker injected into the browser. The host
connects over CDP, finds the extension's `service-worker.js` target, `Target.attachToTarget
{flatten}`, `Runtime.addBinding`, and multiplexes its own RPC over that CDP socket
(`cdpClient.ts:400-440, 646`). `act` / `observe` / `extract` are RPC calls
(`stagehand.ts:246-321`).

Three execution tiers, and this is the single most useful architectural idea in the survey:

1. **Plain code** — `page.locator(x).click()`, `page.goto()`: pure CDP, never an LLM call.
2. **Deterministic AI-shaped step** — passing a structured `Action` object short-circuits to
   `takeDeterministicAction`, zero inference (`actService.ts:104-113`).
3. **LLM** — a string instruction: `waitForDomNetworkQuiet` → cache intercept → `captureSnapshot` →
   `inference.act` → map → execute. Two-step planning when the model asks for it, implemented by
   diffing two trees (`actService.ts:199-245`).

Element representation: a **hybrid DOM + accessibility** snapshot, not HTML and not a screenshot.
One `DOM.getDocument` per frame, `Accessibility.getFullAXTree` per frame, shadow DOM pierced, iframes
stitched by XPath prefix, serialized as an indented text outline
`[<frameOrdinal>-<backendNodeId>] role: name [selected][checked]` (`treeFormatUtils.ts:8`,
`capture.ts:42-60`). The model answers with an `elementId` matching `/^\d+-\d+$/`; it is mapped back
through an XPath map to a locator and executed as `DOM.scrollIntoViewIfNeeded` + `DOM.getBoxModel` +
`Input.dispatchMouseEvent` coordinates, typing via `Input.insertText`
(`understudy/locator.ts:369-446, 648`). URLs are replaced by numeric ids and re-injected after
extraction (`extractService.ts`).

Caching: **server-side only.** The runtime ships raw per-frame AX trees and parameters; the API
server owns cache-key hashing, URL normalisation, project gating and thresholds
(`cacheService.ts:22-69`). Because a cache hit requires a Browserbase `sessionId`,
**`localBrowser` never caches** (`cacheService.ts:57-69`) — the docs say so plainly (DOCUMENTED). A
hit replays with `selfHeal:false`; any replay failure records `missReason:"replay_failed"` and falls
back to the full pipeline. Model configuration is deliberately excluded from the key, so switching
models does not invalidate the cache. `selfHeal` defaults to **false** (`actService.ts:77`).

Browser support: **Chromium only**, over CDP plus its own extension. `localBrowser.launch()` finds a
real Chrome/Canary/Beta/Chromium binary (`findChromePath`, with `CHROME_PATH` override) and starts it
with `--remote-debugging-port`, `--enable-unsafe-extension-debugging`, `--remote-allow-origins=*`.
`localBrowser.connect({ cdpUrl, headers, extensionCdpUrl })` attaches to an already-running Chrome.
A branded `StagehandBrowser` handle is mandatory, and the docs state there is no Playwright interop:
you cannot hand a Playwright `Page` to `act()` (DOCUMENTED, `v4/migrations/playwright.mdx`).

Benchmarks: **no published accuracy numbers in the repository.** Only "2x faster execution than
Playwright cloud equivalent browsers" (README.md:322) and a v3 "30–40% lower inference cost" claim —
both DOCUMENTED with no methodology. A real harness does exist (`packages/evals`: WebVoyager,
OnlineMind2Web, WebTailBench, Odysseys, HardBench) but needs provider keys and a Browserbase API
key, and no raw results are committed. **Reproducibility: harness yes, results no.**

Real limitations, from source and issues: local mode loses both the cache and the model gateway;
`logging.onLog` cannot suppress duplicated stderr and third-party iframes emit ERROR-level frame
detachment logs (issue #3035, reproduced across 4.0.2/4.1.0/4.2.0-alpha); `AISdkClient` is pinned to
`LanguageModelV2` while AI SDK v6 emits V3 (#1645, 16 👍); "export reusable static extraction code"
open since 2025 (#389); Node ≥ 22.18.0; a local Chrome install is required.

### Browserbase SDK 2.24.0 — infrastructure, not intelligence

**SOURCE-CONFIRMED.** A Stainless-generated REST client (`node-fetch`, base
`https://api.browserbase.com`, 60 s timeout, 2 retries). Resources: sessions with
logs/recording/replays/downloads/uploads/debug, contexts, extensions, projects, secrets,
certificates, **navigation-policies**, webhooks, hosted `agents/runs` with a `systemPrompt` and a
`resultSchema`, plus `POST /v1/search` and `POST /v1/fetch` returning content as
`raw|markdown|json` with a schema — the latter two overlap directly with what Pro-Fetch already
does. No automation logic, no element model, no caching. Sessions hand back `connectUrl` (CDP),
`debuggerUrl`, `seleniumRemoteUrl`; Chromium only. Documented constraint that matters for any
integration: **a newly created session terminates if you do not connect within 5 minutes**
(DOCUMENTED).

### browser-use 0.13.14 — CDP-native, index-by-backendNodeId

**SOURCE-CONFIRMED.** Control loop serializes a flattened, tab-indented **accessibility-DOM hybrid
text tree**, not raw HTML: `DOMTreeSerializer.serialize_accessible_elements()` →
`browser_use/dom/serializer/serializer.py`. A rendered line is literally
`*[3]<button aria-label=Save />` or `\t\t[88]<input type=text placeholder=Email />`, with `*`
meaning "new since last snapshot", `|scroll element|` and `|IFRAME|` markers, attributes as
unquoted `key=value` capped at 100 characters. The screenshot is a **separate opt-in** flag
(`get_browser_state_summary(include_screenshot=...)`) — the model fuses the two itself, and there is
**no coordinate or highlight overlay used for grounding** (`python_highlights.py` exists only for
demo visualisation). How disagreements between the two are resolved: **UNKNOWN**.

Indexing: the index **is the CDP `backendNodeId`** (synthetic fallback on collision), stored in
`selector_map: dict[int, EnhancedDOMTreeNode]` and cached on the session. Bounds, client rects, ARIA
role/name and scrollability live on the node but only index/tag/attrs/scroll hints reach the model.
Stale handling is the weak point, and it is documented in their own error string —
`'Element index … not available - page may have changed. Try refreshing browser state.'` — with
**no identity or hash re-validation before the click**, so a recycled `backendNodeId` can resolve to
a different node silently. That is a source-level fact, not a speculation.

Browsers: **raw CDP via `cdp-use`, not Playwright** (`profile.py:722` — "we no longer use
playwright"; `session.py:15`). Chromium family only: `BrowserChannel` = chromium /
chrome(-beta/dev/canary) / msedge(-beta/dev/canary). It can drive a real browser with a real profile:
`BrowserProfile.cdp_url` ("connect to existing browser instance"), `executable_path`, `channel`,
`user_data_dir`, `profile_directory`, `BrowserSession.from_system_chrome(...)`.

Security is genuinely good: `sensitive_data` is sent to the model as **placeholder keys only**
(`<secret>key</secret>`) with real values redacted before the call and scoped per domain, and it warns
when secrets are configured without `allowed_domains`; `security_watchdog.py` enforces a domain
allowlist (pre-navigation raise, post-redirect → `about:blank`, optional IP-block); downloads are
path-containment checked (`_is_path_contained`).

Verification: it re-reads the whole browser state every step and the prompt instructs "NEVER assume
success — always verify from screenshot or browser state", but the action itself is trusted from the
CDP call and there is **no runtime judge** (`judge.py` is offline trace evaluation).

Benchmarks: "90.5% on Stealth Bench V2" and a 60-task Browser-Use Benchmark with no percentage —
DOCUMENTED, no methodology, **no reproducible harness found**. WebArena/WorkArena/Mind2Web/WebVoyager
figures: absent.

### Skyvern 1.0.56 — the verification agent and the stronger stale model

**SOURCE-CONFIRMED.** Its own tree builder runs in-page (`webeye/scraper/domUtils.js`) and Python
(`scraper.py::scrape_web_unsafe`) to produce a `ScrapedPage`; HTML is re-serialized as
`<tag attrs>text</tag>` through an attribute whitelist (`RESERVED_ATTRIBUTES`: `aria-*`, `role`,
`type`, `placeholder`, `name`, `href`, `value`, …), long hrefs hashed. Bounding rectangles are no
longer rendered at all — `draw_boxes` is deprecated, which is the opposite of the vision-first
school.

Indexing is the notable strength: the model references `element_id` (a `unique_id` attribute stamped
by the in-page script), mapped to a CSS `[unique_id='…']` locator, and **staleness is explicitly
handled** — `is_element_detached_error()` ("not attached to the dom") triggers one re-query, then
`MissingElement`; `count < 1` → `MissingElement`, `count > 1` → `MultipleElementsFound`; plus
`hash_element()` / `structural_identity()` epoch tracking. Compared with browser-use's raw
`backendNodeId`, this is the better contract.

Verification is a first-class step: a dedicated prompt
(`prompts/skyvern/check-user-goal-with-termination.j2`) re-reads parsed elements and screenshots and
returns `complete | terminate | continue` plus `failure_categories`; `CompleteAction.verified` and
`page.validate()` act as a decisive-criterion judge.

Security: an `untrusted` Jinja filter (`escape_code_fences`,
`neutralize_untrusted_web_page_data_sentinels`) plus the prompt rule that observations are
**untrusted data, never instructions**; SSRF validation exists but **`ENABLE_URL_VALIDATION` defaults
to False in the OSS build** (a real, sourced default-weakness), with `BLOCKED_HOSTS=["localhost"]`
and a DNS-resolving `validate_browser_host` when enabled; credentials are opaque `pref_<token>`
capabilities released under a same-site policy, with OTPs and `input_text` masked in logs; caps of
100 MB/file and 512 MB/run on downloads, 30 MB uploads, `HAR_CONTENT_POLICY="omit"`.

Browsers: Playwright, with an engine seam (`browser_engine.py`, `STOCK_ENGINE_NAME="playwright"`;
`rustwright`/`skycdp` registered but deny-all). Chromium confirmed via
`playwright.chromium.connect_over_cdp`; Firefox/WebKit creators exist but were not verified
(**UNKNOWN**). Real browser control: `BROWSER_TYPE="chromium-headful"`,
`BROWSER_REMOTE_DEBUGGING_URL`, `CHROME_EXECUTABLE_PATH`, a persistent profile directory, and a
Chrome-extension control mode.

Benchmarks: WebBench 64.4% and WebVoyager 85.8% — DOCUMENTED, model not pinned in the claim, though
the harness **is** in the repo (`evaluation/script/eval_webvoyager_task_v2.py`, VLM judge) with 15
result files under `evaluation/results/`, so these are the most reproducible numbers in the survey.

### Midscene.js — vision-first with a DOM fallback, and the widest platform list

**DOCUMENTED only** (v1.x docs; source not read at a pinned commit — treat every line here as
unconfirmed against code). Grounding is by appearance and position "without maintaining selectors",
deliberately avoiding sending large DOM trees; a simplified DOM tree is included only when
`domIncluded` is set, and screenshots default to on. `aiLocate` returns `center` + `rect` + a
web-only `pixelScale`. Model roles are split (Default / Planning / Locate / Insight) and
`deepThink:true` separates planning from locating into two calls. Caching is two-layer: a plan cache
keyed by prompt, and a web-only XPath locator cache in `./midscene_run/cache/*.cache.yaml` with
`read-only|read-write|write-only` strategies; the cache is invalidated when the XPath target's text
or the DOM structure changes, and `aiQuery`/`aiBoolean`/`aiAssert` are never cached. Reported effect
of a cache hit: 51 s → 28 s. Platform list is the widest found: Playwright, Puppeteer, desktop Chrome
over CDP, Android via ADB, iOS via WebDriverAgent, HarmonyOS via HDC, macOS/Windows/Linux desktop
including remote RDP, and a custom interface where you supply screenshots and actions. Reporting is a
self-contained single-HTML trace viewer with screenshots and the decision path — worth copying as a
concept. Benchmarks: AndroidWorld Pass@1 93.1% (Gemini-3.5-Flash), MobileWorld 78.6%,
AppControlBench 96.7% — **no Midscene version attached to any of them and no methodology published**
(methodology UNKNOWN).

## 3. Protocol reality — what can actually be built

This is the section that decides the architecture, because "universal browser support" is bounded by
protocols, not by ambition.

| Need | CDP | WebDriver BiDi (draft 2026-10-08) | W3C WebDriver |
| --- | --- | --- | --- |
| Attach to an already-running browser | yes — `--remote-debugging-port`/`-pipe`, multi-client since Chrome 63 | **UNKNOWN** (not clearly specified) | no native attach |
| Accessibility tree | `Accessibility.getFullAXTree` / `getPartialAXTree` / `queryAXTree` | **no accessibility module at all** | none |
| Hit-testing / element-from-point | `DOM.hitTesting` (INFERRED — method named, page fetch blocked) | **no module**; approximable via `script.eval` | none |
| Network interception | `Network` + `Fetch.enable` | `network.addIntercept` + request/response events | none |
| Input synthesis | `Input.dispatch{Key,Mouse,Touch}Event` | `input` module (key/mouse/scroll/file) | Actions API (pointer/key/wheel) |
| Element screenshot | via `backendNodeId` (INFERRED) | **viewport only**; full-page was open issue #384; no per-element | element screenshot **is** specified, plus Get Element Rect |
| Mobile | emulation + Android through ADB/webview devtools; **no iOS** | no first-class mobile | Appium (UiAutomator2 / XCUITest); Safari via `safaridriver` (INFERRED) |
| Who implements it | Chromium/Edge; Firefox deprecated CDP | **Firefox is production-ready and moved off CDP at Firefox 129**; Chromium ships it (Puppeteer ≥23 drives Firefox over BiDi; Playwright's BiDi is still experimental); WebKit/Safari minimal | everything, slowly |

Consequences, stated plainly:

- **CDP is the only protocol that gives an accessibility tree and hit-testing.** A Chromium-only
  engine can be excellent; the same engine on Firefox cannot use CDP at all.
- **BiDi is the cross-vendor future and is today strongest in Firefox** — which is also the browser
  with no CDP. Any "one protocol to rule them all" design is wrong; the connection resolver has to be
  capability-aware, exactly as the project brief demands.
- **Safari is neither.** `safaridriver` is W3C WebDriver behind a macOS-only, user-enabled
  automation port. Claiming "Safari supported" without saying macOS-only and WebDriver-class-only
  would be the kind of overstatement this project forbids.
- **iOS is a platform wall**, not an engineering gap: no remote debugging port for third-party apps,
  automation goes through WebDriverAgent/Appium on a Mac host.
- WPT signal for how uneven BiDi is: Firefox ~343 vs Chrome ~598 failing/skipped BiDi tests
  (playwright-bidi dashboard, read 2026-11-01).

## 4. Benchmarks we can actually run

| Benchmark | What it measures | Install cost | Needs an LLM? | Runs on Windows + Chromium? |
| --- | --- | --- | --- | --- |
| **MiniWoB++** (Farama, MIT) | 100+ small tasks, dense time-decayed reward | local HTML fixtures + Chrome/ChromeDriver over Selenium | no | **UNKNOWN** — official support is Linux/macOS |
| **BrowserGym** (ServiceNow, Apache-2.0) | Gym wrapper over MiniWoB++/WebArena/… ; metrics `reward`, `terminated` | `pip install browsergym`, `playwright install chromium`; core is offline | no | **core: feasible** |
| **WebArena v0.2.0** (Apache-2.0) | 812 functional-correctness tasks on self-hosted realistic sites | multi-container Docker + data generation + auto-login | env no, agent yes | **no** (Linux-first Docker) |
| **VisualWebArena** (MIT) | 910 multimodal tasks (233 human-evaluated, ~89% human success) | Docker sites; optional BLIP-2 captioner ~12 GB VRAM; Python 3.10–3.11 | env no | **no** |
| **WorkArena** (ServiceNow, Apache-2.0) | ServiceNow knowledge-work tasks: L1 33 atomic / 19,912 instances; WorkArena++ 682 composed | `pip install browsergym-workarena` **plus a live gated ServiceNow instance** via HuggingFace token | env no | **no** (external instance required) |

The honest reading: the industry-standard agent benchmarks are almost all Linux+Docker+live-backend
affairs. On this machine the reproducible ladder is **our own deterministic fixtures first,
BrowserGym core second, MiniWoB++ if it builds**, and WebArena-class suites only as a documented,
environment-gated extra that reports `BLOCKED_BY_ENVIRONMENT` rather than a fake pass.

## 5. The ideas worth taking, and the traps worth naming

Worth taking:

1. **Stagehand's three-tier execution split** — plain code, deterministic structured step, LLM
   fallback — is the right shape for a *tool surface*: the host AI can be as precise as it likes and
   fall back to natural language only where precision is expensive.
2. **Hybrid DOM+AX serialization as text, with the id inside the text** (`[frame-node] role: name`)
   is compact, model-friendly, and reversible. Both Stagehand and browser-use converged on it from
   different directions — that convergence is the evidence.
3. **Skyvern's staleness contract** — detached → re-query once → `MissingElement` /
   `MultipleElementsFound`, plus a structural hash — is strictly better than resolving an index and
   hoping, and it is cheap to implement.
4. **Skyvern's separate verification step** with an explicit status and failure categories.
5. **browser-use's secret placeholders** (`<secret>key</secret>` reaching the model instead of the
   value) and its domain-scoped watchdog.
6. **Midscene's single-file HTML trace report** — one artifact a human can open and audit.
7. **Browserbase's `navigation-policies` and staged secrets as platform primitives** — proof these
   belong in the product, not in user code.

Traps named by the evidence:

- **Indexing by raw `backendNodeId` without re-validation** (browser-use) — a recycled id resolves to
  the wrong element silently.
- **Caching that only exists in the paid tier** (Stagehand: `localBrowser` never caches) — a
  benchmark result obtained with the cache on is not a result about the engine.
- **`ENABLE_URL_VALIDATION` defaulting to False** (Skyvern OSS) — the security layer that reads well
  in docs is off by default in code.
- **Marketing numbers with no methodology** (Stagehand "2x faster", Midscene's model-only
  attributions, browser-use's Stealth Bench) — none of them ship a reproducible result artifact, which
  is why this project will commit raw JSON + CSV + HTML with every number it publishes.
- **A protocol that cannot express what we need**: BiDi has no accessibility module, so an
  AX-tree-based perception pipeline cannot be promised on Firefox today. Report `UNSUPPORTED`, not a
  silent DOM fallback.

## 6. What remains unknown after this phase

- Midscene internals at a pinned commit (only its documentation was read).
- Whether Skyvern's Firefox/WebKit paths work at all.
- W3C WebDriver spec revision examined (fetch returned HTTP 402).
- BiDi's ability to attach to an already-running browser.
- CDP `DOM.hitTesting` exact availability and semantics (named in the viewer, page fetch blocked).
- Any competitor's behaviour on the specific fixture pages this project will build — that is
  Phase 12 work, not research.

These are listed rather than filled in, because the alternative is a confident sentence nobody tested.
