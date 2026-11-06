import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import '../src/loader.js';
import { callTool } from '../src/router.js';
import { closeIndex, ftsQuery } from '../src/core/local-index.js';
import { skipBlockWithout } from './helpers/env-guard.js';
import type { ToolResult } from '../src/core/types.js';

/**
 * The local index: what this installation has read, searchable in a millisecond.
 *
 * The suite runs against a temporary database file, never against `~/.pro-fetch/index.sqlite`: a test that
 * writes into the operator's real index would leave documents there and make the next search answer
 * differently for reasons that have nothing to do with the code under test.
 *
 * `better-sqlite3` is an optional dependency, so the block declares its absence rather than failing on it
 * — the server is designed to degrade without it, and a red build on a machine that has nothing wrong with
 * its code is a test of the machine.
 */

const FILE = 'tests/local-index.test.ts';

async function driverPresent(): Promise<boolean> {
  try {
    const specifier = 'better-sqlite3';
    await import(specifier);
    return true;
  } catch {
    return false;
  }
}

const available = await driverPresent();
if (!available) skipBlockWithout(FILE, 'better-sqlite3', 'optional dependency not installed', false);

let dir = '';
function textOf(result: ToolResult): string {
  return (result.content ?? [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text ?? '')
    .join('\n');
}
function payload(result: ToolResult): Record<string, any> {
  const match = /(\{[\s\S]*\})/.exec(textOf(result));
  return match ? JSON.parse(match[1]) : {};
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pf-index-'));
  process.env.PRO_FETCH_INDEX_PATH = join(dir, 'index.sqlite');
});

