/**
 * A crawl queue that survives the process.
 *
 * ## The gap this closes
 *
 * Everything else in this repository reads a page when it is asked. That is the right shape for a tool and
 * the wrong shape for a job: a crawl of five thousand URLs does not finish inside one call, and a caller who
 * keeps the list in memory loses it when the process dies — then restarts from zero, re-fetching pages it
 * already has, and paying for a duplicate it could have recognised.
 *
 * So the queue lives in SQLite. Three things follow from that choice and are the reason each exists:
 *
 * - **A claim is a state, not a variable.** `nextBatch` marks rows `fetching` with a timestamp. A worker
 *   that crashes leaves a claim behind; `reclaimStale` hands those rows back once they are older than the
 *   caller's own timeout, so a crash costs one page rather than the whole job.
 * - **A URL is not a document.** Two addresses can carry the same text — a syndicated article, an AMP copy,
 *   a page with a tracking parameter. `markResult` records the content id from `src/core/document.ts`, and a
 *   second URL with an id already seen is stored as `skipped_duplicate` with a pointer to where that content
 *   first came from. That is dedupe by content, not by address, and it is the difference between "we visited
 *   5000 URLs" and "we learned 5000 documents".
 * - **Every write says it is a write.** `assertWritable` runs before anything changes the file, so read-only
 *   mode is honoured here exactly as it is everywhere else, and a queue cannot be quietly mutated by a
 *   server that was started to refuse mutations.
 *
 * ## What is not here
 *
 * No scheduler, no politeness clock, no robots cache: those live in the crawler and the policy layer. This
 * module stores what is owed and what is paid. It also does not pretend to know why a fetch failed — the
 * error is stored as the caller reported it.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { assertWritable } from './read-only-guard.js';

type SqliteRow = Record<string, unknown>;

interface SqliteLike {
  prepare(sql: string): {
    all(...args: unknown[]): SqliteRow[];
    get(...args: unknown[]): SqliteRow | undefined;
    run(...args: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  };
  exec(sql: string): void;
  close(): void;
}

export type QueueState = 'pending' | 'fetching' | 'done' | 'failed' | 'skipped_duplicate';

export interface QueueRow {
  url: string;
  host: string;
  depth: number;
  state: QueueState;
  added_at: number;
  attempted_at: number | null;
  error: string | null;
  document_id: string | null;
  /** Whose link list produced this URL — the crawl graph, kept so a caller can attribute the visit. */
  source_url: string | null;
  /** For a duplicate: the address whose read produced this content first. */
  first_url: string | null;
}

export interface EnqueueReport {
  added: number;
  already_queued: number;
  invalid: number;
  rejected_scheme: number;
}

let handle: { path: string; db: SqliteLike } | null = null;

