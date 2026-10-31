# pro-fetch

673 MCP tools in one stdio server: fetch, crawl, extract, convert, OCR, web and academic search, deep
research, GitHub/GitLab/Gitea/Forgejo/Bitbucket, SQLite/Postgres/MySQL/Redis, OSV and SBOM,
Slack/Jira/Linear/Notion, S3/Drive/Dropbox. The default profile advertises 12 meta-tools that reach all
673, so a client with a small context window loses nothing except schema bytes.

[![npm](https://img.shields.io/npm/v/pro-fetch?label=npm&logo=npm)](https://www.npmjs.com/package/pro-fetch)
[![node](https://img.shields.io/badge/node-%3E%3D22.13-5FA04E?logo=node.js)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/pro-fetch?color=blue)](./LICENSE)
[![tests](https://img.shields.io/badge/tests-1231%20passing-success?logo=vitest)](./)

## Run it

```bash
npx -y pro-fetch
```

```json
{
  "mcpServers": {
    "pro-fetch": {
      "command": "npx",
      "args": ["-y", "pro-fetch"],
      "env": { "PRO_FETCH_PROFILE": "smart" }
    }
  }
}
```

Copy-ready file: [`mcp.example.json`](./mcp.example.json). Node 22.13 or newer, required by
`pdfjs-dist@6`; everything else is optional and degrades with a named error.

Per-host instruction blocks — Claude Code, Codex, Gemini CLI, Copilot CLI, generic MCP — live in
[`adapters/`](./adapters/README.md). They are generated from the same text
`pro_fetch_workflow {action:"introduce"}` serves, and a test fails if the two drift.

## What you ask for, and what answers

| Job                                                    | One call                   |
| ------------------------------------------------------ | -------------------------- |
| any URL → clean structured data (page, PDF, CSV, feed)  | `pro_fetch_ingest`         |
| every relevant extraction out of one page              | `pro_audit_page`           |
| a topic researched, cited, verified                    | `pro_research_deep`        |
| a repository explained                                 | `pro_repo_audit`           |
| a pull request reviewed                                | `pro_pr_review`            |
| a site crawled and described                           | `pro_site_scan`            |
| a dataset loaded, profiled, transformed                | `pro_data_pipeline`        |
| N independent calls in one round trip                  | `pro_capability_call`      |
| many results collapsed into one answer                 | `pro_synthesize`           |
| the catalog searched in plain language                 | `pro_capability_map`       |
| a multi-step task planned, gated, evidenced            | `pro_fetch_workflow`       |
| any of the 673 by exact name                           | `pro_fetch_tool_execute`   |

## Profiles

`PRO_FETCH_PROFILE` decides **how many schemas the model sees**. It is not the security boundary.

| Profile                | Tools | Contents                        |
| ---------------------- | ----: | ------------------------------- |
| `minimal`              |    74 | http, convert, admin            |
| `standard` _(default)_ |   179 | + github, search, extract, auth |
| `smart`                |    12 | the twelve above                |
| `full`                 |   673 | everything                      |

`pro_fetch_profile_switch` changes it at runtime and takes effect on the next request.
`PRO_FETCH_PROFILE_CEILING` pins a maximum the switch may not pass; unset by default, because the
operator's instruction is what should govern. Set it when the server is shared and the model must stay
inside a smaller surface whatever it asks for.

## Access control

Enforced on every call, including calls made through the batch executor.

| Variable                         | Effect                                            |
| -------------------------------- | ------------------------------------------------- |
| `PRO_FETCH_ALLOWED_TOOLS`        | allowlist by exact name or `*`                    |
| `PRO_FETCH_DENIED_TOOLS`         | denylist, applied after the allowlist             |
| `PRO_FETCH_DENIED_CATEGORIES`    | deny whole categories                             |
| `PRO_FETCH_READ_ONLY`            | block every mutating operation                    |
| `PRO_FETCH_MUTATION_ALLOWLIST`   | permit named mutations under read-only            |
| `PRO_FETCH_OUTPUT_ROOT`          | contain every file write                          |

If `pro_capability_call` is not on the allowlist, it does not run. Mutating tools are classified from
the registry, not from what a caller declares, so a tool cannot talk its way out of the gate.

Credentials go in a `.env` next to the server, or in `*_FILE` variables pointing at a file — never in
the value of a shell variable. `.env` is never committed and never ships in the package. Diagnostics
report only whether a credential is present and where it came from.

## One round trip instead of three

```jsonc
{
  "tool": "pro_capability_call",
  "arguments": {
    "calls": [
      { "tool": "pro_fetch_web_search", "arguments": { "query": "RAG architecture 2025" }, "label": "search" },
      { "tool": "pro_fetch_academic_search", "arguments": { "query": "retrieval augmented generation" }, "label": "papers" },
      { "tool": "pro_fetch_news_search", "arguments": { "query": "RAG news" }, "label": "news" }
    ]
  }
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

`PRO_FETCH_MODE` selects how much capacity one batch may use. Simple is the default and behaves exactly
as the versions before the option existed.

|                                   | simple _(default)_ | MAX                              |
| --------------------------------- | ------------------ | -------------------------------- |
| calls per `pro_capability_call`   | 5 000              | 9 999 999 999                    |
| concurrency: total / network / cat | 64 / 64 / 16      | 512 each                         |
| a large batch runs                | one batch          | chunks of `PRO_FETCH_BATCH_CHUNK` (1000) |
| self-serve ceiling                | —                  | `PRO_FETCH_MAX_SELF_SERVE` (99 999), then it asks |

The model can also pick per batch, which is usually the right place for the decision:

```json
{ "tool": "pro_capability_call", "mode": "max", "calls": ["…"] }
```

`mode` on a call lifts that batch's ceiling only. Concurrency semaphores are built at start-up and a
handler runs after, so `PRO_FETCH_MODE=max` remains the only way to raise those; the two are
deliberately not interchangeable. Above the self-serve line the tool refuses and says so, because
"read everything in this project" can mean four hundred requests or four hundred thousand, and only the
person asking knows which was meant — the caller re-sends with `confirm_large_batch: true`.

MAX raises capacity and nothing else. None of the limits in the section above are capacity, so none of
them move; `tests/mode.test.ts` asserts the security probes **with MAX switched on**, so a change that
routes a containment limit through the mode fails the suite instead of shipping quietly. One capacity
number is also held down in MAX: `PRO_FETCH_MAX_PER_HOST_CONCURRENCY` stays at 8 by default and 512 at
most, because it limits requests to somebody else's server, where an unbounded batch is a denial of
service.

## Optional binaries

| Missing                                   | What you get instead                                        |
| ----------------------------------------- | ----------------------------------------------------------- |
| `sharp`, `@napi-rs/canvas`, `tesseract.js` | those media tools fail individually, the rest is unaffected |
| `git`, `docker`, `kubectl`, `psql`, `redis-cli` | `COMMAND_NOT_FOUND` with the exact command named      |
| Playwright browsers                       | the browser pack asks for `npx playwright install --with-deps chromium` |
| install scripts (`--ignore-scripts`)      | SQLite tools answer `SQLITE_UNAVAILABLE` with `npm rebuild better-sqlite3` |

SQLite needs no system binary — it uses the bundled `better-sqlite3` driver, and the `sqlite3` CLI is
only a fallback. On Windows, npm tools invoke `npm-cli.js` through `process.execPath`, so `npm audit`,
`npm outdated` and license reports work there without a shell shim.

## Verification

```bash
npm ci
npm run check
```

| Step                         | What it proves                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| `verify:static`              | structural invariants: published counts, required smart tools, synonym vocabulary, no template dispatcher, image bytes validated before OCR, and that the README category table still matches the manifest |
| `verify:registry`            | boots the real registry: **673 tools / 42 categories / all four profile counts**, every tool has a schema and a handler |
| `test`                       | **1231 tests** across 70 files — SSRF, redirects, permission policy, output sandbox, timeouts, every tool's input contract, every internal tool reference, live provider-failure behaviour |
| `verify:package`             | the published tarball (570 files) has its shebang and `files` allowlist, and zero credentials or source files |
| `audit:schema` _(on demand)_ | schemas against the code behind them — 0 dead properties, 0 unread required arguments              |

All 673 input schemas reject properties they do not declare. The MCP protocol itself was exercised live
against `dist/server.js` over stdio: `initialize`, `tools/list` (673 unique under `full`, 12 under
`smart`, every schema `type: "object"`), `tools/call` for each advertised smart tool, hidden tools
refused, clean JSON-RPC on stdout.

## Categories

42 categories, 673 tools. The per-tool reference is generated from the running registry with
`npm run dump:catalog` into [`docs/TOOL_CATALOG.md`](docs/TOOL_CATALOG.md); the system map — entry
point, `dispatch()` gate, composites, profiles, MAX mode — is
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

|                                  |                                 |                                  |
| -------------------------------- | ------------------------------- | -------------------------------- |
| `github` 49                      | `browser` 41                    | `convert` 30                     |
| `collaboration` 28               | `research` 26                   | `data` 26                        |
| `admin` 25                       | `codehost` 25                   | `extract` 24                     |
| `devops` 24                      | `database` 24                   | `security` 24                    |
| `git` 23                         | `crawl` 22                      | `search` 20                      |
| `http` 19                        | `knowledge` 18                  | `productivity` 18                |
| `storage` 16                     | `archive` 15                    | `media` 15                       |
| `docs` 15                        | `document` 13                   | `auth` 12                        |
| `apitest` 12                     | `i18n` 12                       | `sql` 11                         |
| `monitoring` 10                  | `encoding` 9                    | `qr` 9                           |
| `imageproc` 9                    | `schema` 6                      | `llm` 5                          |
| `time` 5                         | `zip` 5                         | `opendata` 5                     |
| `units` 5                        | `binary` 4                      | `geo_data` 4                     |
| `chess` 4                        | `color` 3                       | `phonetics` 3                    |

MIT · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) ·
[Release procedure](docs/RELEASE.md)
