/**
 * GTFS: the shared engine behind the `gtfs` tools.
 *
 * ## What a GTFS feed is, in one paragraph
 *
 * A GTFS feed is a zip of CSV files describing public transport: `stops.txt` (where), `routes.txt`
 * (which lines), `trips.txt` (which vehicle runs which line on which day-pattern), `stop_times.txt`
 * (at what minute it is at each stop), and `calendar.txt` / `calendar_dates.txt` (which dates a
 * pattern runs). Nothing in it is a timetable in the human sense — a journey is assembled by joining
 * those five tables, which is exactly what a relational database is for. So the feed is parsed once
 * into SQLite and queried afterwards; re-reading a 13 MB zip for every question would be slower and
 * stupider.
 *
 * ## Rules this implementation follows, and why each one is not optional
 *
 * - **Rows are streamed, never materialised.** The first version of this module used the project's
 *   shared `parseCsvRows`, and loading a real national feed killed the process: Entur's aggregated
 *   Norway feed carries a 9 MB `stop_times.txt` — over a million rows — and an array of a million
 *   seven-element arrays is enough to die on Node's teardown abort (`Assertion failed: (env) !=
 *   nullptr`) with no answer coming back. The reader here yields one record at a time. It is also why
 *   this file does not reuse `parseCsvRows` although the state machine is the same: that function pads
 *   every row to the *widest* record, which cannot be known without holding the whole file.
 * - **Times are minutes since midnight, and may exceed 1440.** GTFS writes a trip that starts before
 *   midnight and finishes after it as `25:10:00`. Parsing with a normal clock parser turns those trips
 *   into yesterday, and the first departure of the day then appears to be 01:10 rather than 25:10.
 *   The raw string is kept next to the number so the answer can quote what the feed actually said.
 * - **A reload replaces atomically.** Rows are deleted and inserted inside one transaction, so a
 *   query never sees half a new timetable and half an old one.
 * - **Errors are counted, not swallowed.** A feed with 400 dangling references is a real feed in the
 *   wild; the tool reports the count and a bounded sample of examples, never all 400 and never zero.
 * - **The driver is optional.** `better-sqlite3` is an optional dependency. Without it the answer is
 *   the machine fact (`npm rebuild better-sqlite3`), not a native stack trace — the same pattern
 *   `core/local-index.ts` uses.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

import { log } from '../../core/log.js';
import { downloadToBuffer } from '../../core/http-client.js';
import { canSkipSideEffect } from '../../core/read-only-guard.js';
import { DEFAULT_MAX_INFLATED_BYTES, readEntry, readZip } from '../zip/_zip.js';

/** How many examples a load warning reports before switching to "and N more". */
export const MAX_EXAMPLES = 20;

export interface SqliteStatement {
  all(...args: unknown[]): Array<Record<string, unknown>>;
  get(...args: unknown[]): Record<string, unknown> | undefined;
  run(...args: unknown[]): { changes: number };
}
export interface SqliteLike {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}

export const REQUIRED_FILES = ['stops.txt', 'routes.txt', 'trips.txt', 'stop_times.txt'];
export const OPTIONAL_FILES = [
  'agency.txt',
  'calendar.txt',
  'calendar_dates.txt',
  'fare_attributes.txt',
  'fare_rules.txt',
  'frequencies.txt',
  'pathways.txt',
  'shapes.txt',
  'transfers.txt',
  'translations.txt',
  'feed_info.txt',
];

/**
 * Columns a file cannot be used without.
 *
 * Only genuinely required columns are listed. `agency_id` is optional when a feed has one agency,
 * `route_short_name` is optional when `route_long_name` exists (checked per row), and
 * `arrival_time`/`departure_time` may legitimately be empty at a stop nobody boards or leaves — a
 * column that exists but holds blanks is not a missing column.
 */
