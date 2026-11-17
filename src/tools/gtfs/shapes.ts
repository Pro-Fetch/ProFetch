import { defineTool } from '../../core/tool.js';
import { jsonBlock } from '../../core/format.js';
import { bool, num, strOrEmpty, view } from '../../core/input.js';
import { openGtfsDb, prepared, resolveFeedId, type SqliteLike } from './_gtfs.js';
import { distCheck, pathLengthMeters, shapeBounds, simplifyShape, type ShapePoint } from './_shapes.js';

/**
 * pro_gtfs_shapes — the line a vehicle draws on a map
 * Category: gtfs
 *
 * Reachable by trip, by shape_id, or by route (every distinct shape a line's trips use). The length is
 * measured from the points, and when the feed also declared `shape_dist_traveled` the two are compared
 * and the difference reported — a polyline that cuts corners and a distance column that follows the road
 * are both normal, and saying which one you got is the difference between data and a guess.
 *
 * A national feed can hold nearly a million shape points (953,314 in the file this was measured on), so
 * `simplify_m` reduces the path to a metre tolerance before it is returned, and the returned count is
 * always paired with the real total.
 */
export default defineTool({
  name: 'pro_gtfs_shapes',
  description:
    'GTFS shapes (y‘l chizig‘i): trip_id, shape_id yoki route_id bo‘yicha nuqtalar, uzunlik metrda, ' +
    'chegarav (bbox), va ixtiyoriy soddalashtirish (Douglas–Peucker, metr bilan). Javobda nechta nuqta ' +
    'borligi va nechta qaytgani alohida yoziladi.',
  category: 'gtfs',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      feed: { type: 'string', description: 'Feed identifikatori; bitta feed bo‘lsa bo‘sh qoldirsa bo‘ladi' },
      trip: { type: 'string', description: 'trip_id — shu reysning shape_id si' },
      shape: { type: 'string', description: 'shape_id — to‘g‘ridan-to‘g‘ri so‘rash' },
      route: { type: 'string', description: 'route_id — shu yo‘l ishlatadigan barcha shape‘lar' },
      simplify_m: { type: 'number', description: 'Metrda chalkashlik (0 = o‘chirilgan, standart 50)' },
      max_points: { type: 'number', description: 'Qaytariladigan eng ko‘p nuqta (standart 1000, eng ko‘pi 5000)' },
      geojson: { type: 'boolean', description: 'true — koordinatalar [lon, lat] juftliklarida ham qaytadi' },
    },
    additionalProperties: false,
  },
  async handler(input) {
    const p = view(input);
    const db = await openGtfsDb();
    const feedId = resolveFeedId(db, strOrEmpty(p, 'feed'));
    const trip = strOrEmpty(p, 'trip');
    const shape = strOrEmpty(p, 'shape');
    const route = strOrEmpty(p, 'route');
    const tolerance = Math.max(0, Math.min(5_000, num(p, 'simplify_m', 50)));
    const maxPoints = Math.max(2, Math.min(5_000, Math.floor(num(p, 'max_points', 1_000))));
    const wantGeoJson = bool(p, 'geojson', false);

    const shapeIds = wantedShapes(db, feedId, { trip, shape, route });
    if (!shapeIds.length) {
      return jsonBlock('GTFS shapes', {
        ok: false,
        feed_id: feedId,
        error: 'shape topilmadi',
        asked: { trip, shape, route },
        note: 'trip, shape yoki route dan birini bering — pro_gtfs_trip yo‘l berilganida shape_id chiqadi',
      });
    }

    const out = [] as Array<Record<string, unknown>>;
    for (const shapeId of shapeIds.slice(0, 20)) {
      const rows = prepared(
        db,
        'select shape_id, seq, lat, lon, dist from shapes where feed_id = ? and shape_id = ? order by seq limit ?',
      ).all(feedId, shapeId, 500_000) as Array<{
        shape_id: string;
        seq: number;
        lat: number;
        lon: number;
        dist: number | null;
      }>;
      const full: ShapePoint[] = rows.map((row) => ({ seq: row.seq, lat: row.lat, lon: row.lon, dist: row.dist }));
      if (full.length < 2) {
        out.push({ shape_id: shapeId, points: 0, note: 'shape yetarli emas (kamida 2 nuqta kerak)' });
        continue;
      }
      const lengthMeters = pathLengthMeters(full);
      const simplified = simplifyShape(full, tolerance);
      const shown = simplified.slice(0, maxPoints);
      out.push({
        shape_id: shapeId,
        points_total: full.length,
        points_after_simplify: simplified.length,
        points_returned: shown.length,
        tolerance_m: tolerance,
        length_m: Math.round(lengthMeters),
        ...distCheck(full, lengthMeters),
        bounds: shapeBounds(full),
        points: shown.map((point) => ({ seq: point.seq, lat: point.lat, lon: point.lon, dist: point.dist })),
        ...(wantGeoJson
          ? { geometry: { type: 'LineString', coordinates: shown.map((point) => [point.lon, point.lat]) } }
          : {}),
        ...(simplified.length > maxPoints
          ? { note: 'max_points bilan kesildi: ' + simplified.length + ' ta nuqta siqilgan' }
          : {}),
      });
    }

    return jsonBlock('GTFS shapes', {
      ok: true,
      feed_id: feedId,
      shapes_matched: shapeIds.length,
      shapes_returned: out.length,
      ...(shapeIds.length > 20 ? { note: '20 ta shape bilan cheklandi: ' + shapeIds.length + ' ta topildi' } : {}),
      shapes: out,
    });
  },
});

/**
 * Which shapes the caller means.
 *
 * An empty `shape_id` is a legitimate value in real feeds (a trip with no drawn path); it is filtered out
 * here rather than becoming a query for every shapeless trip in the database.
 */
function wantedShapes(db: SqliteLike, feedId: string, asked: { trip: string; shape: string; route: string }): string[] {
  if (asked.shape) return [asked.shape];
  if (asked.trip) {
    const row = prepared(db, 'select shape_id from trips where feed_id = ? and trip_id = ?').get(feedId, asked.trip) as
      { shape_id: string } | undefined;
    return row?.shape_id ? [row.shape_id] : [];
  }
  if (asked.route) {
    const rows = prepared(
      db,
      "select distinct t.shape_id as shape_id from trips t where t.feed_id = ? and t.route_id = ? and t.shape_id <> '' order by t.shape_id",
    ).all(feedId, asked.route) as Array<{ shape_id: string }>;
    return rows.map((row) => row.shape_id);
  }
  return [];
}
