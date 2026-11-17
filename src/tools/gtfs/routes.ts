import { defineTool } from '../../core/tool.js';
import { jsonBlock } from '../../core/format.js';
import { num, strOrEmpty, view } from '../../core/input.js';
import { minutesToClock, openGtfsDb, prepared, resolveFeedId, type SqliteLike } from './_gtfs.js';

/**
 * `route_type` as a rider names it. GTFS defines the numbers; the words are ours, and a feed with an
 * extended type (100-799 in the GTFS Route Type extension) reports the number as well so nothing is
 * quietly labelled "other".
 */
const ROUTE_TYPES: Record<number, string> = {
  0: 'tram',
  1: 'metro',
  2: 'rail',
  3: 'bus',
  4: 'ferry',
  5: 'cable car',
  6: 'gondola',
  7: 'funicular',
  11: 'trolleybus',
  12: 'minibus',
  100: 'airlift',
  170: 'horse carriage',
  200: 'coach',
  400: 'metro (extension)',
  700: 'bus (extension)',
  900: 'tram (extension)',
  1000: 'passenger rail',
  1100: 'rail (extension)',
  1200: 'ferry (extension)',
  1300: 'air service (extension)',
  1500: 'taxi (extension)',
  1700: 'self-service bike (extension)',
};

/**
 * pro_gtfs_routes — the lines of a feed, with the size of each one
 * Category: gtfs
 *
 * ## Why this is not just `select * from routes`
 *
 * `routes.txt` says a line exists. What a caller actually wants to know is whether it is worth asking
 * about: how many trips it runs, how many stops it touches, when its first and last vehicle leave. None
 * of that is in the file — it is a count over `trips` and `stop_times`, so it is computed here once and
 * reported as measured rather than left for every caller to rediscover.
 *
 * ## What "first" and "last" departure mean
 *
 * The earliest and latest departure minute anywhere on the line, not the first and last trip from the
 * origin. A line whose terminus is fifteen minutes downstream has a vehicle leaving the terminus later
 * than it left the start, and printing only the origin's time would hide the last ride of the day. The
 * feed's own past-midnight minutes are kept, so a night line's last departure reads `+1d 01:20` and is
 * flagged with `past_midnight`.
 *
 * ## Why the aggregate query is limited to the returned page
 *
 * A grouped pass over `stop_times` reads every row of the biggest table in the feed. With a 12 MB
 * national feed that is 98,584 rows and is fine; a metropolitan feed can hold tens of millions, and
 * then asking for 50 routes should not scan all of them. So the aggregate runs over the page that is
 * about to be returned, in chunks small enough for SQLite's variable limit.
 */
