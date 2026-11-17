import { defineTool } from '../../core/tool.js';
import { jsonBlock } from '../../core/format.js';
import { num, strOrEmpty, view } from '../../core/input.js';
import { minutesToClock, openGtfsDb, prepared, resolveFeedId, servicePattern, todayIso } from './_gtfs.js';

/** ISO date, or the machine's today when the caller did not name one. */
function dateOrToday(raw: string): string {
  const text = raw.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : todayIso();
}

/**
 * pro_gtfs_trip — one vehicle run, stop by stop
 * Category: gtfs
 *
 * ## Why the raw time is kept next to the number
 *
 * A trip that leaves at 23:50 and finishes at 00:40 is written by the feed as `00:40:00` on the row
 * after `25:50:00`-style overflow only when the publisher got it right. Both the string the feed used
 * and the minutes we read from it are returned, because "01:10" and "25:10" mean different days to a
 * rider and the tool must not silently choose one.
 *
 * ## Why the service pattern comes back with the trip
 *
 * `trips.txt` names a `service_id`, and a service id on its own tells nobody which dates the trip runs.
 * Answering "does this train run on Sunday" without joining `calendar.txt` and `calendar_dates.txt` is
 * how a timetable tool sends someone to a platform for a service that was cancelled for that date.
 */
