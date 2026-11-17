import { defineTool } from '../../core/tool.js';
import { jsonBlock } from '../../core/format.js';
import { float, num, strOrEmpty, view } from '../../core/input.js';
import { boundingBox, haversineMeters, openGtfsDb, prepared, resolveFeedId, type SqliteLike } from './_gtfs.js';

/** How many candidate rows one call may read. Reaching it is reported, never hidden. */
const SCAN_LIMIT = 50_000;

/**
 * pro_gtfs_stops — find stops, by name, by route, or by distance
 * Category: gtfs
 *
 * ## Why a radius is computed here instead of asked of the feed
 *
 * GTFS stores coordinates and nothing else. Distance between two points is not in the file, so a
 * "what is near me" question has to be answered by whoever read the file. The feed is already in
 * SQLite, so this is a scan over a few thousand rows with a great-circle formula — cheap, and honest
 * about being an approximation of walking distance rather than a routing result.
 *
 * ## Why the scan is bounded
 *
 * A radius is turned into the lat/lon box that contains it, so the database only hands over stops that
 * can possibly be inside the circle; the exact distance is then checked here. `SCAN_LIMIT` is a runaway
 * guard rather than the filter — a 20 km radius over a national feed can still match tens of thousands
 * of quays. Reaching it is reported in the answer, so "500 stops" is never mistaken for "the system has
 * 500 stops", and a box that was cut short says so instead of looking like an empty area.
 */
