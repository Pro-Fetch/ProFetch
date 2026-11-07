/**
 * The persistent crawl queue: what is owed, what is claimed, what turned out to be the same document.
 *
 * Every case runs against a temporary database file, never against the operator's real queue — a test that
 * wrote into `~/.pro-fetch/crawl-queue.sqlite` would change what the next crawl does for reasons that have
 * nothing to do with the code under test.
 *
 * `better-sqlite3` is an optional dependency, so the block declares its absence instead of failing on it.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import '../src/loader.js';
import { callTool } from '../src/router.js';
import { closeQueue, markResult, parseQueueUrl } from '../src/core/crawl-queue.js';
import { skipBlockWithout } from './helpers/env-guard.js';
import type { ToolResult } from '../src/core/types.js';

const FILE = 'tests/crawl-queue.test.ts';

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
  const match = /```json\n([\s\S]*?)\n```/.exec(textOf(result));
  return JSON.parse(match ? match[1] : textOf(result));
}

/** The write half and the read half are separate tools so read-only mode can keep one and refuse the other. */
async function job(input: Record<string, unknown>): Promise<ToolResult> {
  return callTool('pro_fetch_crawl_job', input);
}
async function status(input: Record<string, unknown>): Promise<ToolResult> {
  return callTool('pro_fetch_crawl_job_status', input);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'procrawl-'));
  process.env.PRO_FETCH_CRAWL_DB = join(dir, 'queue.sqlite');
});

afterEach(() => {
  delete process.env.PRO_FETCH_READ_ONLY;
});

