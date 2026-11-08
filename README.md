<h1 align="center">
  <a href="https://github.com/Pro-Fetch/ProFetch">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/assets/cover-dark.png">
      <img alt="pro-fetch — 761 MCP tools, 46 categories, one gate" src="docs/assets/cover-light.png" width="860">
    </picture>
  </a>
</h1>

<p align="center">
  <b>761 MCP tools behind one server — one stdio process, no sidecar, no account.</b> Fetch,
  crawl, extract, convert, OCR, web and academic
  search, deep research, GitHub/GitLab/Gitea/Forgejo/Bitbucket, SQLite/Postgres/MySQL/Redis, OSV
  and SBOM, Slack/Jira/Linear/Notion, S3/Drive/Dropbox. The default profile advertises 12
  meta-tools that reach all 761, so a client with a small context window loses nothing except
  schema bytes.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@pro-fetch/mcp"><img alt="npm" src="https://img.shields.io/npm/v/@pro-fetch/mcp?label=npm&logo=npm"></a>
  <a href="https://nodejs.org"><img alt="node" src="https://img.shields.io/badge/node-%3E%3D22.13-5FA04E?logo=node.js"></a>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <a href="./README.md"><img alt="tests" src="https://img.shields.io/badge/tests-1980%20passing-success?logo=vitest"></a>
  <a href="https://github.com/Pro-Fetch/ProFetch/actions"><img alt="CI" src="https://img.shields.io/badge/CI-9%2F9%20jobs-2f2f34?logo=githubactions"></a>
</p>

---

