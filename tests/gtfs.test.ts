import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import '../src/loader.js';
import { callTool } from '../src/router.js';
import { boundingBox, closeGtfsDb, parseGtfsDate, parseGtfsTime } from '../src/tools/gtfs/_gtfs.js';
import { writeZip } from '../src/tools/zip/_zip.js';

// A GTFS feed built in memory, with the defects a real feed actually has.
//
// The fixture is written with this repository's own zip writer and read back through the same reader the
// tools use, so a passing test means the two agree — not that a third-party library happened to accept it.
// Every deliberate defect is a case the validator claims to catch, so each one is asserted by name.

const dir = mkdtempSync(join(tmpdir(), 'gtfs-test-'));
const DB_PATH = join(dir, 'feeds.sqlite');

function csv(header: string[], rows: string[][]): Buffer {
  const lines = [header.join(','), ...rows.map((r) => r.join(','))];
  return Buffer.from(lines.join('\n') + '\n', 'utf8');
}

const STOPS = csv(
  ['stop_id', 'stop_name', 'stop_lat', 'stop_lon', 'wheelchair_boarding', 'parent_station'],
  [
    ['S1', 'Bosh bekati', '41.31', '69.28', '0', ''],
    ['S2', 'Markaz bekati', '41.32', '69.29', '1', 'S1'],
    ['S3', 'Orugacha bekati', '41.33', '69.30', '7', ''], // 7 is not a legal wheelchair value
    ['S4', 'Yaroqsiz koordinata', '999', '69.31', '0', ''], // out of range: dropped at load
    ['S5', 'Hech kim kelmaydigan beka', '41.34', '69.31', '0', ''],
  ],
);

const ROUTES = csv(
  ['route_id', 'agency_id', 'route_short_name', 'route_long_name', 'route_type'],
  [
    ['R1', 'A1', '1', 'Birinqchi yo‘l', '3'],
    ['R2', 'A1', '', '', '3'], // neither short nor long name
    ['R3', 'A1', '3', 'Uchinqchi yo‘l', '3'], // no trips at all
  ],
);

const TRIPS = csv(
  ['route_id', 'service_id', 'trip_id', 'trip_headsign'],
  [
    ['R1', 'WK', 'T1', 'Bosh bekati'],
    ['R9', 'WK', 'T2', 'Yo‘q yo‘lga havola'], // unknown route
    ['R1', 'NOPE', 'T3', 'Yo‘q service'], // unknown service
  ],
);

const STOP_TIMES = csv(
  ['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence', 'pickup_type', 'drop_off_type'],
  [
    // after-midnight times: 25:10 is 1510 minutes, not 01:10 of the next day
    ['T1', '25:00:00', '25:10:00', 'S1', '1', '', ''],
    ['T1', '25:20:00', '25:20:00', 'S2', '2', '', ''],
    ['T1', '25:15:00', '25:05:00', 'S3', '3', '', ''], // arrival after departure AND earlier than previous stop
    ['T2', '08:00:00', '08:00:00', 'S9', '1', '', ''], // dangling stop
    ['T3', 'not a time', '09:00:00', 'S1', '1', '', ''], // unparsable
  ],
);

const CALENDAR = csv(
  [
    'service_id',
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
    'sunday',
    'start_date',
    'end_date',
  ],
  [
    ['WK', '1', '1', '1', '1', '1', '0', '0', '20260101', '20261231'],
    ['NEVER', '0', '0', '0', '0', '0', '0', '0', '20260101', '20261231'], // runs on no day
    ['BACK', '1', '0', '0', '0', '0', '0', '0', '20261231', '20260101'], // start after end
  ],
);

const AGENCY = csv(['agency_id', 'agency_name', 'agency_timezone'], [['A1', 'Test Transport', 'Asia/Tashkent']]);

const FEED_INFO = csv(['feed_publisher_name', 'feed_lang', 'feed_version'], [['Test', 'uz', '1']]);

const FEED_ZIP = writeZip([
  { name: 'stops.txt', data: STOPS },
  { name: 'routes.txt', data: ROUTES },
  { name: 'trips.txt', data: TRIPS },
  { name: 'stop_times.txt', data: STOP_TIMES },
  { name: 'calendar.txt', data: CALENDAR },
  { name: 'agency.txt', data: AGENCY },
  { name: 'feed_info.txt', data: FEED_INFO },
]);

const FEED_PATH = join(dir, 'test-feed.zip');
writeFileSync(FEED_PATH, FEED_ZIP);

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

afterEach(() => closeGtfsDb());

describe('gtfs time parsing', () => {
  it('keeps after-midnight times as minutes, not as the next morning', () => {
    expect(parseGtfsTime('25:10:00')).toBe(1510);
    expect(parseGtfsTime('30:05:00')).toBe(1805);
    expect(parseGtfsTime('07:05')).toBe(425);
    expect(parseGtfsTime('00:00:00')).toBe(0);
  });

  it('refuses what no feed would write', () => {
    expect(parseGtfsTime('99:00:00')).toBeNull();
    expect(parseGtfsTime('07:65:00')).toBeNull();
    expect(parseGtfsTime('7:5')).toBeNull();
    expect(parseGtfsTime('')).toBeNull();
    expect(parseGtfsTime(undefined)).toBeNull();
  });

  it('parses basic dates only when the digits form one', () => {
    expect(parseGtfsDate('20260131')).toBe('2026-01-31');
    expect(parseGtfsDate('20260230')).toBeNull();
    expect(parseGtfsDate('2026-01-31')).toBeNull();
  });
});

