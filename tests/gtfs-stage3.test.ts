import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import '../src/loader.js';
import { callTool } from '../src/router.js';
import { closeGtfsDb } from '../src/tools/gtfs/_gtfs.js';
import {
  distCheck,
  pathLengthMeters,
  perpendicularMeters,
  shapeBounds,
  simplifyShape,
  type ShapePoint,
} from '../src/tools/gtfs/_shapes.js';
import { writeZip } from '../src/tools/zip/_zip.js';

/**
 * Stage 3: headway-driven service, transfers, drawn paths and a journey with one change.
 *
 * The fixture is built so every claim the planner makes can be checked against a number a person wrote
 * on purpose: an 08:10 direct ride, a 20-minute wait at D, an 8-minute walk D→E from `transfers.txt`, a
 * transfer the feed forbids (B→E, type 3), and a bus that runs every 10 minutes rather than at clocks.
 *
 * March 2026: the 5th is a Thursday (WK runs), the 8th a Sunday (SAT runs). The night ride N1 leaves
 * Saturday 23:50 and arrives 25:10 — one hour ten of Sunday morning.
 */

const dir = mkdtempSync(join(tmpdir(), 'gtfs-stage3-'));
const DB_PATH = join(dir, 'stage3.sqlite');

function csv(header: string[], rows: string[][]): Buffer {
  const lines = [header.join(','), ...rows.map((row) => row.join(','))];
  return Buffer.from(lines.join('\n') + '\n', 'utf8');
}

const STOPS = csv(
  ['stop_id', 'stop_name', 'stop_lat', 'stop_lon'],
  [
    ['A', 'Alice', '41.300', '69.300'],
    ['B', 'Bob', '41.310', '69.300'],
    ['C', 'Carol', '41.320', '69.300'],
    ['D', 'Dave', '41.310', '69.310'],
    ['E', 'Eve', '41.315', '69.320'],
  ],
);

const ROUTES = csv(
  ['route_id', 'agency_id', 'route_short_name', 'route_long_name', 'route_type'],
  [
    ['L1', 'A1', '1', 'Togri', '3'],
    ['L2', 'A1', '2', 'Oraliq', '3'],
    ['L3', 'A1', '3', 'Yurish', '3'],
    ['L4', 'A1', '4', 'Har 10 daqiqa', '3'],
    ['L5', 'A1', '5', 'Tungi', '2'],
  ],
);

const TRIPS = csv(
  ['route_id', 'service_id', 'trip_id', 'trip_headsign', 'shape_id'],
  [
    ['L1', 'WK', 'F1', 'Carol', ''],
    ['L1', 'WK', 'F2', 'Carol', 'SP1'],
    ['L2', 'WK', 'G1', 'Carol', ''],
    ['L3', 'WK', 'H1', 'Carol', ''],
    ['L4', 'WK', 'Q1', 'Bob', ''],
    ['L5', 'SAT', 'N1', 'Carol', ''],
    ['L1', 'WK', 'P1', 'Bob', ''],
    ['L3', 'WK', 'H2', 'Carol', ''],
  ],
);

const STOP_TIMES = csv(
  ['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence'],
  [
    ['F1', '', '08:00:00', 'A', '1'],
    ['F1', '08:20:00', '08:20:00', 'B', '2'],
    ['F1', '08:40:00', '08:40:00', 'D', '3'],
    ['F2', '', '08:10:00', 'A', '1'],
    ['F2', '09:10:00', '', 'C', '2'],
    ['G1', '', '09:00:00', 'D', '1'],
    ['G1', '09:30:00', '', 'C', '2'],
    ['H1', '', '08:55:00', 'E', '1'],
    ['H1', '09:40:00', '', 'C', '2'],
    ['Q1', '', '08:00:00', 'A', '1'],
    ['Q1', '08:15:00', '08:15:00', 'B', '2'],
    ['N1', '', '23:50:00', 'A', '1'],
    ['N1', '25:10:00', '', 'C', '2'],
    ['P1', '', '09:00:00', 'A', '1'],
    ['P1', '09:20:00', '09:20:00', 'B', '2'],
    ['H2', '', '09:30:00', 'E', '1'],
    ['H2', '10:00:00', '', 'C', '2'],
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
    ['SAT', '0', '0', '0', '0', '0', '1', '0', '20260101', '20261231'],
  ],
);

// Q1 is not a timed run: a bus every 10 minutes from 08:00 to 09:00 at the origin.
const FREQUENCIES = csv(
  ['trip_id', 'start_time', 'end_time', 'headway_secs', 'exact_times'],
  [['Q1', '08:00:00', '09:00:00', '600', '0']],
);

