# Limitations

What this engine cannot do, what has not been checked, and where a caller has to be careful. Written
from the code and the run logs, not from intention.

## Verified on one host, with two browsers

Every `Y*` in `ENGINE_SUPPORT_MATRIX.md` was produced on **Windows, with Chrome 156 and Edge 156**. That
covers the Chromium + CDP path well and nothing else:

- **Firefox (WebDriver BiDi)** — never run. The profiles describe it from specification text, which is
  exactly why the matrix separates `p` from `Y*`. BiDi has no accessibility module, so the AX-tree
  features that make perception useful on Chromium are not available there at all.
- **Safari** — `safaridriver` is macOS-only, so it cannot be reached from this host. Recorded as blocked,
  not skipped.
- **Linux** — unmeasured, including the Firefox path that would only be feasible there.
- **Mobile (ADB/Appium), Android/iOS** — adapters and profiles exist as descriptions; nothing was driven.
- **Native attachment** — verified only as a loopback CDP connection to a browser _this project started_.
  Attaching to a browser somebody else left running, on a port nobody controls, is a different situation
  and has not been exercised.

## What the collector does not see

- **Shadow DOM content is not collected.** `querySelectorAll('*')` does not cross a shadow boundary, so a
  component's internals are absent from every snapshot. The collector records that a node sits _behind_ a
  shadow host (`boundaries`), which is honest but not the same as perceiving it.
- **Cross-origin iframes contribute nothing.** A frame can only measure its own position if
  `window.frameElement` is readable; cross-origin frames are not, so their nodes are reported in
  `unlifted` with the reason and their coordinates are refused rather than assumed.
- **Closed `<details>` content is skipped deliberately** (the summary excepted). Browsers hide it through
  `::details-content`, which leaves children with a real rect and `visible` computed style — counting them
  would make "I revealed something" false. The cost: a scan reports an element only after a reveal.
- **1500 elements per frame, 400 per snapshot.** The collector stops at 1500 DOM nodes; perception keeps
  400, interactable-first. Both counts are reported (`truncated`), but truncated is a floor on what was
  _missed_, not on what exists.
- **`value` is read once, at collection time**, from the property. A control updated without a re-read is
  stale by design — that is what the identity check is for.

## Geometry and visual limits

- Coverage is measured in **vertical bands**. A page that scrolls sideways, or an inner scroll container,
  is not covered by the ledger and is not reported as a gap.
- **Full-page captures across frames are not composed.** Per-frame offsets are measured and boxes are
  lifted, but stitching one image out of several frame captures is not implemented.
- Screenshot comparison works on decoded RGBA. It is a **difference**, not a judgement: nothing here says
  whether a change was intended.
- Annotation digits are a 3×5 bitmap — digits only. Any other character is skipped and counted rather than
  drawn as something approximate.

## The world model is conservative, and that has a cost

Identity includes role, accessible name and text. A button that changes its label therefore **changes
identity**, and a held target stops resolving. This is the deliberate trade: a model that clicked "Add to
cart" after the page renamed it to "In cart" has performed an action nobody asked for. The cost is churn —
dynamic text (timers, prices updating, counters) produces relabels and refusals that a name-blind hash
would not. The answer is the `replacement` identity that relabels carry, but a caller has to use it.

`identityOf` also includes a per-node lifetime token held in a page `WeakMap`. Anything that re-creates a
node — a framework remount, `cloneNode`, an outerHTML rewrite — gets a new token and therefore a new
identity, even when it is byte-identical to the old one. The first version of this layer did not do that
and passed its own unit tests while failing in a browser.

## Not built

- **Drag-and-drop, clipboard, multi-touch, file upload through `act`.** Uploads exist in the older
  `browser` pack; this engine's action layer does not have them.
- **Dialog handling in sessions.** The probe drives `alert`/`confirm` on a page, but the session bridge has
  no auto-accept policy, so a page that opens a dialog stalls a session until something dismisses it.
- **Network control from a session** — request mocking and interception were verified in the probe, not
  exposed as `browser_use` tools.
- **Shadow traversal, virtualised list scrolling, infinite-scroll detection.**
- **axe-core style checks.** Health findings come from what perception observed: no contrast measurement,
  no ARIA-validity rule set, no keyboard-order analysis. "0 blocking findings" is not accessibility
  approval.

## Numbers that are not measurements

- **No competitor task-accuracy numbers exist here**, on purpose. Comparison against Stagehand,
  browser-use and Skyvern is design-level at pinned commits (`COMPETITIVE_ANALYSIS.md`). Scoring them
  would need their environments, prompts and retry policies run repeatedly; that has not happened.
- **WebArena, VisualWebArena and WorkArena** need infrastructure this host does not have. They are named as
  infeasible; no subset of them is reported as if it were the benchmark.
- **BrowserGym core** is recorded as planned, not run.
- All timings are one machine, one browser build, one run. The MCP connect number is dominated by Node
  startup and the registry's module graph; it is not a throughput claim.

## Sharp edges for callers

- **`tools/list` is ~713 schemas.** Only `full` advertises `browser_use` (level 3): `minimal`, `standard`
  and `smart` do not show it at all.
- **A session holds a browser process.** Idle sessions are reclaimed on the next `open`, not by a timer, so
  a client that opens and abandons sessions keeps processes until it opens another.
- **SSRF guard applies to `open` and `navigate`:** public http(s) only. No `file:`, no loopback, no
  link-local, no `data:`. Local development pages and internal admin UIs cannot be reached by design — the
  older `browser` pack, which shares the guard, is no different.
- **`act` refuses on labels, and refuses quietly-in-public.** "Pay now", "Delete account", "Send" come back
  `REFUSED` with the reason, and a confirmation flag does not override the destructive list by design; the
  human decision belongs outside this tool.
- **`evaluate` is off unless `PRO_FETCH_ALLOW_JS=true`.** The gate keys on the category name, so a new
  browser-driving category has to be added to it — that was a real near-miss during this build.
- **`PRO_FETCH_READ_ONLY=true` blocks every changing action** and leaves hover/focus/scroll allowed.
- **Cookie values are truncated to 24 characters** in `state_read`, because the presence of a session cookie
  is a fact about the page and its value is a credential.

## Known-unfixed

Nothing in this list is hidden because it is cosmetic; each has a failing or missing test behind it:

1. Shadow DOM and cross-origin frame content (listed above as "cannot see", not "might be wrong").
2. Horizontal and inner-container scroll are outside the coverage model.
3. Dialogs can wedge a session.
4. The `expanded` state is inferred for `<details>` and `aria-expanded` only; menus and accordions built
   from `hidden`/`class` toggles are discovered by re-reading, not predicted.
5. A page that grows while it is being scanned can leave the ledger's band count behind reality; the growth
   path handles scrolling past the reported bottom, but not content that collapses upward mid-scan.
