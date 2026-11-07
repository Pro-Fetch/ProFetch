# Latency — measured, with the parts that do not apply

`npm run measure:latency` prints the first table. It was run on this machine (Windows, one network path,
Node 24) on 2026-11-06; the numbers are not a promise about production, they are what this code does here,
and they are the only latency numbers this repository publishes.

| Path                                                        | n   | p50        | p95         | max      |
| ----------------------------------------------------------- | --- | ---------- | ----------- | -------- |
| local index — `searchIndex` over 40 indexed pages           | 40  | **0.2 ms** | 0.71 ms     | 0.83 ms  |
| `pro_fetch_web_search` one engine (`hackernews`)            | 8   | 474 ms     | 796 ms      | 796 ms   |
| `pro_fetch_web_search` fallback chain                       | 6   | 1261 ms    | 1357 ms     | 1357 ms  |
| `pro_fetch_web_search combine=true` (12 engines, no budget) | 5   | 2454 ms    | **9850 ms** | 11530 ms |
| `pro_fetch_answer_packet` (1 source read)                   | 4   | 1326 ms    | 1952 ms     | 1952 ms  |

Percentiles include network and provider time; the server's own work is the difference between the index
row and the rest.

## The one finding worth acting on

`combine=true` asks every configured engine. Without a deadline the call is as slow as its worst provider:
one run took **11530 ms** because a single index was having a minute. With `budget_ms: 800` the same five
queries behaved like this:

| budget_ms     | elapsed per query (ms)            | results returned |
| ------------- | --------------------------------- | ---------------- |
| 0 (no budget) | 1863, 3526, **11530**, 2301, 1269 | 5, 5, 5, 5, 5    |
| 800           | 954, 1220, 846, 1028, 869         | 5, 5, 5, 5, 5    |
| 1500          | 2040, 2261, 2289, 1506, 2225      | 5, 5, 5, 5, 5    |

The tail is cut from 11.5 s to 1.2 s and **nothing is lost** — the other eleven engines had already answered.
An engine that misses the deadline is not dropped: it is reported in `perEngine` with
`reason: "budget_exceeded"` and its own elapsed time, so the caller can see which index was slow rather than
discovering it by waiting.

That is the honest shape of the "0,5 soniyadan kam javob" goal:

- **Yes, sub-500 ms is reachable** — over our own index, at 0.2 ms p50, and over a single external engine
  at 474 ms p50.
- **No, it is not reachable for a fan-out to twelve third-party indexes**, because their p95 is theirs, not
  ours. What we control is the deadline, and the table above is what setting one buys.

## Which of the five standard steps apply here

The usual latency checklist assumes a hosted HTTP API with its own database. This package is a stdio MCP
server, and the HTTP door was removed from the repository, so three of the five steps are not this
codebase's to do:

| Step                                                  | Applies here?      | What it looks like in this server                                                                                                                                                                                                                            |
| ----------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fewer results, cheaper search type                    | **Yes**            | `limit` is bounded 1–25; `engine` forces one index instead of walking the chain; `combine` costs a fan-out and says so in `perEngine`                                                                                                                        |
| Search engine instead of `LIKE`                       | **Yes, in spirit** | SQLite FTS5 with `bm25()`, not a relational scan: 0.2 ms p50 over 40 documents. The measured 282 ms → 30 ms figures quoted around the web belong to somebody's Elasticsearch cluster; ours is a per-process index, so the comparison is stated, not borrowed |
| Caching                                               | **Yes**            | `cache_get/put/search/stats`, TTL-bounded, `Cache-Control: no-store` respected, and `read_at_ms` + `cached` in the answer packet so a caller can see which numbers came from cache                                                                           |
| gzip / response size                                  | **Not applicable** | There is no HTTP response to compress — the door was removed. Field selection is the equivalent that still exists: `answer_packet` returns passages, not pages, and `pro_fetch_html_to_text`/`readability` cut boilerplate before anything is sent           |
| Multi-region servers, 99.9% uptime SLA, paging alerts | **Not applicable** | Those are properties of an always-on hosted service. A stdio process started by an agent has no regions and cannot promise an SLA. Saying "99.9%" here would be a claim about infrastructure that does not exist                                             |

What replaces the last row honestly: every failure in this server is a named outcome
(`rate_limited`, `authorization_failed`, `budget_exceeded`, `cloudflare_challenge`, `edge_denied`,
`empty_answer`), and `pro_evidence_check` turns "the source said X" into a re-checkable claim. That is
observability an operator can act on, which is the useful half of a monitoring stack; the SLA half belongs
to whoever runs the servers, and right now that is not this repository.