const REQUIRED_COLUMNS: Record<string, string[]> = {
  'stops.txt': ['stop_id', 'stop_name', 'stop_lat', 'stop_lon'],
  'routes.txt': ['route_id'],
  'trips.txt': ['route_id', 'service_id', 'trip_id'],
  'stop_times.txt': ['trip_id', 'stop_id', 'stop_sequence'],
  'calendar.txt': [
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
  'calendar_dates.txt': ['service_id', 'date', 'exception_type'],
  'agency.txt': ['agency_name'],
  'shapes.txt': ['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence'],
  'transfers.txt': ['from_stop_id', 'to_stop_id'],
  'frequencies.txt': ['trip_id', 'start_time', 'end_time', 'headway_secs'],
  'feed_info.txt': ['feed_publisher_name', 'feed_lang'],
};

const SCHEMA = `
create table if not exists feeds (
  feed_id text primary key,
  source text not null,
  loaded_at_ms integer not null,
  counts text not null,
  warnings text not null
);
create table if not exists stops (
  feed_id text not null, stop_id text not null, name text, lat real, lon real,
  code text, timezone text, wheelchair text, parent text, location_type text,
  primary key (feed_id, stop_id)
);
create index if not exists stops_lat on stops (feed_id, lat);
create table if not exists routes (
  feed_id text not null, route_id text not null, agency_id text, short_name text, long_name text,
  type text, color text, text_color text, url text,
  primary key (feed_id, route_id)
);
create table if not exists trips (
  feed_id text not null, trip_id text not null, route_id text, service_id text,
  headsign text, shape_id text, direction text,
  primary key (feed_id, trip_id)
);
create index if not exists trips_route on trips (feed_id, route_id);
create index if not exists trips_service on trips (feed_id, service_id);
create table if not exists stop_times (
  feed_id text not null, trip_id text not null, stop_id text, stop_sequence integer,
  arrival_raw text, arrival_min integer, departure_raw text, departure_min integer,
  pickup text, drop_off text, dist real
);
create index if not exists stop_times_trip on stop_times (feed_id, trip_id, stop_sequence);
create index if not exists stop_times_stop on stop_times (feed_id, stop_id, arrival_min);
create table if not exists calendar (
  feed_id text not null, service_id text not null, days integer, start_date text, end_date text,
  primary key (feed_id, service_id)
);
create table if not exists calendar_dates (
  feed_id text not null, service_id text not null, date text, exception integer
);
create index if not exists calendar_dates_date on calendar_dates (feed_id, date);
create table if not exists agencies (
  feed_id text not null, agency_id text, name text, url text, timezone text, lang text, phone text
);
create table if not exists feed_info (
  feed_id text not null, publisher text, version text, start_date text, end_date text, lang text
);
create table if not exists shapes (
  feed_id text not null, shape_id text, lat real, lon real, seq integer, dist real
);
create index if not exists shapes_shape on shapes (feed_id, shape_id, seq);
create table if not exists transfers (
  feed_id text not null, from_stop text, to_stop text, minutes integer, kind text
);
create table if not exists frequencies (
  feed_id text not null, trip_id text, start_min integer, end_min integer, headway integer
);
create table if not exists file_rows (
  feed_id text not null, file text not null, rows integer not null, missing integer not null
);
`;

/** Bitmask of the weekday flags in `calendar.days`, Monday = bit 0. */
const DAY_BITS: Array<[string, number]> = [
  ['monday', 1],
  ['tuesday', 2],
  ['wednesday', 4],
  ['thursday', 8],
  ['friday', 16],
  ['saturday', 32],
  ['sunday', 64],
];

export function gtfsDbPath(): string {
  const configured = process.env.PRO_FETCH_GTFS_PATH?.trim();
  return configured && configured.length ? configured : join(homedir(), '.pro-fetch', 'gtfs.sqlite');
}

let handle: { path: string; db: SqliteLike } | null = null;

/**
 * Prepared statements, kept for as long as the database is open.
 *
 * Two reasons, one of them a crash. better-sqlite3 finalises a statement when V8 garbage-collects the
 * wrapper, and on Node 24 that teardown can abort the whole process — upstream WiseLibs/better-sqlite3
 * #1515 (`RemoveEnvironmentCleanupHook: Assertion (env) != nullptr`). Measured here: loading a real
 * national feed died 6 times out of 6 at a different row each time with driver 11.10.0, and the only
 * thing the failing runs did that the passing ones did not was throw away ~30 statement objects.
 * Holding them means no statement is ever collected mid-run. The second reason is ordinary: a validate
 * call prepares 15 queries, a stops call several more, and re-preparing them per call is pure waste.
 */
const statementCache = new Map<string, SqliteStatement>();

export function prepared(db: SqliteLike, sql: string): SqliteStatement {
  const cached = statementCache.get(sql);
  if (cached) return cached;
  const statement = db.prepare(sql);
  statementCache.set(sql, statement);
  return statement;
}

/** Open (and create) the feed database. The optional driver's absence is reported as itself. */
export async function openGtfsDb(): Promise<SqliteLike> {
  const path = gtfsDbPath();
  if (handle && handle.path === path) return handle.db;

  let open: new (file: string) => SqliteLike;
  try {
    const specifier = 'better-sqlite3';
    const mod = (await import(specifier)) as unknown as { default: new (file: string) => SqliteLike };
    open = mod.default;
  } catch (error) {
    throw new Error(
      'gtfs ishlari uchun better-sqlite3 kerak — u majburiy bo‘lmagan bog‘liqlik. ' +
        'Qayta qurish: `npm rebuild better-sqlite3`. Asl xato: ' +
        (error as Error).message,
    );
  }

  mkdirSync(dirname(path), { recursive: true });
  const db = new open(path);
  // Statements belong to the database that made them: a new handle invalidates every cached one.
  statementCache.clear();
  db.exec('pragma journal_mode = WAL');
  db.exec(SCHEMA);
  handle = { path, db };
  log(JSON.stringify({ event: 'gtfs.db_opened', path }));
  return db;
}

/** Only for tests: forget the open handle so a temporary path takes effect. */
export function closeGtfsDb(): void {
  if (!handle) return;
  try {
    handle.db.close();
  } catch {
    /* a handle we are abandoning is not worth an error */
  }
  // The database finalised its own statements on close; our copies of them are dead handles now.
  statementCache.clear();
  handle = null;
}

/**
 * `25:10:00` → 1510 minutes. Returns null for anything that is not `H:MM[:SS]`.
 *
 * The bound is 36 hours, not 24: feeds are allowed to run past midnight and a few write the last leg
 * of a sleeper service as `30:05:00`. Rejecting that would delete real trips; accepting `99:00` would
 * invent them. Seconds are dropped — GTFS is minute-granular in practice and the raw string is stored
 * next to the number, so nothing the feed said is lost.
 */
export function parseGtfsTime(raw: string | undefined | null): number | null {
  const text = (raw ?? '').trim();
  const match = /^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?$/.exec(text);
  if (!match) return null;
  const hours = Number(match[1]);
  if (hours > 36) return null;
  return hours * 60 + Number(match[2]);
}

/**
 * Degrees of latitude and longitude that contain everything within `radiusMeters` of a point.
 *
 * The degree of latitude is taken as 110,574 m — the small end of the real range (110,574–111,694),
 * so the box is slightly too big rather than slightly too small, and an over-large box costs nothing
 * because the exact haversine filter still decides. Longitude shrinks with cosine, which runs away at
 * the poles: `cos` is clamped so the box cannot become infinite, and a box that would cross the
 * antimeridian reports `wraps`, leaving the caller to drop the longitude constraint instead of
 * building a `lon between 179 and -179` clause that matches nothing.
 */
export function boundingBox(
  lat: number,
  lon: number,
  radiusMeters: number,
): { minLat: number; maxLat: number; minLon: number; maxLon: number; wraps: boolean } {
  const dLat = radiusMeters / 110_574;
  const cos = Math.max(0.01, Math.abs(Math.cos((lat * Math.PI) / 180)));
  const dLon = radiusMeters / (111_320 * cos);
  return {
    minLat: Math.max(-90, lat - dLat),
    maxLat: Math.min(90, lat + dLat),
    minLon: lon - dLon,
    maxLon: lon + dLon,
    wraps: dLon >= 180 || lon - dLon < -180 || lon + dLon > 180,
  };
}

/** `20260131` → 2026-01-31. Returns null when the digits do not form a date. */
export function parseGtfsDate(raw: string | undefined | null): string | null {
  const text = (raw ?? '').trim();
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (!match) return null;
  const [, y, m, d] = match;
  const stamp = Date.parse(y + '-' + m + '-' + d + 'T00:00:00Z');
  if (!Number.isFinite(stamp)) return null;
  const back = new Date(stamp);
  if (back.getUTCMonth() + 1 !== Number(m) || back.getUTCDate() !== Number(d)) return null;
  return y + '-' + m + '-' + d;
}

function toNumber(raw: string | undefined | null): number | null {
  const text = (raw ?? '').trim();
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** A bounded, readable identifier for a feed when the caller did not name one. */
export function deriveFeedId(source: string): string {
  const slug = source
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .replace(/\.zip$/i, '')
    .slice(-48);
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 8);
  return (slug || 'feed') + '-' + hash;
}

/**
 * Yield CSV records one at a time.
 *
 * Same grammar as the project's shared parser — quoted fields may contain the delimiter, a newline or
 * a carriage return; `""` is a literal quote; a quote in the middle of an unquoted field and an
 * unterminated quote are errors, not shrugs — but it never builds the array of all rows, which is the
 * only reason this exists beside `convert/_csv.ts` instead of inside it.
 */
export function* csvRecords(text: string, delimiter = ','): Generator<string[]> {
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let index = 0;
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  while (index < source.length) {
    const character = source[index]!;
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        field += '"';
        index += 2;
        continue;
      }
      if (character === '"') {
        quoted = false;
        index += 1;
        continue;
      }
      field += character;
      index += 1;
      continue;
    }
    if (character === '"') {
      if (field.length) throw new Error('CSV format xatosi: quote field o‘rtasida keldi.');
      quoted = true;
      index += 1;
      continue;
    }
    if (character === delimiter) {
      row.push(field);
      field = '';
      index += 1;
      continue;
    }
    if (character === '\r' || character === '\n') {
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      row.push(field);
      const finished = row;
      row = [];
      field = '';
      index += 1;
      if (finished.some((value) => value.length > 0)) yield finished;
      continue;
    }
    field += character;
    index += 1;
  }

  if (quoted) throw new Error('CSV format xatosi: yopilmagan quote.');
  if (field.length || row.length) {
    row.push(field);
    if (row.some((value) => value.length > 0)) yield row;
  }
}