const TRANSFERS = csv(
  ['from_stop_id', 'to_stop_id', 'transfer_type', 'min_transfer_time'],
  [
    ['D', 'E', '2', '480'],
    ['B', 'E', '3', ''],
  ],
);

// A five point path from A to C that bows 0.004 degrees east at the middle — about 355 m of detour.
const SHAPES = csv(
  ['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence', 'shape_dist_traveled'],
  [
    ['SP1', '41.300', '69.300', '1', '0'],
    ['SP1', '41.305', '69.300', '2', '500'],
    ['SP1', '41.310', '69.304', '3', '1000'],
    ['SP1', '41.315', '69.300', '4', '1600'],
    ['SP1', '41.320', '69.300', '5', '2200'],
  ],
);

const AGENCY = csv(['agency_id', 'agency_name', 'agency_timezone'], [['A1', 'Stage3 Transit', 'Asia/Tashkent']]);

const FEED_PATH = join(dir, 'stage3.zip');
writeFileSync(
  FEED_PATH,
  writeZip([
    { name: 'stops.txt', data: STOPS },
    { name: 'routes.txt', data: ROUTES },
    { name: 'trips.txt', data: TRIPS },
    { name: 'stop_times.txt', data: STOP_TIMES },
    { name: 'calendar.txt', data: CALENDAR },
    { name: 'frequencies.txt', data: FREQUENCIES },
    { name: 'transfers.txt', data: TRANSFERS },
    { name: 'shapes.txt', data: SHAPES },
    { name: 'agency.txt', data: AGENCY },
  ]),
);

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

afterAll(() => {
  closeGtfsDb();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* a temp directory we could not remove is not a test failure */
  }
});

