# Benchmarks

Three harnesses run against real code. The first two report a number only when they measured it and exit
non-zero on any failed assertion, so neither is usable as a green light that only proves the machine was on.
The third asserts nothing at all, and says so.

| harness       | command                                        | what it measures                                                                                                                  | artifacts                                                          |
| ------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| MCP-native    | `npm run browser-use:bench:mcp`, `:bench:live` | the server as a model sees it: stdio handshake against `dist/server.js`, `tools/list`, then per-tool calls with an assertion each | `artifacts/mcp-bench-*.json`/`.csv`, `MCP_BENCH_LATEST.md`         |
| Fixtures      | `npm run browser-use:bench:fixtures`           | whether the engine reaches the right answer on pages whose answers are written into the HTML                                      | `artifacts/fixture-bench-*.json`/`.csv`, `FIXTURE_BENCH_LATEST.md` |
| Coordinate map| `npm run browser-use:map`                      | a real public page listed and drawn: every element box, every word box, one paragraph enlarged; it checks nothing and exits 0     | `artifacts/coordinate-map/`, `COORDINATE_MAP_LATEST.md`            |

## What the fixture bench plants, and what it asks

Four local pages, loaded as `data:` URLs — no network, so a result cannot be a story about somebody's
uptime.

| fixture              | planted answer                                                                                     | what the bench asks                                                                                                                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `products.html`      | six named controls, a five-row list, a real form, five images with alt text                        | does perception report all six, does grouping call the list a list from shape alone, does a clean page earn zero blocking findings                                                                                     |
| `checkout.html`      | one unlabelled field, one 12-pixel target, a blue icon button, a "Pay now" button                  | does diagnostics report the unlabelled field and the tiny target; does a DOM box map onto the pixels it claims; is `Pay now` refused without a human decision while typing into a labelled field is allowed            |
| `moving-target.html` | a button that renames itself, is then replaced by a look-alike, then covered; a closed `<details>` | is a rename a relabel rather than a death and a birth; is a replaced element refused; is a covered element not offered as clickable; does a reveal reveal (absent → present → absent) with the summary identity intact |
| `tall.html`          | one control four screens down                                                                      | does a scan reach every band, and does the deep control get found by scrolling rather than by luck                                                                                                                     |

Latest run on this host: **22/22 fixture checks**, 21/21 MCP assertions including a live session, 64/64
probe steps. All on Chrome 156, headless.

## The bug this harness found

`checkout.html` asks whether typing into `<input id="card">` is allowed. It was refused: the reported
owner of the field's own centre was an ancestor `div`.

The geometry layer was sorting a hit stack deepest-first, and `depth` was computed as the length of the
collector's path string — but the path builder stops at the first ancestor carrying an `id`, because that
is what makes a path short and unique. So **every control with an `id` reported `depth: 1`**, whatever its
real position in the tree, and every one of them lost its own centre to an ancestor. The failure mode was
specific to the most common case in real markup: a labelled, id'd form field.

The fix measures depth on the tree (`depthOf`) instead of borrowing it from a selector-shaped string, and
the two are now documented as not sharing a formula. The same run also exposed the browser's own answer
disagreeing with ours — `document.elementFromPoint` at that centre returns the input — which is how the
bug was identifiable as ours rather than as a quirk of the page.

## What is deliberately not claimed here

**No competitor accuracy numbers.** `COMPETITIVE_ANALYSIS.md` compares _design properties_ at pinned
commits — whether an index is revalidated before acting, whether a URL guard is on by default, whether a
cache is in-process or server-side, whether the accessibility layer is a protocol read or a model
guess. Those are readable off source, and each row cites the revision it was read from.

A task-accuracy score against Stagehand, browser-use or Skyvern would require running them: their pinned
revisions, in their supported environments, against a shared task set, with their prompts and their retry
policy, several times each, on this machine. That has not been done, so no number is published for it. A
table of invented competitor scores is the fastest way to make every honest number in this repository
suspect.

The same rule applies to the task suites. WebArena, VisualWebArena and WorkArena need Docker and GPU
serving; they are out of reach on this host, and `docs/browser-use` says so rather than reporting a
subset as if it were the benchmark. BrowserGym's core is the feasible path and is recorded as planned,
not as measured.

## Reproducing

```bash
npm run build                          # the MCP bench spawns dist/server.js
npm run browser-use:bench:mcp          # ~15 s, no browser
npm run browser-use:bench:live         # ~40 s, needs a browser and network
npm run browser-use:bench:fixtures     # ~5 s, needs a browser, no network
npm run probe:browser-use              # the compatibility run behind the matrix's Y* rows
```

Each writes timestamped JSON and CSV under `benchmarks/browser-use/artifacts/` plus a latest markdown
summary. The artifacts of runs that _failed_ are kept, including the two where the MCP harness was passing
arguments its own tools reject: a harness that only keeps its passing runs documents nothing.