export interface StreamReport {
  header: string[];
  rows: number;
  /** Records whose width differs from the header — the feed said one thing and delivered another. */
  ragged: number;
}

/**
 * Stream one CSV file, handing each row a column accessor bound to the header.
 *
 * Rows are normalised to the **header** width, not to the widest record: a feed whose last row has an
 * extra comma must not make every earlier row wider, and finding the widest row would mean holding the
 * whole file in memory — the thing this function exists to avoid.
 */
export function streamCsv(
  text: string,
  onRow: (cell: (column: string) => string, row: string[]) => void,
): StreamReport {
  const records = csvRecords(text);
  const first = records.next();
  if (first.done) return { header: [], rows: 0, ragged: 0 };

  const header = first.value.map((name) => name.trim());
  const positions = new Map<string, number>();
  for (let position = 0; position < header.length; position++) {
    if (!positions.has(header[position]!)) positions.set(header[position]!, position);
  }

  const report: StreamReport = { header, rows: 0, ragged: 0 };
  for (const raw of records) {
    let row = raw;
    if (row.length !== header.length) {
      report.ragged++;
      row = header.map((_, position) => raw[position] ?? '');
    }
    report.rows++;
    onRow((column: string) => (positions.has(column) ? (row[positions.get(column)!] ?? '').trim() : ''), row);
  }
  return report;
}

export interface FeedZip {
  /** File names present in the archive, normalised to the spec's lowercase spelling. */
  names: string[];
  /** Read one entry as text. Returns null when the archive does not contain it. */
  text(file: string): string | null;
  totalBytes: number;
}

/**
 * Open a GTFS archive.
 *
 * Feeds are published with case differences (`Stops.txt`), with the files loose inside a folder
 * (`norway/gtfs/stops.txt`), and occasionally with extra entries. Both are handled by matching the
 * basename case-insensitively, and the result is reported so a caller can see what was actually read.
 */