export default defineTool({
  name: 'pro_gtfs_stops',
  description:
    'GTFS bekalari: nom bo‘yicha qidirish, bir yo‘lning bekalari, yoki kenglik/uzunlik atrofida radius ' +
    'ichidagilar. Javobda stop_id, nom, koordinata va (near berilsa) metrdagi masofa qaytadi.',
  category: 'gtfs',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      feed: { type: 'string', description: 'Feed identifikatori; bitta feed bo‘lsa bo‘sh qoldirsa bo‘ladi' },
      query: { type: 'string', description: 'Beka nomida qidiriladigan matn (katta-kichik farqsiz)' },
      route: { type: 'string', description: 'Faqat shu yo‘l (route_id) bekalari' },
      near_lat: { type: 'number', description: 'Markaz kengligi (radius bilan birga ishlatiladi)' },
      near_lon: { type: 'number', description: 'Markaz uzunligi' },
      radius_m: { type: 'number', description: 'Radius metrda (standart 800, eng ko‘pi 20000)' },
      limit: { type: 'number', description: 'Qaytariladigan beka soni (standart 20, eng ko‘pi 500)' },
    },
    additionalProperties: false,
  },
  async handler(input) {
    const p = view(input);
    const db = await openGtfsDb();
    const feedId = resolveFeedId(db, strOrEmpty(p, 'feed'));

    const limit = Math.max(1, Math.min(500, Math.floor(num(p, 'limit', 20))));
    const query = strOrEmpty(p, 'query');
    const route = strOrEmpty(p, 'route');
    // Coordinates go through `float`, never `num`: `num` floors, and a floored latitude is a different
    // city — the radius would silently answer "nothing nearby" instead of "here are the stops".
    const lat = float(p, 'near_lat', Number.NaN);
    const lon = float(p, 'near_lon', Number.NaN);
    const radius = Math.max(1, Math.min(20_000, Math.floor(num(p, 'radius_m', 800))));
    const hasCenter = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

    if (route) {
      const rows = stopsOfRoute(db, feedId, route, limit);
      return jsonBlock('GTFS stops', {
        ok: true,
        feed_id: feedId,
        mode: 'route',
        route_id: route,
        count: rows.length,
        limit,
        stops: rows,
      });
    }

    /**
     * The candidate set, chosen in SQL.
     *
     * A radius question used to read the first 5,000 stops in table order and throw away the ones
     * outside the circle. On a city feed that is only wasteful. On Norway's national feed it was
     * wrong: 9,196 stops, measured, and the ones around Oslo were not among the first 5,000, so the
     * tool answered "nothing nearby" without saying anything was skipped. The box that contains the
     * circle is now part of the query, so the scan touches only stops that can be inside it — and the
     * answer reports how many were scanned, how many matched, and whether a cap was reached.
     *
     * `query` is matched as a plain substring. SQLite's LIKE treats % and _ as wildcards and has no
     * escape mechanism unless an escape character is declared, so a query containing % would have
     * widened the search rather than narrowed it. The cost of a literal % in a stop name is a slightly
     * wider result set, which is honest and rare.
     */
    const like = '%' + query + '%';
    const box = hasCenter ? boundingBox(lat, lon, radius) : null;
    const clauses = ['feed_id = ?'];
    const params: Array<string | number> = [feedId];
    if (query) {
      clauses.push('name like ?');
      params.push(like);
    }
    if (box) {
      clauses.push('lat between ? and ?');
      params.push(box.minLat, box.maxLat);
      // A box that wraps the antimeridian has no usable `between` clause (min > max would match
      // nothing), so longitude is left to the exact filter instead.
      if (!box.wraps) {
        clauses.push('lon between ? and ?');
        params.push(box.minLon, box.maxLon);
      }
    }
    const where = clauses.join(' and ');
    const rows = prepared(
      db,
      'select stop_id, name, lat, lon, wheelchair, parent from stops where ' + where + ' limit ?',
    ).all(...params, SCAN_LIMIT) as Array<{
      stop_id: string;
      name: string;
      lat: number;
      lon: number;
      wheelchair: string;
      parent: string;
    }>;
    const total = prepared(db, 'select count(*) as n from stops where ' + where).get(...params) as { n: number };
    const scannedAll = rows.length >= SCAN_LIMIT;

    if (!hasCenter) {
      return jsonBlock('GTFS stops', {
        ok: true,
        feed_id: feedId,
        mode: query ? 'name' : 'all',
        matched: total.n,
        scanned: rows.length,
        returned: Math.min(rows.length, limit),
        stops: rows.slice(0, limit),
        ...(total.n > limit ? { note: 'limit bilan kesildi: ' + total.n + ' ta mos beka bor' } : {}),
        ...(scannedAll ? { note: SCAN_LIMIT + ' beka skanerlandi — so‘rovni toraytiring' } : {}),
        ...(query ? { query } : {}),
      });
    }

    const inCircle = rows
      .map((row) => ({ ...row, distance_m: haversineMeters(lat, lon, row.lat, row.lon) }))
      .filter((row) => row.distance_m <= radius)
      .sort((a, b) => a.distance_m - b.distance_m);
    const withDistance = inCircle.slice(0, limit);

    return jsonBlock('GTFS stops', {
      ok: true,
      feed_id: feedId,
      mode: 'radius',
      center: { lat, lon },
      radius_m: radius,
      box: box
        ? { min_lat: box.minLat, max_lat: box.maxLat, min_lon: box.minLon, max_lon: box.maxLon, wraps: box.wraps }
        : null,
      scanned: rows.length,
      matched: inCircle.length,
      count: withDistance.length,
      stops: withDistance,
      ...(inCircle.length > limit ? { note: 'limit bilan kesildi: ' + inCircle.length + ' ta beka radiusda bor' } : {}),
      ...(scannedAll ? { note: SCAN_LIMIT + ' beka skanerlandi — radiusni kichraytiring' } : {}),
    });
  },
});

/** Stops of one route in the order a vehicle passes them, with the first arrival time per stop. */
function stopsOfRoute(db: SqliteLike, feedId: string, routeId: string, limit: number): Array<Record<string, unknown>> {
  return prepared(
    db,
    `select s.stop_id, s.name, s.lat, s.lon, min(st.arrival_min) as first_arrival_min, count(distinct st.trip_id) as trips
         from stop_times st
         join trips t on t.feed_id = st.feed_id and t.trip_id = st.trip_id
         join stops s on s.feed_id = st.feed_id and s.stop_id = st.stop_id
        where st.feed_id = ? and t.route_id = ?
        group by s.stop_id
        order by first_arrival_min
        limit ?`,
  ).all(feedId, routeId, limit) as Array<Record<string, unknown>>;
}
