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

// ------------------------------------------------------------------------------------------
// Stage 2: the calendar, one trip, and the departures a stop actually has.
//
// A second fixture, deliberately: the first one is the validator's test card and every defect in it is
// asserted by name. Adding calendar_dates rows, a cancelled Friday and a sleeper service to that file
// would move those counts, and the point of a fixture is that its defects are stable.
//
// The dates are March 2026: the 2nd is a Monday, the 6th a Friday, the 7th a Saturday, the 8th a Sunday,
// the 10th a Tuesday. WK runs Mon-Fri, SAT Saturdays, SUN Sundays, HOL never on its own pattern — it is
// only added for one date by exception. Friday the 6th is cancelled (a strike), Sunday the 8th cancelled,
// Tuesday the 10th gains HOL.

const STOPS2 = csv(
  ['stop_id', 'stop_name', 'stop_lat', 'stop_lon', 'wheelchair_boarding', 'parent_station'],
  [
    ['P1', 'Platform A', '41.30', '69.30', '0', ''],
    ['P2', 'Platform B', '41.31', '69.31', '0', ''],
    ['P3', 'Yolg‘iz beka', '41.32', '69.32', '0', ''],
  ],
);

const ROUTES2 = csv(
  ['route_id', 'agency_id', 'route_short_name', 'route_long_name', 'route_type'],
  [
    ['L1', 'A1', '1', 'Bir yo‘l', '3'],
    ['L2', 'A1', 'N9', 'Tungi yo‘l', '3'],
  ],
);

const TRIPS2 = csv(
  ['route_id', 'service_id', 'trip_id', 'trip_headsign'],
  [
    ['L1', 'WK', 'D1', 'Platform B'],
    ['L1', 'WK', 'D2', 'Platform B'],
    ['L1', 'HOL', 'D4', 'Platform B'],
    ['L2', 'SAT', 'D3', 'Platform B'],
  ],
);

const STOP_TIMES2 = csv(
  ['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence', 'pickup_type', 'drop_off_type'],
  [
    ['D1', '', '07:30:00', 'P1', '1', '', ''],
    ['D1', '07:45:00', '07:45:00', 'P2', '2', '', ''],
    ['D2', '', '08:30:00', 'P1', '1', '', ''],
    ['D2', '08:45:00', '08:45:00', 'P2', '2', '', ''],
    ['D4', '', '09:00:00', 'P1', '1', '', ''],
    ['D4', '09:15:00', '09:15:00', 'P2', '2', '', ''],
    // The sleeper: it leaves Saturday night and arrives after midnight, which the feed writes as 25:15.
    ['D3', '', '23:55:00', 'P1', '1', '', ''],
    ['D3', '25:15:00', '25:20:00', 'P2', '2', '', ''],
  ],
);

const CALENDAR2 = csv(
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
    ['SUN', '0', '0', '0', '0', '0', '0', '1', '20260101', '20261231'],
    ['HOL', '0', '0', '0', '0', '0', '0', '0', '20260101', '20261231'],
  ],
);

const CALENDAR_DATES2 = csv(
  ['service_id', 'date', 'exception_type'],
  [
    ['WK', '20260306', '2'],
    ['SUN', '20260308', '2'],
    ['HOL', '20260310', '1'],
  ],
);

const AGENCY2 = csv(['agency_id', 'agency_name', 'agency_timezone'], [['A1', 'Stage2 Transit', 'Asia/Tashkent']]);