export function openFeedZip(buffer: Buffer): FeedZip {
  const archive = readZip(buffer);
  const byBase = new Map<string, string>();
  for (const entry of archive.entries) {
    if (entry.is_directory) continue;
    const base = entry.name.split('/').pop()!.toLowerCase();
    if (!byBase.has(base)) byBase.set(base, entry.name);
  }
  return {
    names: [...byBase.keys()].sort(),
    totalBytes: buffer.length,
    text(file: string): string | null {
      const name = byBase.get(file.toLowerCase());
      if (!name) return null;
      const entry = archive.entries.find((item) => item.name === name)!;
      return readEntry(buffer, entry, DEFAULT_MAX_INFLATED_BYTES).toString('utf8');
    },
  };
}

/** Where the bytes came from, without pretending a local file was downloaded. */
export async function readFeedSource(source: string, maxBytes: number): Promise<{ bytes: Buffer; origin: string }> {
  if (/^https?:\/\//i.test(source)) {
    const downloaded = await downloadToBuffer(source, maxBytes, 120_000);
    return { bytes: downloaded.bytes, origin: downloaded.url };
  }
  const local = source.replace(/^file:\/\//i, '');
  if (!existsSync(local)) throw new Error('GTFS fayli topilmadi: ' + local);
  const buffer = readFileSync(local);
  if (buffer.length > maxBytes) {
    throw new Error(
      'GTFS fayli juda katta: ' + buffer.length + ' bayt, ruxsat etilgan ' + maxBytes + '. max_bytes ni oshiring.',
    );
  }
  return { bytes: buffer, origin: local };
}

export interface LoadResult {
  feed_id: string;
  source: string;
  origin: string;
  files_present: string[];
  files_missing_required: string[];
  counts: Record<string, number>;
  warnings: string[];
  loaded_at_ms: number;
  bytes: number;
}

/**
 * Parse a feed and replace its rows in the database.
 *
 * Deleting and inserting happen in one transaction: a caller asking a question while a reload runs must
 * get either the whole old timetable or the whole new one, never a mixture.
 */
export async function loadFeed(
  source: string,
  options: { feedId?: string; maxBytes?: number } = {},
): Promise<LoadResult> {
  if (canSkipSideEffect()) {
    throw new Error(
      'PRO_FETCH_READ_ONLY=true rejimida gtfs feedini saqlab bo‘lmaydi — load yozuv amalga oshiradi. ' +
        'O‘chirib, qayta urinib ko‘ring.',
    );
  }
  const maxBytes = options.maxBytes ?? 128 * 1024 * 1024;
  progressStart = Date.now();
  progress('load ' + source);
  const { bytes, origin } = await readFeedSource(source, maxBytes);
  progress('o‘qildi: ' + bytes.length + ' bayt');
  const zip = openFeedZip(bytes);
  const feedId = (options.feedId ?? '').trim() || deriveFeedId(source);
  const db = await openGtfsDb();
  progress('zip ochildi: ' + zip.names.length + ' fayl, db tayyor');

  const warnings: string[] = [];
  const missingRequired = REQUIRED_FILES.filter((file) => !zip.names.includes(file.toLowerCase()));
  if (missingRequired.length) warnings.push('majburiy fayl yo‘q: ' + missingRequired.join(', '));
  if (!zip.text('calendar.txt') && !zip.text('calendar_dates.txt')) {
    warnings.push('na calendar.txt, na calendar_dates.txt — qaysi kun yurishi aytilmagan');
  }

  const counts: Record<string, number> = {};
  const loadedAt = Date.now();

  db.exec('begin');
  try {
    for (const table of [
      'stops',
      'routes',
      'trips',
      'stop_times',
      'calendar',
      'calendar_dates',
      'agencies',
      'feed_info',
      'shapes',
      'transfers',
      'frequencies',
      'file_rows',
    ]) {
      prepared(db, 'delete from ' + table + ' where feed_id = ?').run(feedId);
    }
    prepared(db, 'delete from feeds where feed_id = ?').run(feedId);
    progress('eski qatorlar o‘chirildi, insert boshlandi');

    counts.stops = insertStops(db, feedId, zip, warnings);
    counts.routes = insertRoutes(db, feedId, zip, warnings);
    counts.trips = insertTrips(db, feedId, zip, warnings);
    counts.stop_times = insertStopTimes(db, feedId, zip, warnings);
    counts.calendar = insertCalendar(db, feedId, zip, warnings);
    counts.calendar_dates = insertCalendarDates(db, feedId, zip, warnings);
    counts.shapes = insertShapes(db, feedId, zip, warnings);
    counts.transfers = insertTransfers(db, feedId, zip, warnings);
    counts.frequencies = insertFrequencies(db, feedId, zip, warnings);
    counts.agencies = insertAgencies(db, feedId, zip);
    counts.feed_info = insertFeedInfo(db, feedId, zip);
    counts.files = recordFiles(db, feedId, zip, warnings, {
      'stops.txt': counts.stops,
      'routes.txt': counts.routes,
      'trips.txt': counts.trips,
      'stop_times.txt': counts.stop_times,
      'calendar.txt': counts.calendar,
      'calendar_dates.txt': counts.calendar_dates,
      'shapes.txt': counts.shapes,
      'transfers.txt': counts.transfers,
      'frequencies.txt': counts.frequencies,
      'agency.txt': counts.agencies,
      'feed_info.txt': counts.feed_info,
    });

    prepared(db, 'insert into feeds (feed_id, source, loaded_at_ms, counts, warnings) values (?,?,?,?,?)').run(
      feedId,
      source,
      loadedAt,
      JSON.stringify(counts),
      JSON.stringify(warnings),
    );
    db.exec('commit');
    progress('commit bo‘ldi');
  } catch (error) {
    db.exec('rollback');
    throw error;
  }

  log(JSON.stringify({ event: 'gtfs.loaded', feed_id: feedId, bytes: bytes.length, counts }));
  return {
    feed_id: feedId,
    source,
    origin,
    files_present: zip.names,
    files_missing_required: missingRequired,
    counts,
    warnings,
    loaded_at_ms: loadedAt,
    bytes: bytes.length,
  };
}

/**
 * Where the current load is, written to stderr when `PRO_FETCH_GTFS_DEBUG=1`.
 *
 * A national feed is minutes of work: 13 MB downloaded, 1.5M stop rows inserted. Without a spool an
 * operator cannot tell "still working" from "hung", and a test that dies cannot say which stage died.
 * Off by default — stderr next to the stdio MCP channel is not a place for chatter.
 */
let progressStart = Date.now();
function progress(message: string): void {
  const sink = process.env.PRO_FETCH_GTFS_DEBUG?.trim();
  if (!sink) return;
  const mem = process.memoryUsage();
  const line =
    '[gtfs +' +
    ((Date.now() - progressStart) / 1000).toFixed(1) +
    's rss=' +
    Math.round(mem.rss / 1e6) +
    'MB] ' +
    message +
    '\n';
  // `=1` → fd 2, which is written synchronously so an abort cannot eat the last lines.
  // Any other value is a file path, appended per line for the same reason.
  if (sink === '1') writeSync(2, line);
  else appendFileSync(sink, line);
}

/** Stream one file, reporting the missing columns its header shows. */
function withFile(
  zip: FeedZip,
  file: string,
  warnings: string[],
  onRow: (cell: (column: string) => string) => void,
): number {
  const startedAt = Date.now();
  const text = zip.text(file);
  if (text === null) {
    progress('skip ' + file + ' (yo‘q)');
    return 0;
  }
  let rows = 0;
  const report = streamCsv(text, (cell) => {
    rows++;
    if (rows % 5_000 === 0) progress(file + ': ' + rows + ' qator');
    onRow(cell);
  });
  progress(file + ': ' + rows + ' qator, ' + (Date.now() - startedAt) + ' ms');
  for (const column of REQUIRED_COLUMNS[file] ?? []) {
    if (!report.header.includes(column)) warnings.push(file + ': majburiy ustun yo‘q — ' + column);
  }
  if (report.ragged) warnings.push(file + ': ' + report.ragged + ' qator uzunligi sarlavhaga mos emas');
  return rows;
}

function insertStops(db: SqliteLike, feedId: string, zip: FeedZip, warnings: string[]): number {
  const stmt = prepared(
    db,
    'insert into stops (feed_id, stop_id, name, lat, lon, code, timezone, wheelchair, parent, location_type) values (?,?,?,?,?,?,?,?,?,?)',
  );
  let bad = 0;
  let reported = 0;
  const rows = withFile(zip, 'stops.txt', warnings, (cell) => {
    const stopId = cell('stop_id');
    const lat = toNumber(cell('stop_lat'));
    const lon = toNumber(cell('stop_lon'));
    if (!stopId || lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      bad++;
      if (reported < MAX_EXAMPLES) {
        reported++;
        warnings.push(
          'stops.txt: yaroqsiz nuqta — stop_id=' +
            (stopId || "(bo'sh)") +
            ' lat=' +
            (lat ?? '(yoq)') +
            ' lon=' +
            (lon ?? '(yoq)'),
        );
      }
      return;
    }
    stmt.run(
      feedId,
      stopId,
      cell('stop_name'),
      lat,
      lon,
      cell('stop_code'),
      cell('stop_timezone'),
      cell('wheelchair_boarding'),
      cell('parent_station'),
      cell('location_type'),
    );
  });
  if (bad > MAX_EXAMPLES)
    warnings.push('stops.txt: yana ' + (bad - MAX_EXAMPLES) + ' yaroqsiz nuqta o‘tkazib yuborildi');
  return rows;
}

function insertRoutes(db: SqliteLike, feedId: string, zip: FeedZip, warnings: string[]): number {
  const stmt = prepared(
    db,
    'insert into routes (feed_id, route_id, agency_id, short_name, long_name, type, color, text_color, url) values (?,?,?,?,?,?,?,?,?)',
  );
  let unnamed = 0;
  let reported = 0;
  const rows = withFile(zip, 'routes.txt', warnings, (cell) => {
    const routeId = cell('route_id');
    if (!routeId) {
      warnings.push("routes.txt: route_id bo'sh qator o'tkazib yuborildi");
      return;
    }
    const shortName = cell('route_short_name');
    const longName = cell('route_long_name');
    if (!shortName && !longName) {
      unnamed++;
      if (reported < MAX_EXAMPLES) {
        reported++;
        warnings.push('routes.txt: ' + routeId + ' — na short_name, na long_name (yo‘lda kamida bittasi shart)');
      }
    }
    stmt.run(
      feedId,
      routeId,
      cell('agency_id'),
      shortName,
      longName,
      cell('route_type'),
      cell('route_color'),
      cell('route_text_color'),
      cell('route_url'),
    );
  });
  if (unnamed > MAX_EXAMPLES) warnings.push('routes.txt: yana ' + (unnamed - MAX_EXAMPLES) + ' yo‘l nomlanmagan');
  return rows;
}

function insertTrips(db: SqliteLike, feedId: string, zip: FeedZip, warnings: string[]): number {
  const stmt = prepared(
    db,
    'insert into trips (feed_id, trip_id, route_id, service_id, headsign, shape_id, direction) values (?,?,?,?,?,?,?)',
  );
  return withFile(zip, 'trips.txt', warnings, (cell) => {
    const tripId = cell('trip_id');
    if (!tripId) {
      warnings.push("trips.txt: trip_id bo'sh qator o'tkazib yuborildi");
      return;
    }
    stmt.run(
      feedId,
      tripId,
      cell('route_id'),
      cell('service_id'),
      cell('trip_headsign'),
      cell('shape_id'),
      cell('direction_id'),
    );
  });
}

function insertStopTimes(db: SqliteLike, feedId: string, zip: FeedZip, warnings: string[]): number {
  const stmt = prepared(
    db,
    'insert into stop_times (feed_id, trip_id, stop_id, stop_sequence, arrival_raw, arrival_min, departure_raw, departure_min, pickup, drop_off, dist) values (?,?,?,?,?,?,?,?,?,?,?)',
  );
  let badTime = 0;
  let reported = 0;
  const rows = withFile(zip, 'stop_times.txt', warnings, (cell) => {
    const arrivalRaw = cell('arrival_time');
    const departureRaw = cell('departure_time');
    const arrival = parseGtfsTime(arrivalRaw);
    const departure = parseGtfsTime(departureRaw);
    if (arrival === null || departure === null) {
      badTime++;
      if (reported < MAX_EXAMPLES) {
        reported++;
        warnings.push(
          'stop_times.txt: vaqt o‘qilmadi — ' +
            (arrivalRaw || "(bo'sh)") +
            '/' +
            (departureRaw || "(bo'sh)") +
            ' trip=' +
            cell('trip_id'),
        );
      }
    }
    stmt.run(
      feedId,
      cell('trip_id'),
      cell('stop_id'),
      toNumber(cell('stop_sequence')),
      arrivalRaw,
      arrival,
      departureRaw,
      departure,
      cell('pickup_type'),
      cell('drop_off_type'),
      toNumber(cell('shape_dist_traveled')),
    );
  });
  if (badTime > MAX_EXAMPLES)
    warnings.push('stop_times.txt: yana ' + (badTime - MAX_EXAMPLES) + ' qatorda vaqt o‘qilmadi');
  return rows;
}

function insertCalendar(db: SqliteLike, feedId: string, zip: FeedZip, warnings: string[]): number {
  const stmt = prepared(
    db,
    'insert into calendar (feed_id, service_id, days, start_date, end_date) values (?,?,?,?,?)',
  );
  return withFile(zip, 'calendar.txt', warnings, (cell) => {
    let mask = 0;
    for (const [column, bit] of DAY_BITS) if (cell(column) === '1') mask += bit;
    const start = parseGtfsDate(cell('start_date'));
    const end = parseGtfsDate(cell('end_date'));
    if (!start || !end) {
      warnings.push('calendar.txt: sana o‘qilmadi — ' + cell('start_date') + '..' + cell('end_date'));
      return;
    }
    if (start > end) warnings.push('calendar.txt: boshlanish tugashdan keyin — ' + cell('service_id'));
    stmt.run(feedId, cell('service_id'), mask, start, end);
  });
}

function insertCalendarDates(db: SqliteLike, feedId: string, zip: FeedZip, warnings: string[]): number {
  const stmt = prepared(db, 'insert into calendar_dates (feed_id, service_id, date, exception) values (?,?,?,?)');
  return withFile(zip, 'calendar_dates.txt', warnings, (cell) => {
    const date = parseGtfsDate(cell('date'));
    if (!date) {
      warnings.push('calendar_dates.txt: sana o‘qilmadi — ' + cell('date'));
      return;
    }
    const exception = toNumber(cell('exception_type'));
    if (exception !== 1 && exception !== 2) {
      warnings.push('calendar_dates.txt: exception_type 1 yoki 2 bo‘lishi kerak — ' + cell('exception_type'));
    }
    stmt.run(feedId, cell('service_id'), date, exception);
  });
}

function insertShapes(db: SqliteLike, feedId: string, zip: FeedZip, warnings: string[]): number {
  const stmt = prepared(db, 'insert into shapes (feed_id, shape_id, lat, lon, seq, dist) values (?,?,?,?,?,?)');
  return withFile(zip, 'shapes.txt', warnings, (cell) => {
    const lat = toNumber(cell('shape_pt_lat'));
    const lon = toNumber(cell('shape_pt_lon'));
    if (lat === null || lon === null) return;
    stmt.run(
      feedId,
      cell('shape_id'),
      lat,
      lon,
      toNumber(cell('shape_pt_sequence')),
      toNumber(cell('shape_dist_traveled')),
    );
  });
}

function insertTransfers(db: SqliteLike, feedId: string, zip: FeedZip, warnings: string[]): number {
  const stmt = prepared(db, 'insert into transfers (feed_id, from_stop, to_stop, minutes, kind) values (?,?,?,?,?)');
  return withFile(zip, 'transfers.txt', warnings, (cell) => {
    stmt.run(
      feedId,
      cell('from_stop_id'),
      cell('to_stop_id'),
      toNumber(cell('min_transfer_time')),
      cell('transfer_type'),
    );
  });
}

function insertFrequencies(db: SqliteLike, feedId: string, zip: FeedZip, warnings: string[]): number {
  const stmt = prepared(
    db,
    'insert into frequencies (feed_id, trip_id, start_min, end_min, headway) values (?,?,?,?,?)',
  );
  return withFile(zip, 'frequencies.txt', warnings, (cell) => {
    stmt.run(
      feedId,
      cell('trip_id'),
      parseGtfsTime(cell('start_time')),
      parseGtfsTime(cell('end_time')),
      toNumber(cell('headway_secs')),
    );
  });
}

function insertAgencies(db: SqliteLike, feedId: string, zip: FeedZip): number {
  const stmt = prepared(
    db,
    'insert into agencies (feed_id, agency_id, name, url, timezone, lang, phone) values (?,?,?,?,?,?,?)',
  );
  return withFile(zip, 'agency.txt', [], (cell) => {
    stmt.run(
      feedId,
      cell('agency_id'),
      cell('agency_name'),
      cell('agency_url'),
      cell('agency_timezone'),
      cell('agency_lang'),
      cell('agency_phone'),
    );
  });
}

function insertFeedInfo(db: SqliteLike, feedId: string, zip: FeedZip): number {
  const stmt = prepared(
    db,
    'insert into feed_info (feed_id, publisher, version, start_date, end_date, lang) values (?,?,?,?,?,?)',
  );
  return withFile(zip, 'feed_info.txt', [], (cell) => {
    stmt.run(
      feedId,
      cell('feed_publisher_name'),
      cell('feed_version'),
      parseGtfsDate(cell('feed_start_date')),
      parseGtfsDate(cell('feed_end_date')),
      cell('feed_lang'),
    );
  });
}

function recordFiles(
  db: SqliteLike,
  feedId: string,
  zip: FeedZip,
  warnings: string[],
  measured: Record<string, number>,
): number {
  const stmt = prepared(db, 'insert into file_rows (feed_id, file, rows, missing) values (?,?,?,?)');
  const known = [...REQUIRED_FILES, ...OPTIONAL_FILES];
  for (const file of known) {
    const present = zip.names.includes(file.toLowerCase());
    // A file the loader already streamed has a measured row count: re-counting it would double the
    // work on the biggest file in the feed (950k shape points is seconds of parsing). Files the
    // loader does not read — fares, translations, pathways — are counted here, because guessing a
    // row count from a header would be a claim we never measured.
    let rows: number;
    if (Object.hasOwn(measured, file)) {
      rows = measured[file]!;
    } else {
      rows = 0;
      if (present) {
        const text = zip.text(file);
        if (text !== null) for (const _record of csvRecords(text)) rows++;
      }
    }
    stmt.run(feedId, file, rows, present ? 0 : 1);
  }
  const extra = zip.names.filter((name) => !known.includes(name) && name.endsWith('.txt'));
  if (extra.length) {
    warnings.push(
      'noma’lum fayllar: ' +
        extra.slice(0, 10).join(', ') +
        (extra.length > 10 ? ' va yana ' + (extra.length - 10) : ''),
    );
  }
  return known.length;
}

/** Which feed a call means when the caller did not say: one feed is obvious, several is a question. */
export function resolveFeedId(db: SqliteLike, requested: string): string {
  const rows = prepared(db, 'select feed_id from feeds order by loaded_at_ms desc').all() as Array<{ feed_id: string }>;
  if (!rows.length) throw new Error('hech qanday GTFS feed yuklanmagan — avval pro_gtfs_load ishlating.');
  const wanted = requested.trim();
  if (!wanted) {
    if (rows.length === 1) return rows[0]!.feed_id;
    throw new Error(
      'bir nechta feed bor (' +
        rows.length +
        '): ' +
        rows.map((r) => r.feed_id).join(', ') +
        '. feed parametri bilan aniq ayting.',
    );
  }
  const exact = rows.find((row) => row.feed_id === wanted);
  if (exact) return exact.feed_id;
  const partial = rows.filter((row) => row.feed_id.includes(wanted));
  if (partial.length === 1) return partial[0]!.feed_id;
  throw new Error(
    'feed "' +
      wanted +
      '" ' +
      (partial.length > 1 ? 'bir nechtaga mos keladi: ' + partial.map((p) => p.feed_id).join(', ') : 'topilmadi') +
      '. Mavjudlar: ' +
      rows.map((r) => r.feed_id).join(', '),
  );
}

/** Great-circle metres — GTFS gives coordinates and nothing else, and a walking guess needs distance. */
export function haversineMeters(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6_371_000;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(s))));
}

