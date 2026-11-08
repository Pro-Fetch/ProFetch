# The browser layer

How pro-fetch turns a URL into text when the text is not in the bytes the server sent. Everything numbered
here was measured on the development machine (Windows, Node 24, Playwright's bundled Chromium) unless the
sentence says otherwise; anything not measured is labelled as a decision rather than a fact.

## 1. Two stages, and how the second one is entered

`fetchUrl` always asks HTTP first. The response is then judged by `src/core/browser-escalation.ts`, from the
bytes in hand — never from a hostname list, because such a list is last year's snapshot:

| Observation in the response | Decision |
| --- | --- |
| the host returned a refusal page (`blocked`) | stay HTTP — a browser is not used to go around a no |
| HTTP status 400 or above | stay HTTP — an error is an answer, not an empty page |
| not HTML (JSON, PDF, text) | stay HTTP — there is nothing to paint |
| 40+ words of readable text | stay HTTP, even with scripts present |
| short text and no script tag | stay HTTP — the page is short, not unrendered |
| short text, scripts, and an empty mount element (`<div id="root"></div>`, `<app-root>`, empty `<body>`) | **render** |
| 12 or fewer words with scripts | **render** |

The two thresholds come from live readings rather than from taste. `quotes.toscrape.com/js/` answered 4 words
over HTTP and 247 in a browser. `example.com` answered 24 words with one analytics script: escalating it cost
1218 ms and added nothing, so "few words plus a script" alone is not evidence of a shell.

Every answer states which stage produced it:

```
status: 200 | text/html; charset=utf-8 | ~375 token | method: browser
(4 words came back with 2 script tag(s) — an HTML shell that scripts fill in, 2229ms)
```

`method` is not decoration. A document the server sent and a document the site drew after running its scripts
are different artefacts, and a caller cannot judge one they cannot locate.

**Switches.** `PRO_FETCH_BROWSER_ESCALATION=0` turns the second stage off server-wide; the `escalate` argument
overrides it per call. The two readings are stored in separate cache slots (`fetch:t<limit>|e<mode>|<url>`), so
an HTTP-only answer is never handed to someone who asked for the rendered page.

**When Playwright is missing** the HTTP document comes back with the reason attached. A missing optional
engine is reported, not fatal.

## 2. The pool: what is reused and what is not

`src/core/browser-pool.ts` keeps browser **processes** between reads. It never reuses a **context**: each read
creates one, navigates in it, and closes it. That is what stops cookies, `localStorage` and service-worker
state walking from one site into the next answer — a pool that shared contexts would be a cross-site leak
justified by a millisecond.

Measured on three JavaScript-rendered pages in sequence, same machine, alternating order so a warm cache could
not flatter one side:

| Read | Cold start | Browser stage | Pool after the read |
| --- | --- | --- | --- |
| first page | 331 ms | 2380 ms | 1 process, 1 read |
| second page | — | 1501 ms | 1 process, 2 reads |
| third page | — | 1496 ms | 1 process, 3 reads |

One process served all three; the saving on the later reads is the startup that is no longer paid.

Bounds, all clamped, all reported by `pro_fetch_browser_metrics`:

| Variable | Default | What it protects |
| --- | --- | --- |
| `PRO_FETCH_BROWSER_POOL_SIZE` | 2 | memory — each entry is a separate process |
| `PRO_FETCH_BROWSER_POOL_MAX_PAGES` | 50 | growth — a process is retired and restarted |
| `PRO_FETCH_BROWSER_POOL_IDLE_MS` | 60000 | an untouched process is swept |
| `PRO_FETCH_BROWSER_POOL_WAIT_MS` | 30000 | queue deadline, then `BRAUSER_HAVZASI_TOYIB` |

Three properties worth knowing before changing them:

- **One read at a time per process**, which makes the size knob the concurrency knob.
- **Sweeping happens on acquisition, not on a timer.** A pool nobody uses cannot keep itself alive.
- **A process with a read inside it is never swept or closed.** The read finishes and its answer comes back
  intact; on `SIGTERM`/`SIGINT` the server closes what it owns and logs the counts.

MAX mode does not lift the size or page ceilings: they bound what this machine may claim, not how fast it
works. A thousand browser processes is an out-of-memory crash with extra steps.

## 3. What a rendered read refuses to fetch

`src/core/resource-policy.ts`. Default refusal: `image, media, font` — bytes a text reader cannot use.
`document` is never refused; `script`, `xhr` and `fetch` are how a rendered page gets its data, so cutting
them produces exactly the empty shell this stage exists to avoid; `stylesheet` is protected because
`innerText` is layout-dependent.

Measured (best of alternating runs, same machine):

| Page | Refused | With blocking | Without | Text returned |
| --- | --- | --- | --- | --- |
| `wikipedia.org` | 2 images | 1141 ms | 1688 ms | 259 words both ways |
| `quotes.toscrape.com/js/` | 1 font | 1492 ms | 1827 ms | 247 words both ways |
| `github.com` repo page | 18–20 images | 3550 ms | 3467 ms | 2501 words both ways |

The honest reading: the text was identical in every case, and the speed win came only from pages whose media
dominated their load. The GitHub page gained nothing. `resources blocked: N` is a **count** — Playwright does
not say what an aborted request would have carried, so no byte figure is reported anywhere.

Interactive tools never inherit the default: screenshots and sessions run on sessions, where an image is the
point.

## 4. Failure handling

`src/core/circuit-breaker.ts` tracks consecutive **transport** failures per host — DNS could not resolve,
connection refused or reset, timeout, TLS failure. Three in a row opens the circuit; the host is then refused
in-process with a countdown, and after the cooldown one request goes through as a probe.

Answers do not count. A 404, a block page, a paywall and a rate limit all mean the host is talking, and
opening a circuit against them would hide the one signal that matters. The taxonomy in
`classifyFetchError` is what the metrics report and the load test aggregate on.

## 5. Running it in a container

`Dockerfile` uses the official Playwright image, because Chromium needs system libraries a slim Node image
does not carry, and pinning the image pins the browser build to the Playwright version. **This file has not
been built or run**: the development machine has no Docker. The verification commands are at the bottom of
the file; until they have been run, treat it as reviewed intent.

## 6. Measuring it yourself

```bash
npm run probe:block -- --n 500 --list hosts.txt   # what the web actually answers, per user-agent
npm run bench:load  -- --n 60 --escalate 1        # throughput, percentiles, stage split, pool accounting
```

Both refuse to hammer a single host: one request per address, and the server's own per-host limiter stays on.
The first run of `probe:block` on this machine, Tranco top 500: 182 hosts died in transport (128 unresolvable
DNS — the list itself is stale), 318 connected; bot user-agent 257 answers and 40 block pages, browser
user-agent 266 answers and 33 block pages.
