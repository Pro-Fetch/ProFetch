/**
 * The local index: what this server has actually read, searchable in milliseconds.
 *
 * ## Why this exists, and what it is not
 *
 * pro-fetch has never had an index. Every search it performed went to somebody else's index — an official
 * API or a scraper — and came back as links. That is a fine tool and a poor product: the answer is only
 * as good and only as legal as the vendor behind it.
 *
 * This is the honest half of the other road. It is **not** a web-scale index — nothing here crawls
 * billions of pages, and claiming one would be the exact lie this repository checks itself for. It is an
 * inverted index over the documents *this installation has fetched itself*: each page read becomes
 * searchable in about a millisecond, each link between them becomes a countable signal, and each page
 * gets a next-visit time so re-reading is a policy rather than a memory.
 *
 * ## The two things that make it trustworthy rather than a cache
 *
 * 1. **The document and its index are one row.** FTS5 runs as an external-content table over `docs`, so a
 *    snippet is generated from the stored text, not from a second copy that can disagree with the first.
 *    Triggers keep them in step; if a trigger is ever missing, `pro_index_stats` reports the mismatch
 *    rather than hiding it.
 * 2. **Every write says it is a write.** `assertWritable` runs before any statement that changes the file,
 *    so `PRO_FETCH_READ_ONLY` refuses this the same way it refuses a file write — and the mutation
 *    scanner finds it by the call itself, not by the tool's name.
 *
 * ## Storage
 *
 * `PRO_FETCH_INDEX_PATH`, default `~/.pro-fetch/index.sqlite`. The file is server state, not user output:
 * it is not placed under `PRO_FETCH_OUTPUT_ROOT` because it is not a deliverable, and a caller who wants
 * it elsewhere sets the variable. `better-sqlite3` is an optional dependency; without it every tool in
 * here answers with the driver's own error and the command that rebuilds it.
 */

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { assertWritable } from './read-only-guard.js';
import { log } from './log.js';

export interface IndexedDocument {
  url: string;
  site: string;
  title: string;
  lang: string;
  kind: string;
  body: string;
  links: string[];
  fetchedAtMs: number;
}

export interface IndexHit {
  url: string;
  site: string;
  title: string;
  snippet: string;
  lang: string;
  kind: string;
  words: number;
  fetched_at_ms: number;
  age_hours: number;
  score: number;
}

/** A body longer than this is stored truncated, and the truncation is reported. */
const MAX_BODY_CHARS = 200_000;

/**
 * The schema, in one statement so a fresh file and an existing one reach the same shape.
 *
 * `plan.change_streak` counts consecutive visits that found the document changed. It is what lets the
 * interval adapt: a page that has changed on every visit for a week is not a weekly page.
 */
const SCHEMA = `
create table if not exists docs(
  rowid integer primary key autoincrement,
  url text not null unique,
  site text not null,
  title text not null,
  lang text not null,
  kind text not null,
  body text not null,
  words integer not null,
  truncated integer not null default 0,
  fetched_at_ms integer not null
);
create virtual table if not exists docs_fts using fts5(
  title, body, url unindexed, content=docs, content_rowid=rowid, tokenize='porter unicode61'
);
create trigger if not exists docs_ai after insert on docs begin
  insert into docs_fts(rowid, title, body) values (new.rowid, new.title, new.body);
end;
create trigger if not exists docs_ad after delete on docs begin
  insert into docs_fts(docs_fts, rowid, title, body) values ('delete', old.rowid, old.title, old.body);
end;
create trigger if not exists docs_au after update on docs begin
  insert into docs_fts(docs_fts, rowid, title, body) values ('delete', old.rowid, old.title, old.body);
  insert into docs_fts(rowid, title, body) values (new.rowid, new.title, new.body);
end;
create table if not exists links(
  src text not null, dst text not null, src_host text not null, dst_host text not null,
  seen_at_ms integer not null,
  primary key (src, dst)
);
create index if not exists links_dst on links(dst_host);
create table if not exists plan(
  url text primary key,
  site text not null,
  kind text not null,
  interval_ms integer not null,
  last_seen_ms integer not null default 0,
  next_due_ms integer not null default 0,
  change_streak integer not null default 0,
  digest text not null default ''
);
`;

/** How often each kind of page is worth re-reading, before any observation changes it. */
export const DEFAULT_INTERVAL_MS: Record<string, number> = {
  news: 60 * 60 * 1000,
  docs: 24 * 60 * 60 * 1000,
  page: 7 * 24 * 60 * 60 * 1000,
  reference: 30 * 24 * 60 * 60 * 1000,
};