/** Minutes since midnight for a `HH:MM` clock the caller typed (never past 24 hours). */
export function clockToMinutes(raw: string): number | null {
  const text = (raw ?? '').trim();
  const match = /^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?$/.exec(text);
  if (!match) return null;
  const hours = Number(match[1]);
  if (hours > 23) return null;
  return hours * 60 + Number(match[2]);
}

/** A clock a human reads, with the day offset named when the feed wrote 25:10. */
export function minutesToClock(minutes: number | null | undefined): string | null {
  if (minutes === null || minutes === undefined) return null;
  const day = Math.floor(minutes / 1440);
  const rest = minutes % 1440;
  const hh = String(Math.floor(rest / 60)).padStart(2, '0');
  const mm = String(rest % 60).padStart(2, '0');
  return day > 0 ? '+' + day + 'd ' + hh + ':' + mm : hh + ':' + mm;
}

/**
 * Which day of the week an ISO date is, as the `calendar.days` bit. Monday is bit 0.
 * Returns null for anything that is not a real date, because a guessed weekday would invent a timetable.
 */
export function dayBitOf(isoDate: string): number | null {
  const stamp = Date.parse(isoDate + 'T00:00:00Z');
  if (!Number.isFinite(stamp)) return null;
  const weekday = new Date(stamp).getUTCDay();
  return weekday === 0 ? 64 : 1 << (weekday - 1);
}