afterAll(async () => {
  closeIndex();
  delete process.env.PRO_FETCH_INDEX_PATH;
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('the query is turned into FTS5 syntax, not passed through', () => {
  it('quotes every term and prefixes only the last', () => {
    // `"log"*` is the form FTS5 accepts: the star belongs outside the quoted phrase.
    expect(ftsQuery('write ahead log')).toBe('"write" AND "ahead" AND "log"*');
  });

  it('runs a hostile query as a query, not as syntax', async () => {
    // FTS5 treats `"`, `*`, `(`, `)`, `-` and AND/OR/NEAR as syntax. The risk is not the quote character in
    // the built string — quoting every term is the design — it is a MATCH that throws, or one that quietly
    // becomes a column filter and answers "nothing". So the test is the run itself.
    const built = ftsQuery('C++ "quoted" (paren) -minus near(a OR b)');
    expect(built.split(' AND ').length).toBeGreaterThan(2);
    const result = await callTool('pro_index_search', { query: 'C++ "quoted" (paren) -minus near(a OR b)' });
    expect(result.isError, textOf(result)).toBeFalsy();
    expect(payload(result).count).toBe(0);
  });

  it('returns an empty expression for a query with no usable term', () => {
    expect(ftsQuery('  ')).toBe('');
    expect(ftsQuery('a b')).toBe('');
  });
});

describe.skipIf(!available)('the index stores, finds and forgets', () => {
  it('indexes a provided document and finds it by a word inside the body', async () => {
    const put = payload(
      await callTool('pro_index_put', {
        url: 'https://sqlite.org/wal.html',
        title: 'Write-Ahead Logging',
        content:
          'The write-ahead log allows readers and writers to operate concurrently. Checkpointing moves WAL frames back into the database file.',
        lang: 'en',
        kind: 'docs',
        links: ['https://sqlite.org/c3ref/wal_checkpoint.html'],
      }),
    );
    expect(put.ok).toBe(true);
    expect(put.words).toBeGreaterThan(10);
    expect(put.truncated).toBe(false);

    const found = payload(await callTool('pro_index_search', { query: 'checkpoint frames', limit: 5 }));
    expect(found.count).toBeGreaterThan(0);
    expect(found.results[0].url).toBe('https://sqlite.org/wal.html');
    // The millisecond claim is on the same line as the claim.
    expect(found.took_ms).toBeLessThan(250);
    expect(found.results[0].snippet).toMatch(/checkpoint/i);
    expect(found.results[0].age_hours).toBeLessThan(1);
  });

  it('counts a re-read as unchanged, and a changed body as a change', async () => {
    const args = {
      url: 'https://example.com/news/one',
      title: 'Daily',
      lang: 'en',
      kind: 'news',
    };
    await callTool('pro_index_put', { ...args, content: 'first version of the story about the reservoir' });
    const again = payload(
      await callTool('pro_index_put', { ...args, content: 'first version of the story about the reservoir' }),
    );
    expect(again.changed).toBe(false);
    const edited = payload(
      await callTool('pro_index_put', { ...args, content: 'second version: the reservoir level rose' }),
    );
    expect(edited.changed).toBe(true);
    // news is planned hourly, and the answer says when the next look is due.
    expect(edited.next_due_ms - Date.now()).toBeGreaterThan(50 * 60_000);
    expect(edited.next_due_ms - Date.now()).toBeLessThanOrEqual(60 * 60_000);
  });

  it('shortens the interval for a page that keeps changing, and never below an hour', async () => {
    const args = { url: 'https://example.com/blog/live', title: 'Live blog', lang: 'en', kind: 'page' };
    let nextDue = 0;
    for (let visit = 0; visit < 6; visit += 1) {
      const res = payload(await callTool('pro_index_put', { ...args, content: `revision ${visit} of the live blog` }));
      nextDue = res.next_due_ms;
    }
    // A weekly page that changed on every visit is not a weekly page; the floor is one hour, because
    // below that the plan is polling and not politeness.
    const interval = nextDue - Date.now();
    expect(interval).toBeGreaterThan(55 * 60_000);
    expect(interval).toBeLessThanOrEqual(60 * 60_000);
  });

  it('reports its own consistency, and repairs it when asked', async () => {
    const stats = payload(await callTool('pro_index_stats', {}));
    expect(stats.ok).toBe(true);
    expect(stats.fts5).toBe(true);
    expect(stats.documents).toBeGreaterThanOrEqual(2);
    expect(stats.index_matches_docs, JSON.stringify(stats)).toBe(true);
    expect(stats.scheduled).toBeGreaterThanOrEqual(2);
    expect(stats.path).toContain('index.sqlite');

    const rebuilt = payload(await callTool('pro_index_rebuild', {}));
    expect(rebuilt.matched).toBe(true);
    expect(rebuilt.documents).toBe(stats.documents);
  });

  it('builds authority from the links it was given, not from a web-wide graph', async () => {
    await callTool('pro_index_put', {
      url: 'https://a.test/1',
      content: 'we cite the sqlite docs here https://sqlite.org/wal.html',
      links: ['https://sqlite.org/wal.html'],
    });
    await callTool('pro_index_put', {
      url: 'https://b.test/2',
      content: 'also citing https://sqlite.org/wal.html for the checkpoint behaviour',
      links: ['https://sqlite.org/wal.html'],
    });
    const authority = payload(await callTool('pro_index_authority', { limit: 10 }));
    expect(authority.ok).toBe(true);
    const sqlite = authority.sites.find((row: any) => row.site === 'sqlite.org');
    expect(sqlite.inbound).toBeGreaterThanOrEqual(2);
    // Two links from two different sites is two votes; the basis line says what the count is built from.
    expect(sqlite.from_distinct_sites).toBeGreaterThanOrEqual(2);
    expect(String(authority.basis)).toMatch(/own crawl graph/);
  });

  it('lists what is due, and says plainly that it does not run a background job', async () => {
    const due = payload(await callTool('pro_crawl_plan_due', { limit: 20 }));
    expect(due.ok).toBe(true);
    expect(due.scheduled).toBeGreaterThanOrEqual(2);
    expect(String(due.how_to_use)).toMatch(/fon jarayon/i);
    // Nothing has aged past its interval yet, so the queue is empty and says why in measured terms.
    if (due.due_now === 0) expect(String(due.note ?? '') + JSON.stringify(due)).toMatch(/muddati yetmagan/);
  });

  it('forgets a document, its edges and its schedule entry', async () => {
    const forgotten = payload(await callTool('pro_index_forget', { url: 'https://sqlite.org/wal.html' }));
    expect(forgotten.removed).toBe(true);
    const search = payload(await callTool('pro_index_search', { query: 'checkpoint frames', limit: 5 }));
    expect(search.results.findIndex((row: any) => row.url === 'https://sqlite.org/wal.html')).toBe(-1);
    const again = payload(await callTool('pro_index_forget', { url: 'https://sqlite.org/wal.html' }));
    expect(again.removed).toBe(false);
    expect(String(again.note)).toMatch(/topilmadi/);
  });

  it('refuses an empty body instead of storing a document that can never match', async () => {
    // The central validator catches this before the handler does — measured, the message is the guard's,
    // not the tool's. Asserted here so the behaviour is pinned whichever layer answers.
    const result = await callTool('pro_index_put', { url: 'https://x.test/empty', content: '   ' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/majburiy argumentlar|content bo‘sh/);
  });
});
