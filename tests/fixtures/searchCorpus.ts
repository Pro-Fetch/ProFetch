/**
 * A search corpus with a verifiable gold answer per query.
 *
 * ## Why these nineteen and not five thousand
 *
 * The honest benchmark needs human judgements — a person saying "this result answered me" for thousands of
 * queries. That corpus does not exist here, and inventing one would produce a score that measures the
 * invention. What exists instead: queries whose answer is a **canonical document written by the body that
 * defines the thing** — the SQLite WAL page for WAL questions, RFC 4180 for CSV rules, the robots.txt
 * specification for robots.txt.
 *
 * Every `expected_hosts` entry below was fetched before it was written here, and each returned HTTP 200 on
 * 2026-11-06 from this machine. A query whose gold page could not be reached was dropped rather than kept
 * with an unverified answer — that is why there are nineteen and not twenty: `git-scm.com` did not answer.
 *
 * Scale it by adding rows, and re-run the reachability check before trusting any of them:
 *
 *   node -e "const c=(await import('./dist/tools/...')).SEARCH_CORPUS" …
 *
 * or simply run `npm run bench:search`, which reports a row as `gold_unreachable` when a page has died.
 */

export interface CorpusEntry {
  query: string;
  /** Hostnames that publish the defining document for this query. */
  expected_hosts: string[];
  /** Why this is the gold answer, in one line — so a reader can disagree with the label, not just the score. */
  gold: string;
}

export const SEARCH_CORPUS: CorpusEntry[] = [
  {
    query: 'sqlite wal checkpoint modes',
    expected_hosts: ['sqlite.org'],
    gold: 'SQLite documents its own WAL semantics; the truncate/restart modes are defined nowhere else',
  },
  {
    query: 'pragma wal_checkpoint truncate',
    expected_hosts: ['sqlite.org'],
    gold: 'the C API page for sqlite3_wal_checkpoint is SQLite’s own reference',
  },
  {
    query: 'write-ahead logging half of life checkpoint',
    expected_hosts: ['sqlite.org'],
    gold: 'auto-checkpoint threshold is a SQLite-specific parameter',
  },
  {
    query: 'full text search fts5 virtual table',
    expected_hosts: ['sqlite.org'],
    gold: 'FTS5 is documented by SQLite',
  },
  {
    query: 'http 429 too many requests status code',
    expected_hosts: ['datatracker.ietf.org', 'rfc-editor.org', 'www.ietf.org', 'httpwg.org'],
    gold: 'RFC 6585 defines the status code',
  },
  {
    query: 'csv field quoting rules',
    expected_hosts: ['datatracker.ietf.org', 'rfc-editor.org', 'www.ietf.org'],
    gold: 'RFC 4180 is the format specification',
  },
  {
    query: 'robots exclusion protocol directive',
    expected_hosts: ['www.robotstxt.org', 'datatracker.ietf.org', 'rfc-editor.org'],
    gold: 'the original specification is hosted at robotstxt.org; RFC 9309 is the standards-track version',
  },
  {
    query: 'rss 2.0 element list',
    expected_hosts: ['www.rssboard.org'],
    gold: 'the RSS Board maintains the 2.0.1 specification',
  },
  {
    query: 'etag conditional request if-none-match',
    expected_hosts: ['datatracker.ietf.org', 'rfc-editor.org', 'www.ietf.org', 'httpwg.org', 'developer.mozilla.org'],
    gold: 'RFC 9110 defines conditional requests; MDN documents the same semantics',
  },
  {
    query: 'javascript regex lookahead assertion',
    expected_hosts: ['developer.mozilla.org', 'tc39.es', 'www.ecma-international.org'],
    gold: 'the ECMAScript spec or MDN define lookahead notation',
  },
  {
    query: 'tcp congestion control window',
    expected_hosts: ['www.rfc-editor.org', 'datatracker.ietf.org', 'www.ietf.org'],
    gold: 'RFC 5681 defines TCP congestion control',
  },
  {
    query: 'json schema draft 2020-12 core',
    expected_hosts: ['json-schema.org'],
    gold: 'the specification is published at json-schema.org',
  },
  {
    query: 'unicode normalization forms nfc nfd',
    expected_hosts: ['www.unicode.org'],
    gold: 'Unicode Technical Report 15 is the definition',
  },
  {
    query: 'crontab field order minute hour',
    expected_hosts: ['man7.org', 'www.gnu.org', 'pubs.opengroup.org'],
    gold: 'the crontab(5) manual page and POSIX define the field order',
  },
  {
    query: 'tar ustar header fields',
    expected_hosts: ['www.gnu.org', 'pubs.opengroup.org'],
    gold: 'GNU tar documents the POSIX.1-2001 (ustar) layout',
  },
  {
    query: 'postgresql vacuum full lock',
    expected_hosts: ['www.postgresql.org'],
    gold: 'the PostgreSQL documentation defines VACUUM behaviour',
  },
  {
    query: 'redis aof fsync everysec',
    expected_hosts: ['redis.io', 'github.com'],
    gold: 'the persistence guide is Redis’s own documentation',
  },
  {
    query: 'docker build layer cache invalidation',
    expected_hosts: ['docs.docker.com'],
    gold: 'Docker publishes the build best-practices page',
  },
  {
    query: 'gzip data format deflate blocks',
    expected_hosts: ['www.ietf.org', 'datatracker.ietf.org', 'rfc-editor.org'],
    gold: 'RFC 1951 defines the DEFLATE compression format',
  },
];
