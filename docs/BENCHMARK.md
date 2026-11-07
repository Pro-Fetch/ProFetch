# Search benchmark — what nineteen canonical queries say

`npm run bench:search` produces this table. It was run on this machine (Windows, one network path, Node 24)
on 2026-11-07. The corpus is `tests/fixtures/searchCorpus.ts`: nineteen queries whose correct answer is a
specific document written by the body that defines the thing — RFC 4180 for CSV quoting, SQLite's own page
for WAL modes, Unicode TR15 for normalization forms. **Every gold URL was fetched and returned HTTP 200
before it was written into the corpus**; one candidate query was dropped because its page did not answer.

## Measured

| engine | kind | hit@1 | hit@5 | hit@10 | MRR | prec@5 | p50 | p95 | failures |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| serper | general | 0.00 | **0.42** | 0.63 | 0.18 | 0.09 | 847 ms | 2387 ms | — |
| serper (second run, same corpus) | general | 0.00 | 0.32 | 0.53 | 0.13 | 0.06 | 793 ms | 1154 ms | — |
| duckduckgo | general | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 286 ms | 1181 ms | `empty_answer` × 19 |
| hackernews | community | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 504 ms | 1210 ms | `empty_answer` × 1 |
| wikipedia | reference | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 409 ms | 25014 ms | `empty_answer` × 5, `rate_limited` × 1 |
| npm | packages | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 683 ms | 1657 ms | `rate_limited` × 1 |
| itunes | media | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 316 ms | 677 ms | `empty_answer` × 2 |
| openalex | academic | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 721 ms | 1015 ms | — |
| crossref | academic | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 776 ms | 2158 ms | — |
| arxiv | academic | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 100 ms | 469 ms | `empty_answer` × 19 |
| pubmed | academic | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 382 ms | 3032 ms | `empty_answer` × 17 |
| europepmc | academic | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 319 ms | 17968 ms | `empty_answer` × 4 |
| doaj | academic | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 173 ms | 490 ms | `empty_answer` × 19 |
| google-news | news | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 338 ms | 638 ms | `empty_answer` × 4 |

Not configured on this machine, so not measured: brave, tavily, exa, serpapi, linkup, dataforseo,
google-cse, perplexity, marginalia (needs `PRO_FETCH_HTTP_COMPAT_UA`), searxng (needs `SEARXNG_URL`).

## What this says, in order of usefulness

1. **A general web index is the difference, and we do not own one.** The only engine that retrieved
   specifications at all is the one that fronts Google. Every keyless engine in the registry scored 0.00 on
   this corpus — and that is mostly *correct behaviour*, not failure: `kind` is printed for this reason. An
   app-store index is not supposed to find RFC 9110. The mistake this column prevents is reading "itunes
   0.00" as "iTunes search is broken".
2. **DuckDuckGo is not a fallback right now.** 19 of 19 queries returned HTTP 202 with no results. This is
   the number that justifies the registry existing: the engine that used to be the last resort was, on this
   day, worth nothing — and a chain that stops at the first engine that does not throw would have reported
   "no results" nineteen times.
3. **Run-to-run variance is larger than the differences between most engines.** The same engine on the same
   corpus gave hit@5 = 0.42 and 0.32 on two consecutive runs. Any claim of the form "engine X beats engine
   Y by one hit" is noise at this sample size, and the table says so rather than averaging it away.
4. **Academic engines are not empty because they are bad.** `arxiv` and `doaj` answered `empty_answer` for
   all nineteen queries because these are specification documents, not papers. `crossref` and `openalex`
   answered every query without an error and still scored 0.00 — they returned *answers*, just not the gold
   document. A failure count and a zero score are different statements, and the harness keeps them apart.

## What this is not

- **Not a human-relevance evaluation.** Each query has one gold publisher. A result that answers the user
  better than the gold page — a good tutorial, say — is counted as a miss. The metric is retrieval of a
  known document, and calling it "quality" would be a lie about the label set.
- **Not a ranking of vendors.** Nineteen queries about technical specifications favour whoever indexes
  standards bodies well. A real comparison needs the 5–10k labelled queries the plan calls for, plus human
  graders, and neither exists here.
- **Not a claim about our own index.** That measurement needs a separate process: running the corpus
  through `pro_index_fetch` + `pro_index_search` inside `tsx` aborted Node 24 in
  `RemoveEnvironmentCleanupHook` (`Assertion failed: (env) != nullptr`) — the SQLite addon plus this much
  TLS in one transformed process. The same sequence through the compiled server completed normally, so this
  is a harness problem, not a product one, and the script was deleted rather than shipped half-working.
  Own-index *speed* is measured in `docs/LATENCY.md` (p50 0.2 ms over 40 documents) and its retrieval
  correctness is asserted in `tests/local-index.test.ts`.

## Making it real

The next step is not more code, it is labels: 5–10k queries from actual use, each judged by a person on
whether the result answered it, held in the same format so `bench:search` scores them unchanged. Until that
exists, this file is a signal about which engines can retrieve documents we name — nothing more, and it
should be quoted as nothing more.
