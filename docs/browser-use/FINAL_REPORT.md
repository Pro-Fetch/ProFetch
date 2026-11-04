# Final report — Browser Intelligence Engine

Everything below is a number that exists because something ran, or a claim that exists because a test or a
run log made it true. Where something was not measured, it says so — the honest gaps are in
`LIMITATIONS.md`, not smoothed into this page.

## What was built

|                      |                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| Engine modules       | 21 files in `src/core/`, **7,725 lines** (`browser-use-*.ts`)                                  |
| MCP surface          | **44 tools** in `src/tools/browser_use/`, category `browser_use`, level 3 (`full` only)        |
| Server totals        | **717 tools, 43 categories** — the pack took the server from 673/42                            |
| Tests                | **404** in 20 `tests/browser-use-*.test.ts` files; server-wide **1,645 tests in 91 files**     |
| Compatibility probe  | **64 steps × 2 browsers**, all passing (`npm run probe:browser-use`)                           |
| MCP-native benchmark | **21/21 assertions** with live session, **11/11** without (`browser-use:bench:*`)              |
| Fixture benchmark    | **22/22** checks across four local pages, no network                                           |
| Support matrix       | 50 `VERIFIED_MANAGED`, 519 `p`, 49 `N`, 52 `E`, 50 `?` — generated, byte-for-byte drift-tested |

## What the probe actually ran, on this host

Chrome 156 and Edge 156, Windows, headless: launch and profile isolation, navigation, DOM read, in-page
evaluate, geometry, accessibility (via `ariaSnapshot`), hit testing, perception merge, stale detection,
overlay obstruction, object grouping, world-model relabel and navigation reset, three screenshot origins,
visual diff, pixel annotation, coordinate conversion at dpr 1 and 2, frame lifting with a measured offset,
pointer and keyboard input, console, network interception and events, dialogs, downloads, uploads,
cookies, storage state, tabs, viewport emulation, and native CDP attachment to a browser this project
started.

Nothing in the probe touches the network. Interception is proven by answering `probe.invalid` — a domain
the DNS spec says can never resolve — from memory, so a passing interception step means the route
answered, not that the connection was fast.

## The claims, and what backs each one

**Element identity survives replacement.** Identity is a structural hash _plus_ a per-node lifetime token in
a page `WeakMap`. A button replaced by an identical-looking one is refused: `ID_RECYCLED`, because the
collector's traversal ordinal came back the same and the token did not. This is the failure mode found in
the wild (a raw `backendNodeId` index looked up in a fresh map and clicked), reproduced in my own code
during development, then fixed — the first version passed every unit test and failed in a browser.

**A re-read knows what changed.** The world model is versioned per tab and updated by identity-keyed diff;
a rename is reported as `relabelled` (`Add to cart → In cart`) with a `replacement` identity offered, not
as one element dying and another being born. Navigation voids the previous document's identities even when
the new page contains a look-alike, including a reload at the same URL, which is detected because no
identity survived rather than because a URL changed.

**Coordinates mean what they say.** Four named spaces, three screenshot origins, outward rounding at
scale. Proven against pixels, not arithmetic: the DOM box of an element inside a `srcdoc` iframe, lifted by
a measured offset, lands on a crop that is 96% the button's colour; at dpr 2, 800×600 CSS becomes
1600×1200 image with the button still inside its box.

**Coverage is an accounting, not an adjective.** A band counts as seen only when a viewport has covered it
edge to edge; overlap is not coverage. The first version called a page "100% covered" while its bottom
button was still 1,123 px below the fold. A scan plan aims at band tops, clamped to the page's real
maximum scroll, because a target past that is clamped by the browser and the band's top never arrives.

**Acting is three decisions, not one.** Preflight refuses on a stale reference, a disabled or covered
element, a wrong-typed value, a destructive label, or a read-only process — each with its own reason.
Execution is injected. Verification re-reads and asks a question specific to the action, so the outcome
vocabulary keeps `EXECUTED_UNVERIFIED` distinct from `SUCCEEDED_VERIFIED`. Live: typing `SAVE20` read back
out of the page's own `value`; a click verified by the same node token now reading "In cart"; a checkbox by
its state flag; `"Delete account"` refused with the executor confirmed never to have run.

**A recovery must prove it was undone.** The health layer applied one local style rule to un-clip a
button, re-read the page to confirm the element became hittable (`FIXED_VERIFIED`), then removed the rule
and confirmed the finding returned. `rescueRecord` downgrades a verified claim with no re-read behind it.

**The server is the thing being measured.** The benchmark spawns `dist/server.js` and speaks stdio MCP, so
what it reports includes registry advertisement, serialisation, clipping and policy refusals — the surface
a model actually meets. It asserts correctness per call; 21/21 passed with a live session.

## Bugs the live runs caught (each kept as evidence)

