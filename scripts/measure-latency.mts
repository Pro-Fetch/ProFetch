/**
 * Measures the latency of the search paths, so the marketing number and the code are the same number.
 *
 * Run: `npm run measure:latency`
 *
 * Nothing here is a claim about production: it is one machine, one network, a fixed query set, and the
 * percentiles of what those calls actually took. The point is the *shape* — the local index answers in
 * milliseconds and every external engine answers in hundreds of them — because that shape is what decides
 * which latency promise can honestly be made.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PRO_FETCH_PROFILE = 'full';
const base = new URL('../src/', import.meta.url).href;
await import(base + 'env.js');
await import(base + 'loader.js');
const { callTool } = await import(base + 'router.js');
const { indexDocument, searchIndex, closeIndex } = await import(base + 'core/local-index.js');

const dir = await mkdtemp(join(tmpdir(), 'pf-latency-'));
process.env.PRO_FETCH_INDEX_PATH = join(dir, 'index.sqlite');

const QUERIES = ['sqlite wal checkpoint', 'write ahead log truncate', 'pragma wal_checkpoint', 'wal modes restart'];

// Seed the index with real page bodies, then measure against them.
const BODY =
  'Write-Ahead Logging. The WAL lets readers and writers proceed concurrently. ' +
  'Checkpointing moves WAL frames back into the database file and can be requested with PRAGMA wal_checkpoint. ' +
  'Modes are truncate and restart; truncate returns the log to zero bytes.';
for (let i = 0; i < 40; i += 1) {
  await indexDocument({
    url: `https://sqlite.org/wal-${i}.html`,
    site: 'sqlite.org',
    title: `Write-Ahead Logging section ${i}`,
    lang: 'en',
    kind: 'docs',
    body: BODY + ` Additional paragraph ${i} about checkpoint thresholds and fsync behaviour.`,
    links: ['https://sqlite.org/c3ref/wal_checkpoint.html'],
    fetchedAtMs: Date.now(),
  });
}

function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

function line(name: string, ms: number[]): string {
  return (
    `${name.padEnd(34)} n=${String(ms.length).padStart(3)}  ` +
    `p50=${String(percentile(ms, 0.5)).padStart(5)}ms  ` +
    `p95=${String(percentile(ms, 0.95)).padStart(6)}ms  ` +
    `max=${String(Math.max(...ms)).padStart(6)}ms`
  );
}

const indexTimes: number[] = [];
for (let round = 0; round < 40; round += 1) {
  const started = performance.now();
  await searchIndex(QUERIES[round % QUERIES.length], { limit: 10 });
  indexTimes.push(Math.round((performance.now() - started) * 100) / 100);
}

async function toolMs(name: string, args: Record<string, unknown>, rounds: number): Promise<number[]> {
  const out: number[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const started = performance.now();
    await callTool(name, { ...args, query: QUERIES[round % QUERIES.length] });
    out.push(Math.round(performance.now() - started));
  }
  return out;
}

const single = await toolMs('pro_fetch_web_search', { engine: 'hackernews', limit: 5 }, 8);
const chain = await toolMs('pro_fetch_web_search', { limit: 5 }, 6);
const combined = await toolMs('pro_fetch_web_search', { combine: true, limit: 5 }, 5);
const packet = await toolMs(
  'pro_fetch_answer_packet',
  { engine: 'hackernews', sources: 1, max_fragment_chars: 400 },
  4,
);

console.log(line('local index (searchIndex)', indexTimes));
console.log(line('web_search engine=hackernews', single));
console.log(line('web_search chain (fallback)', chain));
console.log(line('web_search combine=true (12 engines)', combined));
console.log(line('answer_packet (1 source)', packet));
console.log(
  '\nBitta mashina, bitta tarmoq. Foiz — server tomonidan kechikish; tarmoq va provider javob berish ' +
    'vaqti unga kiradi.',
);

closeIndex();
await rm(dir, { recursive: true, force: true });