type SqliteRow = Record<string, unknown>;
interface SqliteLike {
  prepare(sql: string): {
    all(...args: unknown[]): SqliteRow[];
    get(...args: unknown[]): SqliteRow | undefined;
    run(...args: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  };
  exec(sql: string): void;
  close(): void;
  prepare_cached?: (sql: string) => ReturnType<SqliteLike['prepare']>;
}

let handle: { path: string; db: SqliteLike } | null = null;

export function indexPath(): string {
  const configured = process.env.PRO_FETCH_INDEX_PATH?.trim();
  if (configured) return configured;
  return join(homedir(), '.pro-fetch', 'index.sqlite');
}

/**
 * Open the index. The driver is loaded lazily and its absence is reported as itself: an optional
 * dependency that is not installed is a machine fact, and the fix (`npm rebuild better-sqlite3`) is
 * different from every other failure here.
 */
export async function openIndex(): Promise<SqliteLike> {
  const path = indexPath();
  if (handle && handle.path === path) return handle.db;

  let open: new (file: string) => SqliteLike;
  try {
    const specifier = 'better-sqlite3';
    const mod = (await import(specifier)) as unknown as { default: new (file: string) => SqliteLike };
    open = mod.default;
  } catch (error) {
    throw new Error(
      `lokal indeks ishlashi uchun better-sqlite3 kerak — u majburiy bo'lmagan bog'liqlik. ` +
        `Qayta qurish: \`npm rebuild better-sqlite3\`. Asl xato: ${(error as Error).message}`,
    );
  }

  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new open(path);
  db.exec('pragma journal_mode = WAL');
  db.exec('pragma foreign_keys = on');
  db.exec(SCHEMA);
  handle = { path, db };
  log(JSON.stringify({ event: 'index.opened', path }));
  return db;
}

/** Only for tests: forget the open handle so a temp path takes effect. */
export function closeIndex(): void {
  if (!handle) return;
  try {
    handle.db.close();
  } catch {
    /* already closed */
  }
  handle = null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export interface PutResult {
  url: string;
  site: string;
  words: number;
  truncated: boolean;
  links_recorded: number;
  changed: boolean;
  next_due_ms: number;
}

/**
 * Store one document, and the links it points to.
 *
 * `changed` compares the digest with what was stored before: it is the observation the revisit plan
 * learns from, and it is why the plan is not a static table of guesses.
 */
export async function indexDocument(input: IndexedDocument): Promise<PutResult> {
  assertWritable('lokal indeks yozuvi');
  const db = await openIndex();
  const site = input.site || hostOf(input.url);
  if (!site) throw new Error(`url hostga ajratilmadi: "${input.url}"`);
  const body = input.body ?? '';
  const truncated = body.length > MAX_BODY_CHARS;
  const stored = truncated ? body.slice(0, MAX_BODY_CHARS) : body;
  const words = stored.split(/\s+/).filter(Boolean).length;
  const digest = digestOf(stored);

  const before = db
    .prepare('select rowid, digest from docs left join plan on plan.url = docs.url where docs.url = ?')
    .get(input.url) as SqliteRow | undefined;

  db.prepare(
    `insert into docs(url, site, title, lang, kind, body, words, truncated, fetched_at_ms)
     values (@url, @site, @title, @lang, @kind, @body, @words, @truncated, @fetched)
     on conflict(url) do update set
       site = excluded.site, title = excluded.title, lang = excluded.lang, kind = excluded.kind,
       body = excluded.body, words = excluded.words, truncated = excluded.truncated,
       fetched_at_ms = excluded.fetched_at_ms`,
  ).run({
    url: input.url,
    site,
    title: input.title || hostOf(input.url),
    lang: input.lang || 'und',
    kind: input.kind || 'page',
    body: stored,
    words,
    truncated: truncated ? 1 : 0,
    fetched: input.fetchedAtMs,
  });

  let linksRecorded = 0;
  for (const target of input.links ?? []) {
    if (!target || target === input.url) continue;
    const dstHost = hostOf(target);
    if (!dstHost) continue;
    const res = db
      .prepare(
        `insert into links(src, dst, src_host, dst_host, seen_at_ms) values (?, ?, ?, ?, ?)
         on conflict(src, dst) do update set seen_at_ms = excluded.seen_at_ms`,
      )
      .run(input.url, target, site, dstHost, input.fetchedAtMs);
    linksRecorded += res.changes;
  }

  // The plan row: an existing schedule keeps its own interval unless the caller names a kind for it.
  const kind = input.kind || 'page';
  const existing = db.prepare('select * from plan where url = ?').get(input.url) as SqliteRow | undefined;
  const changed = Boolean(existing) && String(existing?.digest ?? '') !== digest;
  const streak = changed ? Number(existing?.change_streak ?? 0) + 1 : 0;
  let interval = Number(existing?.interval_ms ?? 0) || DEFAULT_INTERVAL_MS[kind] || DEFAULT_INTERVAL_MS.page;
  // A page that changed on three consecutive visits is behaving like news, so it is capped at four hours
  // from then on and never planned tighter than one. Halving alone was measured to leave a weekly page at
  // 21 hours after six visits — converging, but not on any timescale a caller would call fresh.
  if (streak >= 3) interval = Math.max(60 * 60 * 1000, Math.min(Math.floor(interval / 2), 4 * 60 * 60 * 1000));
  const nextDue = input.fetchedAtMs + interval;

  db.prepare(
    `insert into plan(url, site, kind, interval_ms, last_seen_ms, next_due_ms, change_streak, digest)
     values (@url, @site, @kind, @interval, @seen, @next, @streak, @digest)
     on conflict(url) do update set
       site = excluded.site, kind = excluded.kind, interval_ms = excluded.interval_ms,
       last_seen_ms = excluded.last_seen_ms, next_due_ms = excluded.next_due_ms,
       change_streak = excluded.change_streak, digest = excluded.digest`,
  ).run({
    url: input.url,
    site,
    kind,
    interval,
    seen: input.fetchedAtMs,
    next: nextDue,
    streak,
    digest,
  });

  return {
    url: input.url,
    site,
    words,
    truncated,
    links_recorded: linksRecorded,
    changed,
    next_due_ms: nextDue,
  };
}

function digestOf(text: string): string {
  // A cheap, stable fingerprint. Not cryptographic — it only has to answer "did this change", and the
  // cryptographic one for the same question already exists in the evidence store.
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Search the index.
 *
 * FTS5's `bm25()` returns a negative number where closer to zero is better, so the score reported here is
 * negated: a larger number means a better match, which is the direction every other ranking in this
 * server already moves in.
 */
export async function searchIndex(
  query: string,
  options: { limit?: number; site?: string; kind?: string; sinceMs?: number } = {},
): Promise<{ hits: IndexHit[]; took_ms: number; matched: number }> {
  const db = await openIndex();
  const started = Date.now();
  const limit = Math.max(1, Math.min(50, options.limit ?? 10));
  const clauses: string[] = ['docs_fts match ?'];
  const args: unknown[] = [ftsQuery(query)];
  if (options.site) {
    clauses.push('docs.site = ?');
    args.push(options.site);
  }
  if (options.kind) {
    clauses.push('docs.kind = ?');
    args.push(options.kind);
  }
  if (options.sinceMs) {
    clauses.push('docs.fetched_at_ms >= ?');
    args.push(options.sinceMs);
  }
  const sql = `
    select docs.url as url, docs.site as site, docs.title as title, docs.lang as lang, docs.kind as kind,
           docs.words as words, docs.fetched_at_ms as fetched_at_ms,
           snippet(docs_fts, 1, '[', ']', ' · ', 18) as snippet, bm25(docs_fts) as rank
      from docs_fts join docs on docs.rowid = docs_fts.rowid
     where ${clauses.join(' and ')}
     order by rank asc limit ?`;
  args.push(limit);
  const rows = db.prepare(sql).all(...args) as SqliteRow[];
  const now = Date.now();
  return {
    hits: rows.map((row) => ({
      url: String(row.url),
      site: String(row.site),
      title: String(row.title),
      snippet: String(row.snippet ?? ''),
      lang: String(row.lang),
      kind: String(row.kind),
      words: Number(row.words),
      fetched_at_ms: Number(row.fetched_at_ms),
      age_hours: Math.round(((now - Number(row.fetched_at_ms)) / 3600000) * 10) / 10,
      score: Math.round(-Number(row.rank) * 1000000) / 1000000,
    })),
    took_ms: Date.now() - started,
    matched: rows.length,
  };
}

/**
 * Turn a user query into an FTS5 MATCH expression.
 *
 * FTS5 treats `"`, `*`, `(`, `)`, `-` and `NEAR/AND/OR` as syntax. A query is user text, so the safe
 * reading is: quote each term, keep word-prefix matching on the last one, and never let a stray quote
 * become a syntax error that looks like "no results".
 */
export function ftsQuery(query: string): string {
  const terms = String(query)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .split(/\s+/)
    .filter((term) => term.length > 1);
  if (terms.length === 0) return '';
  return terms.map((term, index) => `"${term}"${index === terms.length - 1 ? '*' : ''}`).join(' AND ');
}

export interface AuthorityRow {
  site: string;
  inbound: number;
  from_distinct_sites: number;
}

/**
 * Inbound links *we* have seen. This is the only authority signal this server can honestly produce: it
 * counts the graph it crawled, and it says so when the graph is small.
 */
export async function indexAuthority(limit = 20): Promise<AuthorityRow[]> {
  const db = await openIndex();
  const rows = db
    .prepare(
      `select dst_host as site, count(*) as inbound, count(distinct src_host) as from_distinct_sites
         from links where dst_host <> '' group by dst_host order by inbound desc limit ?`,
    )
    .all(limit) as SqliteRow[];
  return rows.map((row) => ({
    site: String(row.site),
    inbound: Number(row.inbound),
    from_distinct_sites: Number(row.from_distinct_sites),
  }));
}

export interface DueEntry {
  url: string;
  site: string;
  kind: string;
  interval_ms: number;
  due_in_ms: number;
  last_seen_ms: number;
  change_streak: number;
}

/** What is due for a re-read, soonest first. */
export async function planDue(
  now = Date.now(),
  limit = 50,
): Promise<{ due: DueEntry[]; overdue: number; scheduled: number }> {
  const db = await openIndex();
  const rows = db
    .prepare(
      `select url, site, kind, interval_ms, last_seen_ms, next_due_ms, change_streak
         from plan where next_due_ms <= ? order by next_due_ms asc limit ?`,
    )
    .all(now, limit) as SqliteRow[];
  const scheduled = db.prepare('select count(*) as n from plan').get() as SqliteRow;
  return {
    due: rows.map((row) => ({
      url: String(row.url),
      site: String(row.site),
      kind: String(row.kind),
      interval_ms: Number(row.interval_ms),
      due_in_ms: now - Number(row.next_due_ms),
      last_seen_ms: Number(row.last_seen_ms),
      change_streak: Number(row.change_streak),
    })),
    overdue: rows.length,
    scheduled: Number(scheduled?.n ?? 0),
  };
}

export interface IndexStats {
  path: string;
  exists: boolean;
  size_bytes: number;
  documents: number;
  indexed_rows: number;
  index_matches_docs: boolean;
  links: number;
  scheduled: number;
  due_now: number;
  by_kind: Record<string, number>;
  truncated_documents: number;
  fts5: boolean;
}

/**
 * The state of the index, including the one number that decides whether it can be trusted:
 * `index_matches_docs`. An external-content FTS table can be told to rebuild itself, and if the triggers
 * ever stop firing, searches would quietly miss documents that are plainly there.
 */
export async function indexStats(): Promise<IndexStats> {
  const db = await openIndex();
  const path = indexPath();
  const documents = Number((db.prepare('select count(*) as n from docs').get() as SqliteRow).n);
  const indexed = Number((db.prepare('select count(*) as n from docs_fts').get() as SqliteRow).n);
  const links = Number((db.prepare('select count(*) as n from links').get() as SqliteRow).n);
  const scheduled = Number((db.prepare('select count(*) as n from plan').get() as SqliteRow).n);
  const dueNow = Number(
    (db.prepare('select count(*) as n from plan where next_due_ms <= ?').get(Date.now()) as SqliteRow).n,
  );
  const truncated = Number((db.prepare('select count(*) as n from docs where truncated = 1').get() as SqliteRow).n);
  const kinds = db.prepare('select kind, count(*) as n from docs group by kind').all() as SqliteRow[];
  const compileOptions = db.prepare('select * from pragma_compile_options').all() as SqliteRow[];
  return {
    path,
    exists: existsSync(path),
    size_bytes: existsSync(path) ? statSync(path).size : 0,
    documents,
    indexed_rows: indexed,
    index_matches_docs: documents === indexed,
    links,
    scheduled,
    due_now: dueNow,
    truncated_documents: truncated,
    by_kind: Object.fromEntries(kinds.map((row) => [String(row.kind), Number(row.n)])),
    fts5: compileOptions.some((row) => String(Object.values(row)[0]).includes('ENABLE_FTS5')),
  };
}

/** Rebuild the FTS index from the documents. A write, so it is guarded like one. */
export async function reindex(): Promise<{ documents: number; indexed_rows: number; matched: boolean }> {
  assertWritable('indeksni qayta qurish');
  const db = await openIndex();
  db.prepare("insert into docs_fts(docs_fts) values ('rebuild')").run();
  const documents = Number((db.prepare('select count(*) as n from docs').get() as SqliteRow).n);
  const indexed = Number((db.prepare('select count(*) as n from docs_fts').get() as SqliteRow).n);
  return { documents, indexed_rows: indexed, matched: documents === indexed };
}

export async function forgetDocument(url: string): Promise<{ url: string; removed: boolean }> {
  assertWritable("indeksdan yozuvni o'chirish");
  const db = await openIndex();
  const docs = db.prepare('delete from docs where url = ?').run(url);
  db.prepare('delete from plan where url = ?').run(url);
  db.prepare('delete from links where src = ? or dst = ?').run(url, url);
  return { url, removed: docs.changes > 0 };
}