export function queuePath(): string {
  const configured = process.env.PRO_FETCH_CRAWL_DB?.trim();
  if (configured) return configured;
  return join(homedir(), '.pro-fetch', 'crawl-queue.sqlite');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS crawl_queue (
  url          TEXT PRIMARY KEY,
  host         TEXT NOT NULL,
  depth        INTEGER NOT NULL DEFAULT 0,
  state        TEXT NOT NULL DEFAULT 'pending',
  added_at     INTEGER NOT NULL,
  attempted_at INTEGER,
  error        TEXT,
  document_id  TEXT,
  source_url   TEXT
);
CREATE INDEX IF NOT EXISTS crawl_queue_due ON crawl_queue(state, added_at);
CREATE TABLE IF NOT EXISTS seen_documents (
  document_id TEXT PRIMARY KEY,
  first_url   TEXT NOT NULL,
  first_seen  INTEGER NOT NULL
);
`;

/**
 * Open the queue. The driver is optional in this package, so its absence is reported as itself with the
 * exact fix, rather than as an empty queue that would silently promise "nothing to do".
 */
export async function openQueue(): Promise<SqliteLike> {
  const path = queuePath();
  if (handle && handle.path === path) return handle.db;
  let open: new (file: string) => SqliteLike;
  try {
    const specifier = 'better-sqlite3';
    const mod = (await import(specifier)) as unknown as { default: new (file: string) => SqliteLike };
    open = mod.default;
  } catch (error) {
    throw new Error(
      'crawl navbati ishlashi uchun better-sqlite3 kerak — u majburiy boʻlmagan bogʻliqlik. ' +
        'Qayta qurish: `npm rebuild better-sqlite3`. Asl xato: ' +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  if (!existsSync(path)) mkdirSync(dirname(path), { recursive: true });
  const db = new open(path);
  db.exec(SCHEMA);
  handle = { path, db };
  return db;
}

/** For tests: close the held handle so a temporary file can be removed. */
export function closeQueue(): void {
  if (!handle) return;
  try {
    handle.db.close();
  } catch {
    // A driver that will not close is not a reason to fail the caller's own work.
  }
  handle = null;
}

/** Only http(s) addresses with a host enter the queue; anything else is counted, never guessed at. */
export function parseQueueUrl(raw: unknown): { url: string; host: string } | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { url: '', host: '' };
  if (!parsed.hostname) return { url: '', host: '' };
  return { url: parsed.toString(), host: parsed.hostname };
}

/**
 * Add addresses to the queue.
 *
 * A URL already queued keeps its original state: re-enqueuing a finished page must not silently reset it to
 * pending, which would make a crawl loop forever on the pages it has already read.
 */
export async function enqueueUrls(
  urls: unknown[],
  options: { depth?: number; source_url?: string } = {},
): Promise<EnqueueReport> {
  const db = await openQueue();
  assertWritable('crawl navbati yozuvi');
  const depth = Number.isFinite(options.depth) ? Math.max(0, Math.floor(Number(options.depth))) : 0;
  const source = typeof options.source_url === 'string' ? options.source_url : null;
  const report: EnqueueReport = { added: 0, already_queued: 0, invalid: 0, rejected_scheme: 0 };
  const now = Date.now();
  const find = db.prepare('SELECT url FROM crawl_queue WHERE url = ?');
  const insert = db.prepare(
    'INSERT INTO crawl_queue (url, host, depth, state, added_at, source_url) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const candidate of urls) {
    const parsed = parseQueueUrl(candidate);
    if (!parsed) {
      report.invalid++;
      continue;
    }
    // The sentinel shape says "a URL, but not one we may fetch" — counted separately so a caller can see
    // the queue refused it rather than accepted it.
    if (!parsed.url) {
      report.rejected_scheme++;
      continue;
    }
    if (find.get(parsed.url)) {
      report.already_queued++;
      continue;
    }
    insert.run(parsed.url, parsed.host, depth, 'pending', now, source);
    report.added++;
  }
  return report;
}

/**
 * Claim the next rows to work on, oldest first.
 *
 * Claiming is a write, so in read-only mode this refuses rather than returning rows nobody can mark done —
 * a queue that hands out work the caller cannot finish is worse than one that says no.
 */
export async function nextBatch(limit = 10): Promise<QueueRow[]> {
  const db = await openQueue();
  assertWritable('crawl navbati daʼvosi');
  const width = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 10;
  const now = Date.now();
  const rows = db
    .prepare("SELECT * FROM crawl_queue WHERE state = 'pending' ORDER BY added_at ASC, url ASC LIMIT ?")
    .all(width) as SqliteRow[];
  const claim = db.prepare("UPDATE crawl_queue SET state = 'fetching', attempted_at = ? WHERE url = ?");
  for (const row of rows) claim.run(now, String(row.url));
  // The rows were read before the claim was written, so their `state` column says `pending`. A caller told
  // "these are yours" while the payload said pending would have to guess which of the two to believe.
  return rows.map((row) => ({ ...rowOf(row), state: 'fetching' as QueueState, attempted_at: now }));
}

/** Claims older than `olderThanMs` are handed back — the shape of a worker that died mid-page. */
export async function reclaimStale(olderThanMs = 5 * 60_000): Promise<number> {
  const db = await openQueue();
  assertWritable('crawl navbati qayta daʼvosi');
  const cutoff = Date.now() - Math.max(1000, Math.floor(olderThanMs));
  const result = db
    .prepare(
      "UPDATE crawl_queue SET state = 'pending', attempted_at = NULL WHERE state = 'fetching' AND attempted_at < ?",
    )
    .run(cutoff);
  return Number(result.changes);
}

export interface MarkInput {
  document_id?: string | null;
  status?: number | null;
  error?: string | null;
}

/**
 * Record what a read produced.
 *
 * An error keeps the row and its reason; a success whose content id was already seen from another address
 * becomes `skipped_duplicate` and points at the first address. The first sighting of a document always
 * stays `done`, otherwise the original page would look like the duplicate of its own copy.
 */
export async function markResult(
  rawUrl: unknown,
  result: MarkInput,
): Promise<{ state: QueueState; first_url: string | null }> {
  const db = await openQueue();
  assertWritable('crawl navbati natijasi');
  const parsed = parseQueueUrl(rawUrl);
  const url = parsed?.url ?? String(rawUrl ?? '').trim();
  if (!url) return { state: 'failed', first_url: null };
  const now = Date.now();
  const error = typeof result.error === 'string' && result.error.trim() ? result.error.trim().slice(0, 500) : null;
  if (error) {
    db.prepare("UPDATE crawl_queue SET state = 'failed', error = ?, attempted_at = ? WHERE url = ?").run(
      error,
      now,
      url,
    );
    return { state: 'failed', first_url: null };
  }
  const documentId = typeof result.document_id === 'string' && result.document_id ? result.document_id : null;
  let firstUrl: string | null = null;
  if (documentId) {
    const seen = db.prepare('SELECT first_url FROM seen_documents WHERE document_id = ?').get(documentId) as
      { first_url?: unknown } | undefined;
    if (seen && typeof seen.first_url === 'string' && seen.first_url !== url) {
      firstUrl = seen.first_url;
      db.prepare(
        "UPDATE crawl_queue SET state = 'skipped_duplicate', document_id = ?, attempted_at = ?, error = NULL WHERE url = ?",
      ).run(documentId, now, url);
      return { state: 'skipped_duplicate', first_url: firstUrl };
    }
    if (!seen) {
      db.prepare('INSERT INTO seen_documents (document_id, first_url, first_seen) VALUES (?, ?, ?)').run(
        documentId,
        url,
        now,
      );
    }
  }
  db.prepare(
    "UPDATE crawl_queue SET state = 'done', document_id = ?, attempted_at = ?, error = NULL WHERE url = ?",
  ).run(documentId, now, url);
  return { state: 'done', first_url: null };
}

/** The queue as numbers: what is owed, what is paid, what turned out to be the same document twice. */
export async function queueStats(): Promise<{
  total: number;
  by_state: Record<string, number>;
  by_depth: Record<string, number>;
  distinct_hosts: number;
  distinct_documents: number;
  duplicate_documents: number;
  duplicate_rate: number;
  oldest_pending_age_ms: number | null;
}> {
  const db = await openQueue();
  const states = db.prepare('SELECT state, COUNT(*) AS n FROM crawl_queue GROUP BY state').all() as SqliteRow[];
  const depths = db.prepare('SELECT depth, COUNT(*) AS n FROM crawl_queue GROUP BY depth').all() as SqliteRow[];
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COUNT(DISTINCT host) AS hosts,
              COUNT(DISTINCT document_id) AS documents,
              MIN(CASE WHEN state = 'pending' THEN added_at END) AS oldest_pending
       FROM crawl_queue`,
    )
    .get() as SqliteRow;
  const byState: Record<string, number> = {};
  for (const row of states) byState[String(row.state)] = Number(row.n);
  const byDepth: Record<string, number> = {};
  for (const row of depths) byDepth[String(row.depth)] = Number(row.n);
  const total = Number(totals.total ?? 0);
  const duplicates = byState.skipped_duplicate ?? 0;
  const finished = (byState.done ?? 0) + duplicates;
  return {
    total,
    by_state: byState,
    by_depth: byDepth,
    distinct_hosts: Number(totals.hosts ?? 0),
    distinct_documents: Number(totals.documents ?? 0),
    duplicate_documents: duplicates,
    // Of the rows that finished, how many turned out to be content already read elsewhere.
    duplicate_rate: finished > 0 ? Math.round((duplicates / finished) * 1000) / 1000 : 0,
    oldest_pending_age_ms:
      typeof totals.oldest_pending === 'number' ? Math.max(0, Date.now() - totals.oldest_pending) : null,
  };
}

/** The rows in one state, for a caller that wants the list rather than the counts. */
export async function listState(state: QueueState, limit = 50): Promise<QueueRow[]> {
  const db = await openQueue();
  const width = Number.isFinite(limit) ? Math.max(1, Math.min(1000, Math.floor(limit))) : 50;
  const rows = db
    .prepare('SELECT * FROM crawl_queue WHERE state = ? ORDER BY attempted_at DESC, url ASC LIMIT ?')
    .all(state, width) as SqliteRow[];
  return rows.map(rowOf);
}

function rowOf(row: SqliteRow): QueueRow {
  return {
    url: String(row.url),
    host: String(row.host),
    depth: Number(row.depth ?? 0),
    state: String(row.state) as QueueState,
    added_at: Number(row.added_at ?? 0),
    attempted_at: typeof row.attempted_at === 'number' ? row.attempted_at : null,
    error: typeof row.error === 'string' ? row.error : null,
    document_id: typeof row.document_id === 'string' ? row.document_id : null,
    source_url: typeof row.source_url === 'string' ? row.source_url : null,
    first_url: null,
  };
}