export default defineTool({
  name: 'pro_gtfs_routes',
  description:
    'GTFS yo‘llari (lines): qisqa/uzun nomi, turi, rangi, necha reysi va beki bor, birinchi va oxirgi ' +
    'chiqish vaqti (yo‘lning ISTALGAN bekasida eng erta va eng kech chiqish). query, route_type yoki ' +
    'via_stop bilan toraytiriladi.',
  category: 'gtfs',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      feed: { type: 'string', description: 'Feed identifikatori; bitta feed bo‘lsa bo‘sh qoldirsa bo‘ladi' },
      query: { type: 'string', description: 'Yo‘l nomida qidiriladigan matn (qisqa yoki uzun nomda)' },
      route_type: {
        type: 'number',
        description: 'Faqat shu turdagi yo‘llar (0 tram, 1 metro, 2 poyez, 3 avtobus, 4 parom)',
      },
      via_stop: { type: 'string', description: 'Faqat shu bekaga uchraydigan yo‘llar (stop_id)' },
      limit: { type: 'number', description: 'Qaytariladigan yo‘llar soni (standart 50, eng ko‘pi 500)' },
    },
    additionalProperties: false,
  },
  async handler(input) {
    const p = view(input);
    const db = await openGtfsDb();
    const feedId = resolveFeedId(db, strOrEmpty(p, 'feed'));
    const query = strOrEmpty(p, 'query').toLowerCase();
    const viaStop = strOrEmpty(p, 'via_stop');
    const wantedType = num(p, 'route_type', Number.NaN);
    const limit = Math.max(1, Math.min(500, Math.floor(num(p, 'limit', 50))));

    const all = prepared(
      db,
      'select route_id, agency_id, short_name, long_name, type, color, text_color, url from routes where feed_id = ? order by route_id',
    ).all(feedId) as Array<{
      route_id: string;
      agency_id: string;
      short_name: string;
      long_name: string;
      type: string;
      color: string;
      text_color: string;
      url: string;
    }>;

    const servedByStop = viaStop
      ? new Set(
          (
            prepared(
              db,
              'select distinct t.route_id as route_id from stop_times st join trips t on t.feed_id = st.feed_id and t.trip_id = st.trip_id where st.feed_id = ? and st.stop_id = ?',
            ).all(feedId, viaStop) as Array<{ route_id: string }>
          ).map((row) => row.route_id),
        )
      : null;

    const matchedRows = all.filter((row) => {
      if (query && !(row.short_name + ' ' + row.long_name).toLowerCase().includes(query)) return false;
      if (Number.isFinite(wantedType) && Number(row.type) !== wantedType) return false;
      if (servedByStop && !servedByStop.has(row.route_id)) return false;
      return true;
    });

    const page = matchedRows.slice(0, limit);
    const sizes = await routeSizes(
      db,
      feedId,
      page.map((row) => row.route_id),
    );
    const agencies = new Map(
      (
        prepared(db, 'select agency_id, name from agencies where feed_id = ?').all(feedId) as Array<{
          agency_id: string;
          name: string;
        }>
      ).map((row) => [row.agency_id, row.name]),
    );
    const onlyAgency = agencies.size === 1 ? [...agencies.values()][0] : undefined;

    return jsonBlock('GTFS routes', {
      ok: true,
      feed_id: feedId,
      total_routes: all.length,
      matched: matchedRows.length,
      returned: page.length,
      routes: page.map((row) => {
        const size = sizes.get(row.route_id) ?? { trips: 0, stops: 0, first: null, last: null };
        const typeNumber = Number(row.type);
        return {
          route_id: row.route_id,
          short_name: row.short_name,
          long_name: row.long_name,
          type: row.type,
          type_name: ROUTE_TYPES[typeNumber] ?? (Number.isFinite(typeNumber) ? 'type ' + row.type : ''),
          color: row.color,
          text_color: row.text_color,
          url: row.url,
          agency: row.agency_id ? (agencies.get(row.agency_id) ?? '') : (onlyAgency ?? ''),
          trips: size.trips,
          stops: size.stops,
          first_departure: minutesToClock(size.first),
          last_departure: minutesToClock(size.last),
          ...(size.last !== null && size.last >= 1440 ? { past_midnight: true } : {}),
        };
      }),
      ...(page.length < matchedRows.length
        ? { note: 'limit bilan kesildi: ' + matchedRows.length + ' ta yo‘l mos keladi' }
        : {}),
      ...(viaStop && servedByStop && servedByStop.size === 0
        ? { note: 'bekga hech qanday yo‘l uchramaydi: ' + viaStop }
        : {}),
    });
  },
});

/** Chunked so a page of 500 routes cannot exceed SQLite's bound-variable limit. */
const CHUNK = 200;

interface RouteSize {
  trips: number;
  stops: number;
  first: number | null;
  last: number | null;
}

/**
 * Trips, distinct stops and the outer departure minutes of each named route.
 *
 * The departure minutes come from `departure_min`, which is what the feed wrote — including values past
 * 1440 for a service that leaves after midnight. Those are reported with their day offset instead of
 * being folded back into the morning, which would make the last vehicle of the day look like the first.
 */
async function routeSizes(db: SqliteLike, feedId: string, routeIds: string[]): Promise<Map<string, RouteSize>> {
  const found = new Map<string, RouteSize>();
  for (let start = 0; start < routeIds.length; start += CHUNK) {
    const slice = routeIds.slice(start, start + CHUNK);
    if (!slice.length) continue;
    const marks = slice.map(() => '?').join(',');
    const rows = prepared(
      db,
      'select t.route_id as route_id, count(distinct t.trip_id) as trips, count(distinct st.stop_id) as stops, ' +
        'min(st.departure_min) as first_dep, max(st.departure_min) as last_dep ' +
        'from trips t left join stop_times st on st.feed_id = t.feed_id and st.trip_id = t.trip_id ' +
        'where t.feed_id = ? and t.route_id in (' +
        marks +
        ') group by t.route_id',
    ).all(feedId, ...slice) as Array<{
      route_id: string;
      trips: number;
      stops: number;
      first_dep: number | null;
      last_dep: number | null;
    }>;
    for (const row of rows) {
      found.set(row.route_id, {
        trips: row.trips,
        stops: row.stops,
        first: row.first_dep,
        last: row.last_dep,
      });
    }
  }
  return found;
}