export default defineTool({
  name: 'pro_gtfs_trip',
  description:
    'GTFS reysi: trip_id berilsa to‘liq yo‘li (bekatlar ketma-ketligi, kelish/chiqish vaqtlari, ' +
    '25:10 kabi kech vaqtlar ham to‘g‘ri) va qaysi kunlari yurishi; route berilsa shu yo‘lning ' +
    'reyslari ro‘yxati.',
  category: 'gtfs',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      feed: { type: 'string', description: 'Feed identifikatori; bitta feed bo‘lsa bo‘sh qoldirsa bo‘ladi' },
      trip: { type: 'string', description: 'trip_id (to‘liq yoki noyob qismi)' },
      route: { type: 'string', description: 'route_id — shu yo‘lning reyslarini ro‘yxat qiladi' },
      stops_limit: { type: 'number', description: 'Ro‘yxatga olinadigan bekatlar soni (standart 200, eng ko‘pi 2000)' },
      limit: { type: 'number', description: 'route rejimida nechta reys (standart 50, eng ko‘pi 500)' },
      date: { type: 'string', description: 'Qaysi kun uchun xizmat tekshiriladi (YYYY-MM-DD, standart: bugun)' },
    },
    additionalProperties: false,
  },
  async handler(input) {
    const p = view(input);
    const db = await openGtfsDb();
    const feedId = resolveFeedId(db, strOrEmpty(p, 'feed'));
    const wantedTrip = strOrEmpty(p, 'trip').trim();
    const routeFilter = strOrEmpty(p, 'route').trim();
    const stopsLimit = Math.max(1, Math.min(2_000, Math.floor(num(p, 'stops_limit', 200))));
    const tripLimit = Math.max(1, Math.min(500, Math.floor(num(p, 'limit', 50))));
    const date = dateOrToday(strOrEmpty(p, 'date'));

    if (!wantedTrip && routeFilter) {
      const listed = prepared(
        db,
        'select t.trip_id as trip_id, t.headsign as headsign, t.service_id as service_id, t.direction as direction, ' +
          'count(st.stop_id) as stops, min(st.departure_min) as first_dep, max(st.arrival_min) as last_arr ' +
          'from trips t left join stop_times st on st.feed_id = t.feed_id and st.trip_id = t.trip_id ' +
          'where t.feed_id = ? and t.route_id = ? group by t.trip_id order by first_dep, t.trip_id limit ?',
      ).all(feedId, routeFilter, tripLimit) as Array<{
        trip_id: string;
        headsign: string;
        service_id: string;
        direction: string;
        stops: number;
        first_dep: number | null;
        last_arr: number | null;
      }>;
      return jsonBlock('GTFS trip', {
        ok: listed.length > 0,
        feed_id: feedId,
        mode: 'trips',
        route_id: routeFilter,
        total: listed.length,
        returned: Math.min(listed.length, tripLimit),
        trips: listed.map((row) => ({
          trip_id: row.trip_id,
          headsign: row.headsign,
          service_id: row.service_id,
          direction: row.direction,
          stops: row.stops,
          first_departure: minutesToClock(row.first_dep),
          last_arrival: minutesToClock(row.last_arr),
        })),
        ...(listed.length ? {} : { error: 'bu yo‘lda reys yo‘q yoki route_id topilmadi: ' + routeFilter }),
        ...(listed.length >= tripLimit ? { note: 'limit bilan kesildi: ' + tripLimit + ' ta reys ko‘rsatildi' } : {}),
      });
    }
    if (!wantedTrip) {
      return jsonBlock('GTFS trip', {
        ok: false,
        feed_id: feedId,
        error: 'trip yoki route kerak — trip_id berilsa bitta reys, route berilsa ro‘yxat qaytadi',
      });
    }

    const trips = prepared(
      db,
      'select trip_id, route_id, service_id, headsign, shape_id, direction from trips where feed_id = ? and trip_id = ?',
    ).all(feedId, wantedTrip) as Array<{
      trip_id: string;
      route_id: string;
      service_id: string;
      headsign: string;
      shape_id: string;
      direction: string;
    }>;

    if (!trips.length) {
      const guesses = prepared(db, 'select trip_id from trips where feed_id = ? and trip_id like ? limit 8').all(
        feedId,
        '%' + wantedTrip + '%',
      ) as Array<{ trip_id: string }>;
      return jsonBlock('GTFS trip', {
        ok: false,
        feed_id: feedId,
        error: 'trip topilmadi: ' + wantedTrip,
        ...(guesses.length ? { yaqin_namunalar: guesses.map((row) => row.trip_id) } : {}),
      });
    }
    const trip = trips[0];

    const route = prepared(
      db,
      'select route_id, short_name, long_name, type from routes where feed_id = ? and route_id = ?',
    ).get(feedId, trip.route_id) as { route_id: string; short_name: string; long_name: string; type: string };

    const rows = prepared(
      db,
      'select st.stop_sequence as seq, st.stop_id as stop_id, s.name as name, st.arrival_raw as arrival_raw, ' +
        'st.arrival_min as arrival_min, st.departure_raw as departure_min_raw, st.departure_min as departure_min, ' +
        'st.pickup as pickup, st.drop_off as drop_off, st.dist as dist ' +
        'from stop_times st left join stops s on s.feed_id = st.feed_id and s.stop_id = st.stop_id ' +
        'where st.feed_id = ? and st.trip_id = ? order by st.stop_sequence, st.arrival_min limit ?',
    ).all(feedId, trip.trip_id, stopsLimit) as Array<{
      seq: number | null;
      stop_id: string;
      name: string;
      arrival_raw: string;
      arrival_min: number | null;
      departure_min_raw: string;
      departure_min: number | null;
      pickup: string;
      drop_off: string;
      dist: number | null;
    }>;

    const first = rows.length ? rows[0] : undefined;
    const last = rows.length ? rows[rows.length - 1] : undefined;
    const startMin = first ? (first.departure_min ?? first.arrival_min) : null;
    const endMin = last ? (last.arrival_min ?? last.departure_min) : null;
    const runs = servicePattern(db, feedId, trip.service_id, date, date, 1);

    return jsonBlock('GTFS trip', {
      ok: true,
      mode: 'trip',
      feed_id: feedId,
      trip_id: trip.trip_id,
      route: {
        route_id: route?.route_id ?? trip.route_id,
        short_name: route?.short_name ?? '',
        long_name: route?.long_name ?? '',
        type: route?.type ?? '',
      },
      headsign: trip.headsign,
      direction: trip.direction,
      shape_id: trip.shape_id,
      service: { service_id: trip.service_id, runs_on_this_date: runs.runs_on.length > 0 },
      date,
      stops_total: rows.length,
      stops_returned: Math.min(rows.length, stopsLimit),
      duration_min: startMin !== null && endMin !== null ? endMin - startMin : null,
      past_midnight: (endMin ?? 0) >= 1440,
      stops: rows.map((row) => ({
        stop_sequence: row.seq,
        stop_id: row.stop_id,
        name: row.name,
        arrival: minutesToClock(row.arrival_min),
        arrival_raw: row.arrival_raw,
        departure: minutesToClock(row.departure_min),
        departure_raw: row.departure_min_raw,
        pickup: row.pickup,
        drop_off: row.drop_off,
        shape_dist: row.dist,
      })),
      ...(rows.length >= stopsLimit ? { note: 'stops_limit bilan kesildi: ' + stopsLimit + ' beka' } : {}),
      ...(first && first.arrival_min === null
        ? { note: 'birinchi bekada kelish vaqti yo‘q — bu reysning boshlanish bekasi' }
        : {}),
    });
  },
});