afterAll(async () => {
  closeQueue();
  delete process.env.PRO_FETCH_CRAWL_DB;
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('the queue file is not the operator’s own', () => {
  it('points at the temporary database the suite set', async () => {
    const body = payload(await status({}));
    expect(body.file).toBe(join(dir, 'queue.sqlite'));
    expect(body.file).not.toContain('.pro-fetch');
    expect(typeof body.exists).toBe('boolean');
  });
});

describe('enqueue', () => {
  it('counts what it added, what it already had, and what it refused', async () => {
    const body = payload(
      await job({
        action: 'enqueue',
        urls: [
          'https://example.org/a',
          'https://example.org/a',
          'https://example.org/b?x=1',
          'ftp://example.org/c',
          'not a url',
        ],
        depth: 1,
        source_url: 'https://example.org/index',
      }),
    );
    expect(body.added).toBe(2);
    expect(body.already_queued).toBe(1);
    expect(body.rejected_scheme).toBe(1);
    expect(body.invalid).toBe(1);
    expect(body.queue.by_state.pending).toBeGreaterThanOrEqual(2);
    expect(body.queue.by_depth['1']).toBeGreaterThanOrEqual(2);
  });

  it('refuses an empty list instead of reporting success', async () => {
    const result = await job({ action: 'enqueue', urls: [] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('urls');
  });

  it('classifies an address without parsing it into anything', () => {
    expect(parseQueueUrl('https://example.org/x')).toEqual({ url: 'https://example.org/x', host: 'example.org' });
    expect(parseQueueUrl('ftp://example.org')).toEqual({ url: '', host: '' });
    expect(parseQueueUrl('')).toBeNull();
    expect(parseQueueUrl(42 as unknown as string)).toBeNull();
  });
});

describe('claims', () => {
  it('hands out a row as claimed work, not as work still pending', async () => {
    await job({ action: 'enqueue', urls: ['https://claim.example/one'] });
    const first = payload(await job({ action: 'next', limit: 50 }));
    const claimed = first.rows.filter((row: any) => row.url === 'https://claim.example/one');
    expect(claimed).toHaveLength(1);
    expect(claimed[0].state).toBe('fetching');
    expect(typeof claimed[0].attempted_at).toBe('number');
    const again = payload(await job({ action: 'next', limit: 50 }));
    expect(again.rows.some((row: any) => row.url === 'https://claim.example/one')).toBe(false);
  });

  it('gives a crashed worker’s page back after its claim ages out', async () => {
    await job({ action: 'enqueue', urls: ['https://stale.example/page'] });
    const claimed = payload(await job({ action: 'next', limit: 50 }));
    expect(claimed.rows.some((row: any) => row.url === 'https://stale.example/page')).toBe(true);
    // The floor on the reclaim window is one second; this waits past it rather than pretending it is zero.
    await new Promise((done) => setTimeout(done, 1200));
    const reclaimed = payload(await job({ action: 'reclaim', older_than_ms: 1000 }));
    expect(reclaimed.reclaimed).toBeGreaterThan(0);
    const listed = payload(await status({ state: 'pending', limit: 50 }));
    expect(listed.rows.some((row: any) => row.url === 'https://stale.example/page')).toBe(true);
  });

  it('names an unknown state instead of returning an empty list', async () => {
    const result = await status({ state: 'finished' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('yaroqsiz holat');
  });

  it('refuses an unknown action and points at the tool that can do it', async () => {
    const result = await job({ action: 'purge' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('pro_fetch_crawl_job_status');
    const wrong = await status({ state: 'queued' });
    expect(wrong.isError).toBe(true);
    expect(textOf(wrong)).toContain('yaroqsiz holat');
  });
});

describe('results and content dedupe', () => {
  it('marks a read done, then recognises the same document at another address', async () => {
    await job({ action: 'enqueue', urls: ['https://dup.example/original', 'https://dup.example/copy'] });
    const first = payload(
      await job({ action: 'mark', url: 'https://dup.example/original', document_id: 'aaaa1111bbbb2222' }),
    );
    expect(first.state).toBe('done');
    expect(first.first_url).toBeNull();

    const second = payload(
      await job({ action: 'mark', url: 'https://dup.example/copy', document_id: 'aaaa1111bbbb2222' }),
    );
    expect(second.state).toBe('skipped_duplicate');
    // The pointer is the whole point: the copy says where the content was first read.
    expect(second.first_url).toBe('https://dup.example/original');

    const stats = payload(await status({})).queue;
    expect(stats.duplicate_documents).toBeGreaterThanOrEqual(1);
    expect(stats.duplicate_rate).toBeGreaterThan(0);
    expect(stats.distinct_documents).toBeGreaterThanOrEqual(1);
  });

  it('keeps a failure with its reason rather than calling it done', async () => {
    await job({ action: 'enqueue', urls: ['https://dead.example/404'] });
    const marked = payload(await job({ action: 'mark', url: 'https://dead.example/404', error: 'HTTP 404 Not Found' }));
    expect(marked.state).toBe('failed');
    const rows = payload(await status({ state: 'failed', limit: 50 })).rows;
    const row = rows.find((candidate: any) => candidate.url === 'https://dead.example/404');
    expect(row.error).toBe('HTTP 404 Not Found');
  });

  it('refuses to mark a page with no address, instead of inventing a row', async () => {
    const result = await job({ action: 'mark', url: '   ', document_id: 'cccc3333' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('url');
    // And the core function, reached directly, reports the same thing without writing anything.
    expect(await markResult('   ', { document_id: 'cccc3333' })).toEqual({ state: 'failed', first_url: null });
  });
});

describe('read-only mode reaches the queue too', () => {
  it('refuses to hand out work it cannot let anyone finish, and still answers questions', async () => {
    process.env.PRO_FETCH_READ_ONLY = 'true';
    const enqueue = await job({ action: 'enqueue', urls: ['https://ro.example/x'] });
    expect(enqueue.isError, textOf(enqueue)).toBe(true);
    const next = await job({ action: 'next', limit: 1 });
    expect(next.isError, textOf(next)).toBe(true);
    // The read half exists precisely so an operator in read-only mode can still see what is owed.
    const stats = await status({});
    expect(stats.isError, textOf(stats)).toBeUndefined();
    expect(payload(stats).queue.total).toBeGreaterThanOrEqual(0);
    const path = await status({});
    expect(path.isError).toBeUndefined();
  });
});
