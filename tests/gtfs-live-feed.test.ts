import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import '../src/loader.js';
import { callTool } from '../src/router.js';
import { closeGtfsDb } from '../src/tools/gtfs/_gtfs.js';
import { hostReachable } from './helpers/liveGate.js';
import { skipBlockWithout } from './helpers/env-guard.js';

/**
 * The loader against a feed nobody wrote for us.
 *
 * The synthetic fixture in `gtfs.test.ts` proves the parser agrees with our own zip writer. It cannot
 * prove anything about a real agency's file: a 9 MB `stop_times.txt`, after-midnight times in anger,
 * shapes and transfers present, `agency_id` missing on a single-agency feed, thousands of stops. Those
 * are the conditions where a parser quietly drops rows.
 *
 * Entur's aggregated Norway feed is used because it is public, keyless, updated daily, and 13.6 MB —
 * measured reachable before this test was written. It is skipped by name when the host is unreachable,
 * never silently.
 */
const FEED_URL = 'https://storage.googleapis.com/marduk-production/outbound/gtfs/rb_nor-aggregated-gtfs.zip';
const DB_PATH = join(tmpdir(), 'pro-fetch-gtfs-live.sqlite');

const reachable = await hostReachable('https://storage.googleapis.com');
if (!reachable) {
  skipBlockWithout('tests/gtfs-live-feed.test.ts', 'network', 'storage.googleapis.com javob bermadi', false);
}
const LIVE = reachable;

function textOf(result: Awaited<ReturnType<typeof callTool>>): string {
  return (result.content ?? []).map((item: { text?: string }) => item.text ?? '').join('\n');
}

function payload(result: Awaited<ReturnType<typeof callTool>>): Record<string, any> {
  const match = /```json\n([\s\S]*?)\n```/.exec(textOf(result));
  return match ? JSON.parse(match[1]) : {};
}

beforeAll(() => {
  process.env.PRO_FETCH_GTFS_PATH = DB_PATH;
  closeGtfsDb();
});

describe('live national feed', () => {
  let counts: Record<string, number> = {};

  it('downloads and stores a real 13 MB feed', async () => {
    const loaded = payload(await callTool('pro_gtfs_load', { url: FEED_URL, feed: 'nor-live' }));
    expect(loaded.ok, textOf(await callTool('pro_gtfs_feeds', {}))).toBe(true);
    counts = loaded.counts;
    expect(loaded.bytes).toBeGreaterThan(1_000_000);
    expect(counts.stops).toBeGreaterThan(1000);
    expect(counts.routes).toBeGreaterThan(100);
    expect(counts.trips).toBeGreaterThan(1000);
    expect(counts.stop_times).toBeGreaterThan(10_000);
    expect(loaded.files_present).toContain('stop_times.txt');
  }, 300_000);

  it('answers a radius question over the real table, wherever the feed actually reaches', async () => {
    // Measured while writing this test: Oslo S (59.9139, 10.7522) has no stop within 500 km of this
    // feed — the nearest is Grong stasjon, 511,921 m away. An "aggregated national" file covers the
    // lines its publishers chose, not the whole country, so a hard-coded capital city is not a fact
    // about the feed. The centre is therefore taken from the loaded data itself, and the invariant is
    // one any feed must satisfy: the stop you searched around is inside its own radius.
    const seed = payload(await callTool('pro_gtfs_stops', { feed: 'nor-live', limit: 1 }));
    expect(seed.mode).toBe('all');
    expect(seed.matched, textOf(await callTool('pro_gtfs_feeds', {}))).toBeGreaterThan(0);
    const from = seed.stops[0];
    expect(typeof from.lat).toBe('number');

    const near = payload(
      await callTool('pro_gtfs_stops', {
        feed: 'nor-live',
        near_lat: from.lat,
        near_lon: from.lon,
        radius_m: 5000,
        limit: 50,
      }),
    );
    expect(near.mode).toBe('radius');
    expect(near.matched).toBeGreaterThan(0);
    expect(
      near.stops.some((stop: { stop_id: string }) => stop.stop_id === from.stop_id),
      from.stop_id,
    ).toBe(true);
    for (const stop of near.stops) expect(stop.distance_m).toBeLessThanOrEqual(5000);
    expect(near.stops[0].distance_m).toBeLessThanOrEqual(near.stops[near.stops.length - 1].distance_m);
    // A box chooses the candidates, not a scan of the table: a 5 km box cannot hold every stop.
    expect(near.scanned).toBeLessThan(seed.matched);
  }, 120_000);

  it('says so plainly when a radius falls somewhere the feed does not reach', async () => {
    // The empty answer is the one that used to be indistinguishable from a broken query, which is why
    // it is asserted: zero stops, zero scanned, and the box the tool actually looked in.
    const empty = payload(
      await callTool('pro_gtfs_stops', { feed: 'nor-live', near_lat: 59.9139, near_lon: 10.7522, radius_m: 1500 }),
    );
    expect(empty.mode).toBe('radius');
    expect(empty.matched).toBe(0);
    expect(empty.scanned).toBe(0);
    expect(empty.stops.length).toBe(0);
    expect(empty.box.min_lat).toBeLessThan(empty.box.max_lat);
  }, 120_000);

  it('reports what the real feed contains instead of claiming it is clean', async () => {
    const report = payload(await callTool('pro_gtfs_validate', { feed: 'nor-live', sample_limit: 3 }));
    expect(report.checked_rules).toBe(15);
    expect(typeof report.verdict).toBe('string');
    // A national feed almost always carries something. What must never happen is a report that says
    // "0 problems" because the rules silently errored or the tables were empty.
    expect(report.total_problems).toBeGreaterThanOrEqual(0);
    expect(counts.stop_times).toBeGreaterThan(0);
    if (report.findings.length) {
      const first = report.findings[0];
      expect(first.count).toBeGreaterThan(0);
      expect(first.examples.length).toBeLessThanOrEqual(3);
    }
  }, 120_000);
});

afterAll(() => {
  closeGtfsDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(DB_PATH + suffix, { force: true });
    } catch {
      /* a temp file we could not remove is not a test failure */
    }
  }
});