describe('gtfs load, feeds and validate', () => {
  it('reads the archive into the database and reports what it saw', async () => {
    const loaded = payload(await callTool('pro_gtfs_load', { url: FEED_PATH, feed: 'test' }));
    expect(loaded.ok).toBe(true);
    expect(loaded.feed_id).toBe('test');
    expect(loaded.counts.stops).toBe(5);
    expect(loaded.counts.routes).toBe(3);
    expect(loaded.counts.trips).toBe(3);
    expect(loaded.counts.stop_times).toBe(5);
    // The out-of-range coordinate is named, not silently dropped.
    expect(JSON.stringify(loaded.warnings)).toContain('yaroqsiz nuqta');
  });

  it('lists the loaded feed with its counts', async () => {
    const feeds = payload(await callTool('pro_gtfs_feeds', {}));
    expect(feeds.total).toBe(1);
    expect(feeds.feeds[0].feed_id).toBe('test');
    expect(feeds.feeds[0].counts.trips).toBe(3);
  });

  it('names every defect the fixture carries', async () => {
    const result = await callTool('pro_gtfs_validate', { feed: 'test' });
    const report = payload(result);
    expect(Array.isArray(report.findings), textOf(result)).toBe(true);
    const byRule = Object.fromEntries(report.findings.map((f: any) => [f.rule, f.count]));
    const where = JSON.stringify(byRule);
    expect(byRule.trip_route_unknown, where).toBe(1);
    expect(byRule.stop_time_stop_unknown, where).toBe(1);
    expect(byRule.trip_service_unknown, where).toBe(1);
    expect(byRule.route_without_trips, where).toBe(2); // R2 and R3; R1 owns T1 and T3
    expect(byRule.stop_never_visited, where).toBeGreaterThanOrEqual(1);
    expect(byRule.arrival_after_departure, where).toBe(1);
    expect(byRule.sequence_not_increasing, where).toBe(1);
    expect(byRule.time_unparsable, where).toBe(1);
    expect(byRule.service_runs_no_date, where).toBe(1);
    expect(byRule.calendar_start_after_end, where).toBe(1);
    expect(byRule.bad_wheelchair_value, where).toBe(1);
    expect(report.verdict).toBe('errorlar bor');
    expect(report.checked_rules).toBe(15);
  });

  it('finds stops by name and by distance, in metres', async () => {
    const byName = payload(await callTool('pro_gtfs_stops', { feed: 'test', query: 'Markaz' }));
    expect(byName.mode).toBe('name');
    expect(byName.matched).toBe(1);
    expect(byName.stops[0].stop_id).toBe('S2');

    const near = payload(
      await callTool('pro_gtfs_stops', { feed: 'test', near_lat: 41.315, near_lon: 69.285, radius_m: 5000 }),
    );
    expect(near.mode).toBe('radius');
    expect(near.stops.length).toBeGreaterThan(0);
    expect(near.matched).toBe(near.stops.length);
    expect(near.stops[0].distance_m).toBeLessThan(near.stops[near.stops.length - 1].distance_m);
    expect(typeof near.stops[0].distance_m).toBe('number');
    // The candidates are chosen by SQL now: the answer says which box was scanned, so a zero can be
    // told apart from "the centre is in a country the feed does not cover".
    expect(near.box.max_lat).toBeGreaterThan(near.box.min_lat);
    expect(near.box.max_lon).toBeGreaterThan(near.box.min_lon);
    expect(near.scanned).toBeLessThan(100);
  });

  it('draws a box that is slightly too big rather than slightly too small', () => {
    const box = boundingBox(41.315, 69.285, 1000);
    // A degree of latitude is at least 110,574 m, so 1 km must fit inside what the box claims.
    expect(box.maxLat - 41.315).toBeGreaterThanOrEqual(1000 / 111_694);
    // Longitude closes up with latitude, so the same distance is more degrees here than in the north.
    expect(box.maxLon - 69.285).toBeGreaterThan(box.maxLat - 41.315);
    expect(box.wraps).toBe(false);
    expect(boundingBox(0, 0, 1000).minLon).toBeLessThan(-0.008);
  });

  it('admits when a box would run off the map instead of matching nothing', () => {
    // 89.995 N with a 20 km radius: cosine is clamped, and the longitude range leaves the world.
    expect(boundingBox(89.995, 179.99, 20_000).wraps).toBe(true);
  });

  it('refuses to write in read-only mode, and says which switch caused it', async () => {
    process.env.PRO_FETCH_READ_ONLY = 'true';
    try {
      const result = await callTool('pro_gtfs_load', { url: FEED_PATH, feed: 'again' });
      expect(textOf(result)).toMatch(/PRO_FETCH_READ_ONLY/);
    } finally {
      delete process.env.PRO_FETCH_READ_ONLY;
    }
  });

  it('asks which feed when several are loaded, instead of picking one silently', async () => {
    const second = payload(await callTool('pro_gtfs_load', { url: FEED_PATH, feed: 'ikkinchi' }));
    expect(second.ok).toBe(true);
    const ambiguous = await callTool('pro_gtfs_stops', { query: 'Markaz' });
    expect(ambiguous.isError).toBe(true);
    expect(textOf(ambiguous)).toMatch(/bir nechta feed bor/);
  });
});

afterAll(() => {
  closeGtfsDb();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* a temp directory we could not remove is not a test failure */
  }
});