describe('stage 3 fixture', () => {
  it('loads headways, transfers and shapes with measured counts', async () => {
    const loaded = payload(await callTool('pro_gtfs_load', { url: FEED_PATH, feed: 'stage3' }));
    expect(loaded.ok, JSON.stringify(loaded.warnings)).toBe(true);
    expect(loaded.counts.frequencies).toBe(1);
    expect(loaded.counts.transfers).toBe(2);
    expect(loaded.counts.shapes).toBe(5);
    expect(loaded.counts.stops).toBe(5);
  });

  it('puts headway departures on the board instead of hiding them', async () => {
    const board = payload(
      await callTool('pro_gtfs_arrivals', {
        feed: 'stage3',
        stop: 'B',
        date: '2026-03-05',
        at: '08:00',
        window_min: 90,
        limit: 50,
      }),
    );
    expect(board.ok).toBe(true);
    // Q1's representative run reaches B at 08:15; a bus every 10 minutes from 08:00 to 09:00 therefore
    // passes B from 08:15 to 09:15 — all seven of those fall inside a 90 minute window from 08:00.
    const generated = board.departures.filter((row: { generated: boolean }) => row.generated);
    expect(generated.length).toBe(7);
    expect(generated[0].departure).toBe('08:15');
    expect(generated[0].headway_min).toBe(10);
    expect(board.scanned.frequency_generated).toBe(7);
    // The timed ride is still there beside them.
    expect(board.departures.some((row: { trip_id: string }) => row.trip_id === 'F1')).toBe(true);
  });

  it('does not invent a headway departure past the block end', async () => {
    const late = payload(
      await callTool('pro_gtfs_arrivals', {
        feed: 'stage3',
        stop: 'B',
        date: '2026-03-05',
        at: '09:10',
        window_min: 60,
        limit: 50,
      }),
    );
    const generated = late.departures.filter((row: { generated: boolean }) => row.generated);
    expect(generated.length).toBe(1);
    expect(generated[0].departure).toBe('09:15');
  });

  it('plans a direct ride and a one-change ride, and prefers the earliest arrival', async () => {
    const plan = payload(
      await callTool('pro_gtfs_journey', {
        feed: 'stage3',
        from: 'A',
        to: 'C',
        date: '2026-03-05',
        at: '08:00',
        window_min: 30,
      }),
    );
    expect(plan.ok).toBe(true);
    expect(plan.matched).toBeGreaterThanOrEqual(2);
    // 08:10 direct arrives 09:10; the connection through D arrives 09:30.
    expect(plan.journeys[0].changes).toBe(0);
    expect(plan.journeys[0].arrive).toBe('09:10');
    const change = plan.journeys.find(
      (row: { legs: Array<{ trip_id: string }> }) => row.legs[0]?.trip_id === 'F1' && row.legs[1]?.trip_id === 'G1',
    );
    expect(change, JSON.stringify(plan.journeys)).toBeDefined();
    expect(change.legs[1].from_stop).toBe('D');
    expect(change.legs[1].trip_id).toBe('G1');
    expect(change.transfer_wait_min).toBe(20);
    expect(change.walk_min).toBe(0);
    expect(change.walk_source).toBe('none');
    expect(change.legs[0].board).toBe('08:00');
  });

  it('uses the feed’s own walking time for a transfer between two stops', async () => {
    const plan = payload(
      await callTool('pro_gtfs_journey', {
        feed: 'stage3',
        from: 'A',
        to: 'C',
        date: '2026-03-05',
        at: '08:00',
        window_min: 30,
        max_results: 20,
      }),
    );
    const walk = plan.journeys.find(
      (row: { legs: Array<{ trip_id: string }> }) => row.legs[0]?.trip_id === 'F1' && row.legs[1]?.trip_id === 'H1',
    );
    expect(walk, JSON.stringify(plan.journeys)).toBeDefined();
    // D→E is declared as type 2 with 480 seconds: eight minutes of walking, and the connection only works
    // because F1 reaches D at 08:40 and H1 leaves E at 08:55.
    expect(walk.walk_min).toBe(8);
    expect(walk.walk_source).toBe('transfers.txt');
    expect(walk.legs[0].to_stop).toBe('D');
    expect(walk.legs[1].from_stop).toBe('E');
    // 08:40 + 8 min of walking + the 1 minute connection margin: the 08:55 ride is just catchable.
    expect(walk.transfer_wait_min).toBe(15);
  });

  it('refuses a transfer the feed says cannot be made', async () => {
    const plan = payload(
      await callTool('pro_gtfs_journey', {
        feed: 'stage3',
        from: 'A',
        to: 'C',
        date: '2026-03-05',
        at: '09:00',
        window_min: 20,
      }),
    );
    // P1 reaches B at 09:20 and H2 leaves E at 09:30, so a naive planner would connect them. The feed
    // declares B→E as transfer_type 3 — impossible — and that has to be honoured.
    expect(
      plan.journeys.some((row: { legs: Array<{ from_stop: string }> }) =>
        row.legs.some((leg: { from_stop: string }) => leg.from_stop === 'E'),
      ),
    ).toBe(false);
  });

  it('searches backwards when the rider named an arrival deadline', async () => {
    const by = payload(
      await callTool('pro_gtfs_journey', {
        feed: 'stage3',
        from: 'A',
        to: 'C',
        date: '2026-03-05',
        arrive_by: '09:20',
        window_min: 120,
      }),
    );
    expect(by.search.arrive_by).toBe('09:20');
    expect(by.journeys.length).toBeGreaterThan(0);
    for (const journey of by.journeys) expect(journey.arrive <= '09:20').toBe(true);
    expect(by.journeys[0].arrive).toBe('09:10');
  });

  it('plans the sleeper that leaves before midnight and arrives after it', async () => {
    const plan = payload(
      await callTool('pro_gtfs_journey', {
        feed: 'stage3',
        from: 'A',
        to: 'C',
        date: '2026-03-07',
        at: '23:40',
        window_min: 30,
      }),
    );
    const sleeper = plan.journeys.find((row: { legs: Array<{ trip_id: string }> }) =>
      row.legs.some((leg: { trip_id: string }) => leg.trip_id === 'N1'),
    );
    expect(sleeper, JSON.stringify(plan.journeys)).toBeDefined();
    expect(sleeper.depart).toBe('23:50');
    // The arrival is Sunday 01:10 — the plan must not fold 25:10 back into Saturday morning.
    expect(sleeper.arrive).toBe('+1d 01:10');
  });

  it('keeps headway legs out when the caller asks it to', async () => {
    const withHeadways = payload(
      await callTool('pro_gtfs_journey', {
        feed: 'stage3',
        from: 'A',
        to: 'B',
        date: '2026-03-05',
        at: '08:00',
        window_min: 60,
      }),
    );
    expect(
      withHeadways.journeys.some((row: { legs: Array<{ generated: boolean }> }) =>
        row.legs.some((leg: { generated: boolean }) => leg.generated),
      ),
      JSON.stringify(withHeadways.journeys).slice(0, 900),
    ).toBe(true);
    const withoutThem = payload(
      await callTool('pro_gtfs_journey', {
        feed: 'stage3',
        from: 'A',
        to: 'B',
        date: '2026-03-05',
        at: '08:00',
        window_min: 60,
        include_frequencies: false,
      }),
    );
    expect(
      withoutThem.journeys.every((row: { legs: Array<{ generated: boolean }> }) =>
        row.legs.every((leg: { generated: boolean }) => !leg.generated),
      ),
    ).toBe(true);
  });

  it('names the stop it does not have instead of answering "no journey"', async () => {
    const bad = payload(await callTool('pro_gtfs_journey', { feed: 'stage3', from: 'A', to: 'ZZ' }));
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/beka topilmadi/);
    expect(bad.error).toContain('ZZ');
  });

  it('measures a drawn path, simplifies it, and compares it with the declared distance', async () => {
    const shape = payload(await callTool('pro_gtfs_shapes', { feed: 'stage3', trip: 'F2', simplify_m: 0 }));
    expect(shape.ok).toBe(true);
    const first = shape.shapes[0];
    expect(first.shape_id).toBe('SP1');
    expect(first.points_total).toBe(5);
    expect(first.points_after_simplify).toBe(5);
    expect(first.length_m).toBeGreaterThan(2100);
    expect(first.length_m).toBeLessThan(2500);
    // The feed declared 2200 m along the road; the polyline says slightly more than that because it bows out.
    expect(first.declared).toBe(true);
    expect(first.delta_m).not.toBeNull();
    expect(
      shapeBounds([
        { seq: 1, lat: 41.3, lon: 69.3 },
        { seq: 2, lat: 41.32, lon: 69.304 },
      ] as ShapePoint[]),
    ).toEqual({
      min_lat: 41.3,
      max_lat: 41.32,
      min_lon: 69.3,
      max_lon: 69.304,
    });

    const simplified = payload(await callTool('pro_gtfs_shapes', { feed: 'stage3', shape: 'SP1', simplify_m: 500 }));
    expect(simplified.shapes[0].points_after_simplify).toBe(2);
    expect(simplified.shapes[0].tolerance_m).toBe(500);

    const byRoute = payload(await callTool('pro_gtfs_shapes', { feed: 'stage3', route: 'L1' }));
    expect(byRoute.shapes_matched).toBe(1);
    const geo = payload(await callTool('pro_gtfs_shapes', { feed: 'stage3', shape: 'SP1', geojson: true }));
    expect(geo.shapes[0].geometry.type).toBe('LineString');
    expect(geo.shapes[0].geometry.coordinates[0]).toEqual([69.3, 41.3]);

    const none = payload(await callTool('pro_gtfs_shapes', { feed: 'stage3', trip: 'F1' }));
    expect(none.ok).toBe(false);
    expect(none.error).toMatch(/shape topilmadi/);
  });
});