- [Run it](#run-it) · [What answers which job](#what-answers-which-job) · [Profiles](#profiles) ·
  [Access control](#access-control) · [One round trip](#one-round-trip-instead-of-three) ·
  [The workflow gate](#the-workflow-gate) · [Limits](#limits-that-do-not-move) ·
  [Simple and MAX](#simple-and-max-mode) · [Optional binaries](#optional-binaries) ·
  [Verification](#verification) · [Categories](#categories)

## Run it

```bash
npx -y @pro-fetch/mcp
```

```json
{
  "mcpServers": {
    "pro-fetch": {
      "command": "npx",
      "args": ["-y", "@pro-fetch/mcp"],
      "env": { "PRO_FETCH_PROFILE": "smart" }
    }
  }
}
```

Copy-ready file: [`mcp.example.json`](./mcp.example.json). Node 22.13 or newer, required by
`pdfjs-dist@6`; everything else is optional and degrades with a named error.

Every call, direct or composed, crosses the same gate:

```text
client ──> dispatch() ──> permission policy ──> SSRF / sandbox / annotation checks ──> 761 handlers
                ▲
     12 meta-tools in the default profile reach the same gate,
     with the same policy applied to every call inside a batch.
```

Per-host instruction blocks — Claude Code, Codex, Gemini CLI, Copilot CLI, generic MCP — live in
[`adapters/`](./adapters/README.md). They are generated from the same text
`pro_fetch_workflow {action:"introduce"}` serves, and a test fails if the two drift.

## What answers which job

| Job                                                    | One call                 |
| ------------------------------------------------------ | ------------------------ |
| any URL → clean structured data (page, PDF, CSV, feed) | `pro_fetch_ingest`       |
| every relevant extraction out of one page              | `pro_audit_page`         |
| a topic researched, cited, verified                    | `pro_research_deep`      |
| a repository explained                                 | `pro_repo_audit`         |
| a pull request reviewed                                | `pro_pr_review`          |
| a site crawled and described                           | `pro_site_scan`          |
| a dataset loaded, profiled, transformed                | `pro_data_pipeline`      |
| N independent calls in one round trip                  | `pro_capability_call`    |
| many results collapsed into one answer                 | `pro_synthesize`         |
| the catalog searched in plain language                 | `pro_capability_map`     |
| a multi-step task planned, gated, evidenced            | `pro_fetch_workflow`     |
| any of the 761 by exact name                           | `pro_fetch_tool_execute` |

## Profiles

`PRO_FETCH_PROFILE` decides **how many schemas the model sees**. It is not the security boundary.

| Profile                | Tools | Contents                                  |
| ---------------------- | ----: | ----------------------------------------- |
| `minimal`              |    76 | http, convert, admin                      |
| `standard` _(default)_ |   201 | + github, search, extract, evidence, auth |
| `smart`                |    12 | the twelve above                          |
| `full`                 |   761 | everything                                |

`pro_fetch_profile_switch` changes it at runtime and takes effect on the next request.
`PRO_FETCH_PROFILE_CEILING` pins a maximum the switch may not pass; unset by default, because the
operator's instruction is what should govern. Set it when the server is shared and the model must
stay inside a smaller surface whatever it asks for.

## Access control

Enforced on every call, including calls made through the batch executor.

| Variable                       | Effect                                 |
| ------------------------------ | -------------------------------------- |
| `PRO_FETCH_ALLOWED_TOOLS`      | allowlist by exact name or `*`         |
| `PRO_FETCH_DENIED_TOOLS`       | denylist, applied after the allowlist  |
| `PRO_FETCH_DENIED_CATEGORIES`  | deny whole categories                  |
| `PRO_FETCH_READ_ONLY`          | block every mutating operation         |
| `PRO_FETCH_MUTATION_ALLOWLIST` | permit named mutations under read-only |
| `PRO_FETCH_OUTPUT_ROOT`        | contain every file write               |

If `pro_capability_call` is not on the allowlist, it does not run. Mutating tools are classified from
the registry, not from what a caller declares, so a tool cannot talk its way out of the gate.

Credentials go in a `.env` next to the server, or in `*_FILE` variables pointing at a file — never in
the value of a shell variable. `.env` is never committed and never ships in the package. Diagnostics
report only whether a credential is present and where it came from.

One gate is applied to the environment rather than to the caller. `NODE_TLS_REJECT_UNAUTHORIZED=0` turns
off certificate verification for a whole Node process, and it is the kind of thing that arrives inherited —
a desktop application or an agent runner exports it and every server spawned from it silently accepts any
certificate. pro-fetch sets verification back on at boot and says so on stderr, because a security property
that no tool result shows is a security property nobody can audit. `PRO_FETCH_ALLOW_INSECURE_TLS=true` is
the explicit opt-out for a trusted local network with self-signed certificates; while it is set the server
warns on every boot instead of fixing it quietly.

## One round trip instead of three

```jsonc
{
  "tool": "pro_capability_call",
  "arguments": {
    "calls": [
      { "tool": "pro_fetch_web_search", "arguments": { "query": "RAG architecture 2025" }, "label": "search" },
      {
        "tool": "pro_fetch_academic_search",
        "arguments": { "query": "retrieval augmented generation" },
        "label": "papers",
      },
      { "tool": "pro_fetch_news_search", "arguments": { "query": "RAG news" }, "label": "news" },
    ],
  },
}
```

Each element carries its own `ok` or `error`; one failure does not cancel the batch. `pro_synthesize`
then takes those results plus the question and returns one answer that says where each claim came from.

`pro_capability_map` with `detail: "summary"` is the cheap way in: it returned the tools, their schemas
and the order to call them for a 17-step audit in 3.8 KB instead of 43 KB — 91% fewer tokens, measured.

## The workflow gate

`pro_fetch_workflow` is one stateful lifecycle: plan → blind audit → risk dispositions → approve writes
→ execute → verify → final audit → finish. It refuses a plan whose requirements are unmapped, a risk
that was listed but not addressed, verification weaker than the claim it supports, and any completion
without evidence pointing at a real artifact. Every refusal is counted and reported.

Measured against a labelled corpus of 11 defective and 4 clean plans plus 5 completion claims: recall
1.00, precision 1.00, fake-completion rate 0.00. Writing the corpus is what found the first real hole —
a task with an empty `covers` list used to pass, so out-of-scope work is now refused by name.

What it does not do: steer a host's reasoning. The server sees the calls a model makes, not the ones it
skips, so the gates bind every call that goes through them and nothing more. That boundary is written
into `introduce` as `enforced` and `not_guaranteed` rather than glossed over.

## Limits that do not move

- **SSRF guard** — outbound HTTP(S) resolves DNS, checks the address, then pins the connection to the
  checked IP. Private, loopback, link-local and `.internal` targets are refused; `file:` and `gopher:`
  are not on the allowlist; credentials inside a URL are rejected. `HTTP_PROXY`/`HTTPS_PROXY` need
  explicit opt-in, because a remote proxy resolves DNS by itself.
- **Redirects** — credentials are stripped on a cross-origin hop, HTTPS→HTTP downgrades are blocked,
  and a loop is reported as bot protection instead of a hop count.
- **Workspace sandbox** — with `PRO_FETCH_OUTPUT_ROOT` set, every `output_path` and browser
  `storage_state_path` write is contained; symlinks and junctions are followed and rejected on escape.
- **Provider input** — `owner`, `repo`, `path`, `gist_id` and SHAs are validated centrally before any
  request is built, so traversal and API-relevant characters never reach the URL.
- **Process** — media bytes are identified by signature before any decoder sees them, every
  `import().then()` chain carries a `.catch()`, and `uncaughtException`/`unhandledRejection` log to
  stderr instead of killing the server.

## Simple and MAX mode

`PRO_FETCH_MODE` selects how much capacity one batch may use. Simple is the default and behaves
exactly as the versions before the option existed.

|                                    | simple _(default)_ | MAX                                               |
| ---------------------------------- | ------------------ | ------------------------------------------------- |
| calls per `pro_capability_call`    | 5 000              | 9 999 999 999                                     |
| concurrency: total / network / cat | 64 / 64 / 16       | 512 each                                          |
| a large batch runs                 | one batch          | chunks of `PRO_FETCH_BATCH_CHUNK` (1000)          |
| self-serve ceiling                 | —                  | `PRO_FETCH_MAX_SELF_SERVE` (99 999), then it asks |

The model can also pick per batch, which is usually the right place for the decision:

```json
{ "tool": "pro_capability_call", "mode": "max", "calls": ["…"] }
```

`mode` on a call lifts that batch's ceiling only. Concurrency semaphores are built at start-up and a
handler runs after, so `PRO_FETCH_MODE=max` remains the only way to raise those; the two are
deliberately not interchangeable. Above the self-serve line the tool refuses and says so, because
"read everything in this project" can mean four hundred requests or four hundred thousand, and only
the person asking knows which was meant — the caller re-sends with `confirm_large_batch: true`.

MAX raises capacity and nothing else. None of the limits above are capacity, so none of them move;
`tests/mode.test.ts` asserts the security probes **with MAX switched on**, so a change that routes a
containment limit through the mode fails the suite instead of shipping quietly. One capacity number
is also held down in MAX: `PRO_FETCH_MAX_PER_HOST_CONCURRENCY` stays at 8 by default and 512 at most,
because it limits requests to somebody else's server, where an unbounded batch is a denial of service.

## Optional binaries

| Missing                                         | What you get instead                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------- |
| `sharp`, `@napi-rs/canvas`, `tesseract.js`      | those media tools fail individually, the rest is unaffected                |
| `git`, `docker`, `kubectl`, `psql`, `redis-cli` | `COMMAND_NOT_FOUND` with the exact command named                           |
| Playwright browsers                             | the browser pack asks for `npx playwright install --with-deps chromium`    |
| install scripts (`--ignore-scripts`)            | SQLite tools answer `SQLITE_UNAVAILABLE` with `npm rebuild better-sqlite3` |

SQLite needs no system binary — it uses the bundled `better-sqlite3` driver, and the `sqlite3` CLI is
only a fallback. On Windows, npm tools invoke `npm-cli.js` through `process.execPath`, so `npm audit`,
`npm outdated` and license reports work there without a shell shim.

### A page that is not there yet

A server can answer `200 OK` with an instruction to build a page rather than the page: a few words of
navigation, an empty `<div id="root">`, and a script that fills it in. Read as-is, that is an empty
document with a healthy status, and the caller has no way to see that it was told nothing.

So the reader runs in two stages. The first stage is a plain HTTP request. If what came back is an HTML
shell, the second stage reads the same address in a headless browser and returns what the site actually
drew. Every answer names the stage that produced it:

```
status: 200 | text/html; charset=utf-8 | ~375 token | method: browser (4 words came back with 2 script
tag(s) — an HTML shell that scripts fill in, 2213ms)
```

The decision is taken from the response, never from a list of hostnames — those are last year's snapshot.
A page with real text keeps its HTTP answer even when it carries scripts: measured on `example.com`,
24 words of markdown and one script tag stay `method: http` at 504 ms, while the same request in a
browser costs 1218 ms to fetch what was already there. A refusal (`blocked`) is never re-read in a
browser: a host that said no is not a page that failed to paint. When Playwright is missing, the HTTP
document still comes back with the reason attached instead of the call failing.

`PRO_FETCH_BROWSER_ESCALATION=0` turns the second stage off server-wide, and a caller can override either
way per request with `escalate`. The two readings are stored in separate cache slots: an HTTP-only answer
is never handed to someone who asked for the rendered page.

### What the browser stage costs, and what is reused

Starting Chromium costs time and memory, so rendered reads run on a small pool of processes rather than one
process per page. Measured on three JavaScript-rendered pages in a row, same machine, same build:

| Read        | Cold start | Browser stage | Pool after the read |
| ----------- | ---------- | ------------- | ------------------- |
| first page  | 331 ms     | 2380 ms       | 1 process, 1 read   |
| second page | —          | 1501 ms       | 1 process, 2 reads  |
| third page  | —          | 1496 ms       | 1 process, 3 reads  |

One process served all three, and the saving on the second and third read is the ~880 ms of startup that is
no longer paid. Reuse stops at the process: **every read gets a fresh browser context, and that context is
closed when the read returns**, so cookies, `localStorage` and service-worker state cannot walk from one site
into the next answer. A pool that shared a context between sites would be a cross-site leak built to save a
millisecond.

| Variable                           | Default | What it bounds                                            |
| ---------------------------------- | ------- | --------------------------------------------------------- |
| `PRO_FETCH_BROWSER_POOL_SIZE`      | 2       | memory — every entry is a separate process                |
| `PRO_FETCH_BROWSER_POOL_MAX_PAGES` | 50      | growth — a process is retired and restarted past this     |
| `PRO_FETCH_BROWSER_POOL_IDLE_MS`   | 60000   | an untouched process is swept on the next acquisition     |
| `PRO_FETCH_BROWSER_POOL_WAIT_MS`   | 30000   | queue deadline, then `BRAUSER_HAVZASI_TOYIB` names itself |

The size and page ceilings are two of the limits MAX mode refuses to lift: they bound what this machine may
claim, not how fast it works. Sweeping runs on acquisition rather than on a timer, so a pool that is not being
used cannot keep itself alive, and a process with a read inside it is never swept — that read finishes and its
answer comes back intact. On `SIGTERM`/`SIGINT` the server closes every browser it owns and says how many in
the log, because a killed stdio server would otherwise leave Chromium children behind holding their profile
directories.

### What a rendered read refuses to fetch

A page asks for far more than text: photographs at full resolution, web fonts, video manifests. A read whose
purpose is `innerText` cannot use any of them, so the reader refuses them by default — `image, media, font`
(`PRO_FETCH_BLOCK_RESOURCES`, `none` to switch off).

Three kinds are deliberately protected, because refusing them changes _what the page says_ rather than how
fast it arrives: `document` is never refused (a blocked frame is a missing part of the answer), and
`script` / `xhr` / `fetch` are how a JavaScript-rendered page gets its data at all — blocking them produces
the empty shell the second stage exists to avoid. `stylesheet` is also protected in practice: `innerText` is
layout-dependent, so what CSS hides, the DOM reports as hidden.

Measured on this machine, same build, alternating order so the warm cache cannot flatter one side:

| Page                      | Refused      | With blocking | Without | Text returned        |
| ------------------------- | ------------ | ------------- | ------- | -------------------- |
| `wikipedia.org`           | 2 images     | 1141 ms       | 1688 ms | 259 words both ways  |
| `quotes.toscrape.com/js/` | 1 font       | 1492 ms       | 1827 ms | 247 words both ways  |
| `github.com` repo page    | 18–20 images | 3550 ms       | 3467 ms | 2501 words both ways |

Two honest readings of that table. The text was **identical** in every case — the policy removes bytes, not
content, which is the only reason it is allowed to be a default. And the speed win is not universal: it came
from the two pages whose media dominated their load, and nothing from a page whose images arrive from a fast
CDN anyway. `resources blocked: 18` is therefore reported as a **count**, never as "bytes saved": Playwright
does not say what an aborted request would have carried, and a number this project cannot measure is a number
this project does not print.

Interactive tools are untouched — screenshots and browser sessions run on sessions, where an image is the
point, so they never inherit this default.

### A document, not a blob of markdown

`pro_fetch_fetch_url` answers "what does this page say". `pro_fetch_document` answers the questions a
pipeline actually needs: is this the same page I read yesterday, what is it about, where did it come from.

```jsonc
{
  "document_id": "9f2c41ab77e05d13", // content address: same text → same id
  "revision": "sha256 of the body exactly as returned",
  "url": "https://example.org/a",
  "final_url": "…",
  "host": "example.org",
  "status": 200,
  "content_type": "text/html",
  "method": "http",
  "fetched_at": "2026-11-07T12:00:00.000Z",
  "title": "SQLite",
  "headings": [{ "level": 1, "text": "SQLite" }],
  "words": 214,
  "characters": 1482,
  "links": 2,
  "tables": 1,
  "code_blocks": 1,
  "truncated": false,
  "cached": false,
  "tokens": 371
}
```

Two identifiers, because they answer different questions. `document_id` is hashed over the body with
whitespace collapsed, so a re-render that only re-wrapped lines is recognised as the same document;
`revision` is the exact checksum, for when "identical" has to mean byte-identical. The id is recomputable
from the returned body — a test asserts that the tool and the hash agree — so it can be checked without
trusting the tool.

Provenance fields appear only when the fetch reported them: an envelope that always printed `browser_ms: 0`
would imply a browser had run when none did.

What the envelope deliberately does **not** contain: author, published date, summary, sentiment,
translation. A page that does not state those in its text cannot be asked for them honestly, and a schema
that invents fields to look complete is how a pipeline ends up citing something nobody wrote.
`include_body: false` returns the coordinates without the text, for routing.

### A crawl that survives its process

`pro_fetch_crawl_job` keeps a queue in SQLite (`PRO_FETCH_CRAWL_DB`, default
`~/.pro-fetch/crawl-queue.sqlite`): `enqueue` adds addresses, `next` hands out work, `mark` records what a
read produced, `reclaim` recovers claims left behind by a worker that died. A claim is a stored state with a
timestamp rather than a variable in memory, which is the difference between "the crawl restarts from zero"
and "one page is retried".

A URL is not a document. `mark` takes the `document_id` from `pro_fetch_document`; when the same content
arrives at a second address, that row becomes `skipped_duplicate` and points at the address where the
content was first read. So `stats` answers two different questions honestly — how many URLs were visited and
how many documents were learned — along with the duplicate rate and the age of the oldest pending row.

Reading the queue is a separate tool, `pro_fetch_crawl_job_status`, on purpose. Read-only mode decides by the
*name* of an action, so adding `stats`/`list`/`path` to the writing tool would have widened what those words
mean for every multi-action tool in the server. Split in two, `PRO_FETCH_READ_ONLY=true` still lets an
operator see what is owed, while the tool that hands out work stays refused. Every write in the queue passes
the same `assertWritable` gate the rest of the server uses.

### Rules this server keeps when it visits somebody else's site

**Search-result pages are not documents.** A results page is an engine's index rendered as HTML under that
company's terms, which forbid automated pulling — and it is the worst data source in the space: personalised
ordering, redirect-wrapped links, a layout that changes when the engine feels like it.
`src/core/crawl-policy.ts` refuses these addresses before a request leaves, for Google, Bing, DuckDuckGo
(including the `html` and `lite` front-ends), Brave, Startpage, Ecosia, Mojeek, Qwant, Yandex, Baidu, Seznam
and Naver. The refusal names the engine whose index was being read and the route that is allowed instead:
`pro_fetch_web_search`, backed by 23 registered engines each labelled with how it is accessed. The site itself
is not blocked — `https://news.google.com/rss/topstories` and `https://github.com/…` are documents and are
fetched.

**A login or paywall is an answer, and it is labelled as one.** When the redirect chain lands on a sign-in or
subscribe path, or the body is short and its only real content is "Sign in to continue" / "Subscribe to read",
the result carries `blocked.kind = "auth_wall"` with the evidence that fired. This is decided *before* the
browser stage, so a paywall is never rendered in the hope that its scripts reveal the article. A long article
that happens to mention logging in is not called a wall.

**The User-Agent says who is asking and where to complain.** The header is `pro-fetch-mcp/<version> (+contact)`. An operator running this for a company
sets `PRO_FETCH_USER_AGENT_CONTACT` to their own page; the default is this repository. A crawler with no
contact cannot be told anything when it is too fast or unwanted.

What none of this does: send credentials, solve a CAPTCHA, rotate proxies, or otherwise work around a refusal.
A host that said no is reported as having said no. The whole browser layer — the entry table, the pool bounds,
the resource policy, the circuit breaker and the measurements behind each of them — is written up in
[docs/BROWSER.md](docs/BROWSER.md).

## Verification

```bash
npm ci
npm run check
```

| Step              | What it proves                                                                                                                                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `verify:static`   | structural invariants: published counts, required smart tools, synonym vocabulary, no template dispatcher, image bytes validated before OCR, and that the README category table still matches the manifest                                                                                       |
| `verify:registry` | boots the real registry: **761 tools / 46 categories / all four profile counts**, every tool has a schema and a handler                                                                                                                                                                          |
| `test`            | **1980 tests** across 117 files — SSRF, redirects, permission policy, output sandbox, timeouts, every tool's input contract, every internal tool reference, live provider-failure behaviour                                                                                                      |
| `verify:package`  | the published tarball (687 files) has its shebang and `files` allowlist, and zero credentials or source files                                                                                                                                                                                    |
| `audit:schema`    | schemas against the code behind them — **a step of `npm run check`**: fails on a declared property the code never reads, or a required argument it never reads. Categories whose schema is rewritten by `applyCategorySchema` are measured but excluded from the gate, and the run says how many |

All 761 input schemas reject properties they do not declare. The MCP protocol itself was exercised
live against `dist/server.js` over stdio: `initialize`, `tools/list` (761 unique under `full`, 12
under `smart`, every schema `type: "object"`), `tools/call` for each advertised smart tool, hidden
tools refused, clean JSON-RPC on stdout.

## Categories

46 categories, 761 tools. The per-tool reference is generated from the running registry with
`npm run dump:catalog` into [`docs/TOOL_CATALOG.md`](docs/TOOL_CATALOG.md); the system map — entry
point, `dispatch()` gate, composites, profiles, MAX mode — is
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

|                    |                |                   |
| ------------------ | -------------- | ----------------- |
| `github` 49        | `browser` 41   | `convert` 30      |
| `collaboration` 28 | `research` 26  | `data` 26         |
| `admin` 26         | `codehost` 25  | `extract` 24      |
| `devops` 24        | `database` 24  | `security` 24     |
| `git` 23           | `crawl` 24     | `search` 24       |
| `http` 20          | `knowledge` 18 | `productivity` 18 |
| `storage` 16       | `archive` 15   | `media` 15        |
| `docs` 15          | `document` 13  | `auth` 12         |
| `apitest` 12       | `i18n` 12      | `sql` 11          |
| `monitoring` 10    | `encoding` 9   | `qr` 9            |
| `imageproc` 9      | `evidence` 8   | `index` 8         |
| `schema` 6         | `llm` 5        | `time` 5          |
| `zip` 5            | `opendata` 5   | `units` 5         |
| `binary` 4         | `geo_data` 4   | `chess` 4         |
| `color` 3          | `phonetics` 3  | `browser_use` 44  |
| `prohuman` 20      |                |                   |

---

<p>
  <img src="docs/assets/pro-fetch-scorpion-black.png" alt="pro-fetch" width="34" height="34" align="left" hspace="12">
  <b>pro-fetch</b> · MIT · <a href="CHANGELOG.md">Changelog</a> · <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="SECURITY.md">Security</a> · <a href="docs/RELEASE.md">Release procedure</a>
</p>