1. `--user-data-dir` in `launch()` is rejected by Playwright → persistent-context launch.
2. `chrome.exe --version` prints a localised string on Windows, not a version → file-version resource.
3. First identity scheme was structural-only: probe failed, WeakMap token added.
4. TypeScript syntax leaked into the page-evaluated collector string → plain JS.
5. `input` probe step read a shared log field _after_ the click overwrote it — passed while proving
   nothing about the keyboard.
6. Label plate in the painter overwrote the box outline; corner came out grey, not cyan.
7. Coverage counted a band as visited on mere overlap; scan plans snapped to a stride grid and re-planned
   one position forever.
8. Collector reported `expanded: false` for every element and never read native `<label for>` — the
   diagnostics tool blamed a correct page for the collector's own gap.
9. `depth` derived from a path string that stops at the nearest `id`, so every id-bearing control ranked
   `depth: 1` and lost its own centre to an ancestor div. Found by the fixture bench, arbitrated by the
   browser's own `elementFromPoint`.
10. `jsonBlock` truncation silently corrupted base64 screenshots carried inside a JSON payload.
11. Two MCP-bench runs (11/18, 12/18) failed because the harness sent arguments the tools' schemas forbid —
    kept in `artifacts/` rather than deleted.
12. Backticks in a comment closed a page-evaluated template literal — twice, same file family.
13. A live coordinate map printed `read: 1500 node(s), none dropped` while the collector had stopped at its
    own element ceiling: true of the node budget, false of the page. The walk now reports what it saw, what it
    returned and whether it had to stop.
14. 328 boxes drawn on one viewport produced numbers sitting on other numbers. Annotation is now a space race:
    a label is drawn where nothing else is, and the labels that lost are counted, not hidden.

A pattern, not a list of accidents: unit tests on hand-built fixtures kept passing while the browser
disagreed. Every one of the items above was caught by driving something real.

## What the pack gained after this report was first written

Four tools and two behaviours, each added because a run showed the engine could not answer a question:

- **`pro_browser_use_elements`** — geometry for every element the read reached, in four coordinate spaces
  (`css-viewport`, `css-page`, `image-viewport-device`, `image-page-device`), with `identity`, node id and
  lifetime token on every row, plus filters by tag, role, name, region, depth and area.
- **`pro_browser_use_words`** — every visible word's box, from `Range.getClientRects()`, so a wrapped word
  keeps its fragments instead of reporting a union over text that is not part of it; `phrase` resolves an
  exact sequence to one rectangle.
- **`pro_browser_use_download` / `pro_browser_use_upload`** — transfers measured from the bytes: a download is
  verified by the saved file's size and sha256, an upload by reading the control's own `FileList` back. An
  upload takes caller bytes, never a local path.
- **Ceilings that follow the ask.** `collectorScript(cap)` and `wordScript(cap)` build the in-page walks with
  the ceiling the caller's budget implies, and every answer says whether its walk finished the document.
- **Readable annotation**, described above.

Measured on `https://en.wikipedia.org/wiki/HTTP`, chrome 156.0.8078.80, headless 1280x800, dpr 1. The run
log is committed at `benchmarks/browser-use/COORDINATE_MAP_LATEST.md` and the pictures at
`benchmarks/browser-use/artifacts/coordinate-map/` (the two CSVs, 1.5 MB together, are regenerated by
`npm run browser-use:map` rather than committed):

|                                                        |                                                                 |
| ------------------------------------------------------ | --------------------------------------------------------------- |
| Elements                                               | 4,696 reported of 5,927 in the document, walk finished          |
| Words                                                  | 9,775 measured, 0 past the cap, 47 wrapped across a line        |
| Words with no stamped owning element                   | 0                                                               |
| Phrase check                                           | `Contents` → box 60,140 61x16, inside its own element           |
| Element picture                                        | 329 boxes, 193 numbers legible, 238 labels with no free space   |
| Word picture                                           | 320 boxes, 493 numbers legible, 127 labels with no free space   |
| Enlarged paragraph crop (2x)                           | 54 word boxes, 95 numbers legible, 13 labels with no free space |

## What was deliberately not done

No competitor task-accuracy numbers, no BrowserGym/WebArena scores, no claim about Firefox, Safari, Linux
or mobile beyond what a specification says. `COMPETITIVE_ANALYSIS.md` stays at design properties read off
pinned commits; `LIMITATIONS.md` carries the rest. Failing or partial run logs are committed instead of
pruned, so the difference between "verified" and "believed" is auditable rather than asserted.

## Where to look

| question                       | file                                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| what works on which browser    | `ENGINE_SUPPORT_MATRIX.md`, `BROWSER_COMPATIBILITY_RESULTS.md` (ten runs, with failure logs) |
| what is not finished, honestly | `LIMITATIONS.md`                                                                             |
| how it is measured             | `BENCHMARKS.md`, `benchmarks/browser-use/`                                                   |
| what exists as tools           | `docs/TOOL_CATALOG.md` (generated), `src/tools/browser_use/`                                 |
| how it fits the server         | `REPOSITORY_AUDIT.md`, `docs/ARCHITECTURE.md`, `IMPLEMENTATION_STATUS.md`                    |