describe('shape geometry helpers', () => {
  const point = (lat: number, lon: number, dist: number | null = null): ShapePoint => ({ seq: 0, lat, lon, dist });

  it('measures a straight line and a bow in metres', () => {
    const straight = [point(41.3, 69.3), point(41.31, 69.3), point(41.32, 69.3)];
    expect(pathLengthMeters(straight)).toBeGreaterThan(2200);
    expect(pathLengthMeters(straight)).toBeLessThan(2300);
    expect(pathLengthMeters([point(41.3, 69.3)])).toBe(0);
  });

  it('keeps a deviation larger than the tolerance and drops a smaller one', () => {
    const bow = [point(41.3, 69.3), point(41.305, 69.304), point(41.31, 69.3)];
    expect(simplifyShape(bow, 100).length).toBe(3);
    expect(simplifyShape(bow, 500).length).toBe(2);
    expect(simplifyShape(bow, 0).length).toBe(3);
    // A single point or a two-point line cannot be simplified further.
    expect(simplifyShape([point(1, 1)], 100).length).toBe(1);
  });

  it('is a distance to the line, not to the segment end', () => {
    const a = point(41.3, 69.3);
    const b = point(41.31, 69.3);
    const onTheLine = point(41.305, 69.3);
    const offIt = point(41.305, 69.301);
    expect(perpendicularMeters(onTheLine, a, b)).toBeLessThan(1);
    expect(perpendicularMeters(offIt, a, b)).toBeGreaterThan(60);
    // A collapsed base must not divide by zero.
    expect(perpendicularMeters(offIt, a, a)).toBeGreaterThan(0);
  });

  it('survives a shape long enough to break a recursive simplifier', () => {
    // 200,000 points is well past what a naive recursion handles; the stack version finishes instead of dying.
    const long: ShapePoint[] = [];
    for (let i = 0; i < 200_000; i++) long.push(point(41.3 + i * 0.00001, 69.3));
    const out = simplifyShape(long, 50);
    expect(out.length).toBe(2);
    expect(out[0]).toEqual(long[0]);
    expect(out[1]).toEqual(long[long.length - 1]);
  });

  it('reports the difference between declared and measured distance', () => {
    const rows = [point(41.3, 69.3, 0), point(41.32, 69.3, 2000)];
    const check = distCheck(rows, pathLengthMeters(rows));
    expect(check.declared).toBe(true);
    expect(check.declared_m).toBe(2000);
    expect(check.delta_m).toBeLessThan(250);
    expect(distCheck([point(1, 1, null), point(2, 2, 5)], 100).declared).toBe(false);
  });
});