describe('gtfs calendar, trip and arrivals', () => {
  const FEED2_PATH = join(dir, 'stage2-feed.zip');

  beforeAll(async () => {
    writeFileSync(
      FEED2_PATH,
      writeZip([
        { name: 'stops.txt', data: STOPS2 },
        { name: 'routes.txt', data: ROUTES2 },
        { name: 'trips.txt', data: TRIPS2 },
        { name: 'stop_times.txt', data: STOP_TIMES2 },
        { name: 'calendar.txt', data: CALENDAR2 },
        { name: 'calendar_dates.txt', data: CALENDAR_DATES2 },
        { name: 'agency.txt', data: AGENCY2 },
      ]),
    );
    const loaded = payload(await callTool('pro_gtfs_load', { url: FEED2_PATH, feed: 'stage2' }));
    expect(loaded.ok, JSON.stringify(loaded)).toBe(true);
    expect(loaded.counts.calendar).toBe(4);
    expect(loaded.counts.calendar_dates).toBe(3);
  });

  it('lists routes with measured trips, stops, and their first and last departure', async () => {
    const r = payload(await callTool('pro_gtfs_routes', { feed: 'stage2' }));
    expect(r.ok).toBe(true);
    expect(r.total_routes).toBe(2);
    const l1 = r.routes.find((row: { route_id: string }) => row.route_id === 'L1');
    const l2 = r.routes.find((row: { route_id: string }) => row.route_id === 'L2');
    expect(l1.trips).toBe(3);
    expect(l1.stops).toBe(2);
    expect(l1.first_departure).toBe('07:30');
    // The latest departure anywhere on the line: D4 leaves the final stop (P2) at 09:15, which is later
    // than the 09:00 it leaves the first one. Folded into "last trip start" it would be wrong by 15
    // minutes for every line whose terminus is not the origin.
    expect(l1.last_departure).toBe('09:15');
    expect(l1.past_midnight).toBeUndefined();
    expect(l1.agency).toBe('Stage2 Transit');
    expect(l1.type_name).toBe('bus');
    // The night line's last vehicle leaves at 01:20 of the morning after the service day.
    expect(l2.first_departure).toBe('23:55');
    expect(l2.last_departure).toBe('+1d 01:20');
    expect(l2.past_midnight).toBe(true);

    const viaP3 = payload(await callTool('pro_gtfs_routes', { feed: 'stage2', via_stop: 'P3' }));
    expect(viaP3.matched).toBe(0);
    expect(viaP3.note).toMatch(/uchramaydi/);
    const viaP2 = payload(await callTool('pro_gtfs_routes', { feed: 'stage2', via_stop: 'P2' }));
    expect(viaP2.matched).toBe(2);
    const trams = payload(await callTool('pro_gtfs_routes', { feed: 'stage2', route_type: 0 }));
    expect(trams.matched).toBe(0);
    const buses = payload(await callTool('pro_gtfs_routes', { feed: 'stage2', route_type: 3 }));
    expect(buses.matched).toBe(2);
    const named = payload(await callTool('pro_gtfs_routes', { feed: 'stage2', query: 'tungi' }));
    expect(named.matched).toBe(1);
    expect(named.routes[0].route_id).toBe('L2');
  });

  it('shows one trip in stop order, with the raw after-midnight time kept', async () => {
    const t = payload(await callTool('pro_gtfs_trip', { feed: 'stage2', trip: 'D3', date: '2026-03-07' }));
    expect(t.ok).toBe(true);
    expect(t.route.short_name).toBe('N9');
    expect(t.headsign).toBe('Platform B');
    expect(t.stops.length).toBe(2);
    expect(t.stops[0].arrival).toBeNull();
    expect(t.stops[0].departure).toBe('23:55');
    expect(t.stops[1].arrival).toBe('+1d 01:15');
    expect(t.stops[1].arrival_raw).toBe('25:15:00');
    expect(t.past_midnight).toBe(true);
    // 23:55 to 01:15 the next morning is 80 minutes, not minus 1360.
    expect(t.duration_min).toBe(80);
    expect(t.service.runs_on_this_date).toBe(true);

    const saturdayOnly = payload(await callTool('pro_gtfs_trip', { feed: 'stage2', trip: 'D3', date: '2026-03-06' }));
    expect(saturdayOnly.service.runs_on_this_date).toBe(false);

    const missing = payload(await callTool('pro_gtfs_trip', { feed: 'stage2', trip: 'D9' }));
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/topilmadi/);

    const firstStopNote = payload(await callTool('pro_gtfs_trip', { feed: 'stage2', trip: 'D1', date: '2026-03-05' }));
    expect(firstStopNote.note).toMatch(/boshlanish bekasi/);
  });

  it('answers which days a service runs — pattern, strike and holiday together', async () => {
    const wk = payload(
      await callTool('pro_gtfs_service_dates', { feed: 'stage2', service: 'WK', from: '2026-03-02', to: '2026-03-13' }),
    );
    expect(wk.mode).toBe('service');
    expect(wk.weekdays).toEqual(['monday', 'tuesday', 'wednesday', 'thursday', 'friday']);
    // Ten weekdays in the window, one of them struck off.
    expect(wk.pattern_dates.length).toBe(10);
    expect(wk.total_runs).toBe(9);
    expect(wk.runs_on).not.toContain('2026-03-06');
    expect(wk.runs_on).toContain('2026-03-09');
    expect(wk.removed).toEqual(['2026-03-06']);

    const hol = payload(
      await callTool('pro_gtfs_service_dates', {
        feed: 'stage2',
        service: 'HOL',
        from: '2026-03-02',
        to: '2026-03-13',
      }),
    );
    expect(hol.weekdays).toEqual([]);
    expect(hol.total_runs).toBe(1);
    expect(hol.runs_on).toEqual(['2026-03-10']);

    const saturday = payload(await callTool('pro_gtfs_service_dates', { feed: 'stage2', date: '2026-03-07' }));
    expect(saturday.mode).toBe('date');
    expect(saturday.weekday).toBe('saturday');
    expect(saturday.services).toEqual(['SAT']);
    expect(saturday.from_calendar).toBe(1);
    expect(saturday.routes_running).toBe(1);

    const cancelledSunday = payload(await callTool('pro_gtfs_service_dates', { feed: 'stage2', date: '2026-03-08' }));
    expect(cancelledSunday.services).toEqual([]);
    expect(cancelledSunday.removed_by_date).toBe(1);
    expect(cancelledSunday.note).toMatch(/yurmaydi/);

    const holidayTuesday = payload(await callTool('pro_gtfs_service_dates', { feed: 'stage2', date: '2026-03-10' }));
    expect(holidayTuesday.services).toEqual(['HOL', 'WK']);
    expect(holidayTuesday.added_by_date).toBe(1);

    const byRoute = payload(
      await callTool('pro_gtfs_service_dates', { feed: 'stage2', route: 'L1', from: '2026-03-02', to: '2026-03-13' }),
    );
    expect(byRoute.mode).toBe('route');
    expect(byRoute.services.length).toBe(2);
    const holOnRoute = byRoute.services.find((row: { service_id: string }) => row.service_id === 'HOL');
    expect(holOnRoute.runs_in_window).toBe(1);

    const overview = payload(await callTool('pro_gtfs_service_dates', { feed: 'stage2' }));
    expect(overview.mode).toBe('overview');
    expect(overview.patterns).toBe(4);
    expect(overview.exceptions).toBe(3);
  });

  it('lists departures a stop will really see, filtering by the calendar', async () => {
    const thursday = payload(
      await callTool('pro_gtfs_arrivals', {
        feed: 'stage2',
        stop: 'P1',
        date: '2026-03-05',
        at: '07:00',
        window_min: 120,
      }),
    );
    expect(thursday.ok).toBe(true);
    expect(thursday.services_today).toBe(1);
    // 07:30 and 08:30 run on a Thursday. 09:00 exists in stop_times but belongs to HOL, which only runs
    // on the 10th — a timetable tool that ignored the calendar would show it here.
    expect(thursday.matched).toBe(2);
    expect(thursday.departures.map((row: { trip_id: string }) => row.trip_id)).toEqual(['D1', 'D2']);
    expect(thursday.departures[0].minutes_until).toBe(30);
    expect(thursday.departures[0].departure).toBe('07:30');
    expect(thursday.departures[0].service_day).toBe('2026-03-05');
  });

  it('finds the sleeper that left before midnight, and refuses to show it twice', async () => {
    // Sunday 01:00. The night line ran on Saturday; its 25:20 departure is Sunday's 01:20.
    const night = payload(
      await callTool('pro_gtfs_arrivals', {
        feed: 'stage2',
        stop: 'P2',
        date: '2026-03-08',
        at: '01:00',
        window_min: 60,
      }),
    );
    expect(night.matched).toBe(1);
    expect(night.departures[0].trip_id).toBe('D3');
    expect(night.departures[0].departure).toBe('+1d 01:20');
    expect(night.departures[0].service_day).toBe('2026-03-07');
    expect(night.departures[0].day_offset).toBe(-1);
    expect(night.departures[0].minutes_until).toBe(20);
    expect(night.note).toMatch(/kechagi/);

    // Saturday 01:00 is the same clock time one day earlier, and the correct answer is nothing: the
    // sleeper has not started yet, and its after-midnight minutes belong to the morning that follows.
    const beforeItStarts = payload(
      await callTool('pro_gtfs_arrivals', {
        feed: 'stage2',
        stop: 'P2',
        date: '2026-03-07',
        at: '01:00',
        window_min: 60,
      }),
    );
    expect(beforeItStarts.matched).toBe(0);
    expect(beforeItStarts.services_today).toBe(1);
  });

  it('lists the trips of a line, earliest departure first', async () => {
    const listed = payload(await callTool('pro_gtfs_trip', { feed: 'stage2', route: 'L1' }));
    expect(listed.mode).toBe('trips');
    expect(listed.trips.length).toBe(3);
    expect(listed.trips[0].trip_id).toBe('D1');
    expect(listed.trips[0].first_departure).toBe('07:30');
    expect(listed.trips[0].last_arrival).toBe('07:45');
    expect(listed.trips[2].trip_id).toBe('D4');
    expect(listed.trips[2].service_id).toBe('HOL');

    const night = payload(await callTool('pro_gtfs_trip', { feed: 'stage2', route: 'L2' }));
    expect(night.trips[0].last_arrival).toBe('+1d 01:15');

    const unknownRoute = payload(await callTool('pro_gtfs_trip', { feed: 'stage2', route: 'LX' }));
    expect(unknownRoute.ok).toBe(false);
    expect(unknownRoute.error).toMatch(/route_id topilmadi/);

    const neither = payload(await callTool('pro_gtfs_trip', { feed: 'stage2' }));
    expect(neither.ok).toBe(false);
    expect(neither.error).toMatch(/trip yoki route/);
  });

  it('says what it does not know instead of inventing a vehicle', async () => {
    const empty = payload(
      await callTool('pro_gtfs_arrivals', {
        feed: 'stage2',
        stop: 'P3',
        date: '2026-03-05',
        at: '07:00',
        window_min: 600,
      }),
    );
    expect(empty.ok).toBe(true);
    expect(empty.matched).toBe(0);
    // No frequencies.txt in this fixture, so nothing is being silently left out of the list.
    expect(empty.note).toBeUndefined();

    const unknown = payload(await callTool('pro_gtfs_arrivals', { feed: 'stage2', stop: 'PX' }));
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toMatch(/beka topilmadi/);
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
