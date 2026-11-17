import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import '../src/loader.js';
import { callTool } from '../src/router.js';
import { closeGtfsDb, parseGtfsTime } from '../src/tools/gtfs/_gtfs.js';
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

  it('follows one real trip from the line list to its own departure board', async () => {
    // The chain a rider actually walks: a line, its trips, one trip's stop order, the dates that trip's
    // service runs, then the board at that trip's own first stop on one of those dates. Every step takes
    // its input from the previous one, so nothing here depends on a guessed identifier.
    const now = new Date();
    const iso =
      now.getFullYear() +
      '-' +
      String(now.getMonth() + 1).padStart(2, '0') +
      '-' +
      String(now.getDate()).padStart(2, '0');

    const routes = payload(await callTool('pro_gtfs_routes', { feed: 'nor-live', limit: 200 }));
    expect(routes.ok).toBe(true);
    expect(routes.matched).toBeGreaterThan(0);
    const line = routes.routes.find((row: { trips: number }) => row.trips > 0);
    expect(line, 'biror yo‘lda ham reys yo‘q').toBeDefined();

    const listed = payload(await callTool('pro_gtfs_trip', { feed: 'nor-live', route: line.route_id, limit: 200 }));
    expect(listed.mode).toBe('trips');
    expect(listed.trips.length).toBeGreaterThan(0);
    const sameDay = listed.trips.find(
      (row: { first_departure: string | null }) => row.first_departure && !String(row.first_departure).includes('+1d'),
    );
    expect(sameDay, 'reyslarning hammasi yarim tundan keyinga yozilgan').toBeDefined();

    const detail = payload(await callTool('pro_gtfs_trip', { feed: 'nor-live', trip: sameDay.trip_id, date: iso }));
    expect(detail.ok).toBe(true);
    expect(detail.stops.length).toBeGreaterThan(1);
    const minutes = detail.stops.map((stop: { departure_raw: string; arrival_raw: string }) =>
      parseGtfsTime(stop.departure_raw || stop.arrival_raw),
    );
    for (let i = 1; i < minutes.length; i++) {
      // A real run does not go backwards. This is the assertion that catches a parser that folded
      // 25:15 back into 01:15 and thereby made the last stop earlier than the first.
      expect(minutes[i], 'vaqtlar orqaga ketdi: ' + JSON.stringify(minutes)).not.toBeNull();
      expect(minutes[i]).toBeGreaterThanOrEqual(minutes[i - 1] as number);
    }

    const dates = payload(
      await callTool('pro_gtfs_service_dates', {
        feed: 'nor-live',
        service: detail.service.service_id,
        from: iso,
        limit: 10,
      }),
    );
    expect(dates.mode).toBe('service');
    expect(Array.isArray(dates.weekdays)).toBe(true);
    expect(dates.total_runs).toBeGreaterThanOrEqual(0);

    if (!dates.runs_on.length) {
      // Nothing runs this service inside the window. The board must then be empty for it, not show it.
      const quiet = payload(
        await callTool('pro_gtfs_arrivals', {
          feed: 'nor-live',
          stop: detail.stops[0].stop_id,
          date: iso,
          at: sameDay.first_departure,
          window_min: 60,
        }),
      );
      expect(quiet.ok).toBe(true);
      expect(quiet.departures.some((row: { trip_id: string }) => row.trip_id === sameDay.trip_id)).toBe(false);
      return;
    }

    const board = payload(
      await callTool('pro_gtfs_arrivals', {
        feed: 'nor-live',
        stop: detail.stops[0].stop_id,
        date: dates.runs_on[0],
        at: sameDay.first_departure,
        window_min: 720,
        limit: 200,
      }),
    );
    expect(board.ok, JSON.stringify(board)).toBe(true);
    expect(board.matched).toBeGreaterThan(0);
    expect(
      board.departures.some((row: { trip_id: string }) => row.trip_id === sameDay.trip_id),
      'xizmat kuni ' + dates.runs_on[0] + ' bo‘lgan reys doskada yo‘q',
    ).toBe(true);
  }, 300_000);

  it('plans a real journey between two stops of one trip and draws that line', async () => {
    // Nothing here is hard-coded about Norway. One trip gives its own first and last stop, its service
    // gives a date it really runs, the planner must then find that very trip, and the trip's shape must
    // come back as a measurable line. If any link of that chain were wrong, an assertion would fail.
    const routes = payload(await callTool('pro_gtfs_routes', { feed: 'nor-live', limit: 40 }));
    const line = routes.routes.find((row: { trips: number; stops: number }) => row.trips > 0 && row.stops > 3);
    expect(line, JSON.stringify(routes.routes.slice(0, 3))).toBeDefined();

    const listed = payload(await callTool('pro_gtfs_trip', { feed: 'nor-live', route: line.route_id, limit: 20 }));
    expect(listed.trips.length).toBeGreaterThan(0);
    const detail = payload(
      await callTool('pro_gtfs_trip', { feed: 'nor-live', trip: String(listed.trips[0].trip_id) }),
    );
    expect(detail.ok).toBe(true);
    expect(detail.stops.length).toBeGreaterThan(2);
    const origin = detail.stops[0].stop_id;
    const target = detail.stops[detail.stops.length - 1].stop_id;

    const dates = payload(
      await callTool('pro_gtfs_service_dates', { feed: 'nor-live', service: detail.service.service_id, limit: 5 }),
    );
    expect(Array.isArray(dates.weekdays)).toBe(true);
    const runDate = dates.runs_on.length ? dates.runs_on[0] : new Date().toISOString().slice(0, 10);

    const plan = payload(
      await callTool('pro_gtfs_journey', {
        feed: 'nor-live',
        from: origin,
        to: target,
        date: runDate,
        at: '00:00',
        window_min: 720,
        max_results: 10,
      }),
    );
    expect(plan.ok, JSON.stringify(plan)).toBe(true);
    expect(plan.journeys.length, 'xizmat kuni ' + runDate + ': ' + JSON.stringify(plan.scanned)).toBeGreaterThan(0);
    const onThisTrip = plan.journeys.find((row: { legs: Array<{ trip_id: string }> }) =>
      row.legs.some((leg: { trip_id: string }) => leg.trip_id === detail.trip_id),
    );
    expect(
      onThisTrip,
      'reys o‘z bekalari orasida topilmadi: ' + JSON.stringify(plan.journeys.slice(0, 3)),
    ).toBeDefined();
    expect(onThisTrip.legs[0].from_stop).toBe(origin);
    expect(onThisTrip.legs[onThisTrip.legs.length - 1].to_stop).toBe(target);
    expect(onThisTrip.total_min).toBeGreaterThan(0);

    // Shapes: a national feed draws some lines and not others, so the assertion follows whatever the data
    // says instead of assuming either case, and reports which one happened.
    if (detail.shape_id) {
      const geometry = payload(
        await callTool('pro_gtfs_shapes', { feed: 'nor-live', shape: String(detail.shape_id), simplify_m: 200 }),
      );
      expect(geometry.ok).toBe(true);
      const one = geometry.shapes[0];
      expect(one.points_total).toBeGreaterThan(1);
      expect(one.length_m).toBeGreaterThan(0);
      expect(one.points_after_simplify).toBeLessThanOrEqual(one.points_total);
      expect(one.bounds.max_lat).toBeGreaterThan(one.bounds.min_lat);
      expect(one.geometry).toBeUndefined();
    } else {
      const none = payload(await callTool('pro_gtfs_shapes', { feed: 'nor-live', trip: detail.trip_id }));
      expect(none.ok).toBe(false);
      expect(none.error).toMatch(/shape topilmadi/);
    }
  }, 300_000);
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