/** `2026-01-31` shifted by whole days. Rejects an input that is not a date. */
export function shiftIsoDate(isoDate: string, days: number): string | null {
  const stamp = Date.parse(isoDate + 'T00:00:00Z');
  if (!Number.isFinite(stamp)) return null;
  return new Date(stamp + days * 86_400_000).toISOString().slice(0, 10);
}

/** The machine's local date, for "now" questions that did not name a day. */
export function todayIso(): string {
  const now = new Date();
  return (
    now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0')
  );
}

/** Minutes since local midnight, ignoring seconds: a departure list is minute-granular. */
export function nowMinutes(): number {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

export interface RunningServices {
  date: string;
  weekday: string;
  services: string[];
  from_calendar: number;
  added_by_date: number;
  removed_by_date: number;
  date_rows: number;
}

const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Which service_ids run on one date.
 *
 * GTFS answers this in two places, and both have to be read: `calendar.txt` says a pattern runs on some
 * weekdays between two dates, `calendar_dates.txt` overrides single days — exception 1 runs a service the
 * pattern refuses (a holiday), exception 2 cancels one it allows (a strike). The pattern is applied
 * first and the exceptions after, because an exception for a specific date is the more precise
 * statement. A feed that carries only `calendar_dates.txt` is legal, and then the pattern side is simply
 * empty — reported as 0 rather than as an error.
 */
export function servicesOnDate(db: SqliteLike, feedId: string, date: string): RunningServices {
  const bit = dayBitOf(date);
  const pattern =
    bit === null
      ? []
      : (
          prepared(
            db,
            'select service_id from calendar where feed_id = ? and (days & ?) <> 0 and start_date <= ? and end_date >= ?',
          ).all(feedId, bit, date, date) as Array<{ service_id: string }>
        ).map((row) => row.service_id);
  const exceptions = prepared(
    db,
    'select service_id, exception from calendar_dates where feed_id = ? and date = ?',
  ).all(feedId, date) as Array<{ service_id: string; exception: number | null }>;

  const set = new Set(pattern);
  let added = 0;
  let removed = 0;
  for (const row of exceptions) {
    if (row.exception === 1) {
      if (!set.has(row.service_id)) added++;
      set.add(row.service_id);
    } else if (row.exception === 2) {
      if (set.delete(row.service_id)) removed++;
    }
  }
  const stamp = Date.parse(date + 'T00:00:00Z');
  return {
    date,
    weekday: Number.isFinite(stamp) ? WEEKDAY_NAMES[new Date(stamp).getUTCDay()]! : '(noma’lum)',
    services: [...set].sort(),
    from_calendar: pattern.length,
    added_by_date: added,
    removed_by_date: removed,
    date_rows: exceptions.length,
  };
}

export interface ServicePattern {
  service_id: string;
  weekdays: string[];
  start_date: string | null;
  end_date: string | null;
  /** Dates the pattern would run inside the window, capped at `limit`. */
  pattern_dates: string[];
  added: string[];
  removed: string[];
  /** The union a rider actually gets: pattern minus cancellations plus additions. */
  runs_on: string[];
  truncated: boolean;
  /** How many days the service really runs inside the window. `runs_on` may be shorter than this. */
  total_runs: number;
}

/** How many days one `service_dates` answer may walk before it stops and says so. */
export const MAX_PATTERN_DAYS = 400;

/**
 * The dates one service_id runs, from both halves of the calendar.
 *
 * `from`/`to` bound the walk because a service that runs to 2099 is not worth listing. When the pattern
 * row is missing entirely the service is defined only by its exceptions — a real shape for feeder
 * contracts — and `start_date`/`end_date` come back null instead of being invented from the exceptions.
 */
export function servicePattern(
  db: SqliteLike,
  feedId: string,
  serviceId: string,
  from: string,
  to: string,
  limit: number,
): ServicePattern {
  const row = prepared(db, 'select days, start_date, end_date from calendar where feed_id = ? and service_id = ?').get(
    feedId,
    serviceId,
  ) as { days: number; start_date: string; end_date: string } | undefined;
  const exceptions = prepared(
    db,
    'select date, exception from calendar_dates where feed_id = ? and service_id = ? and date between ? and ? order by date',
  ).all(feedId, serviceId, from, to) as Array<{ date: string; exception: number | null }>;

  const added = new Set(exceptions.filter((e) => e.exception === 1).map((e) => e.date));
  const removed = new Set(exceptions.filter((e) => e.exception === 2).map((e) => e.date));

  const weekdays: string[] = [];
  if (row) for (const [name, bit] of DAY_BITS) if ((row.days & bit) !== 0) weekdays.push(name);

  const patternDates: string[] = [];
  const runsOn: string[] = [];
  let insidePatternRemoved = 0;
  let addedOutsidePattern = 0;
  let cursor = from;
  let walked = 0;
  let truncated = false;
  while (cursor <= to && walked < MAX_PATTERN_DAYS) {
    const bit = dayBitOf(cursor);
    const inPattern =
      !!row && bit !== null && (row.days & bit) !== 0 && cursor >= row.start_date && cursor <= row.end_date;
    if (inPattern) {
      patternDates.push(cursor);
      if (removed.has(cursor)) insidePatternRemoved++;
    }
    if ((inPattern && !removed.has(cursor)) || added.has(cursor)) {
      if (!inPattern) addedOutsidePattern++;
      if (runsOn.length < limit) runsOn.push(cursor);
      else truncated = true;
    }
    const next = shiftIsoDate(cursor, 1);
    if (!next) break;
    cursor = next;
    walked++;
  }
  const totalRuns = patternDates.length - insidePatternRemoved + addedOutsidePattern;
  return {
    service_id: serviceId,
    weekdays,
    start_date: row?.start_date ?? null,
    end_date: row?.end_date ?? null,
    pattern_dates: patternDates,
    added: [...added].sort(),
    removed: [...removed].sort(),
    runs_on: runsOn,
    truncated,
    total_runs: totalRuns,
  };
}
