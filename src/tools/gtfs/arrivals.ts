import { defineTool } from '../../core/tool.js';
import { jsonBlock } from '../../core/format.js';
import { num, strOrEmpty, view } from '../../core/input.js';
import {
  clockToMinutes,
  minutesToClock,
  nowMinutes,
  openGtfsDb,
  prepared,
  resolveFeedId,
  servicesOnDate,
  shiftIsoDate,
} from './_gtfs.js';

/**
 * pro_gtfs_arrivals — what leaves a stop in the next while
 * Category: gtfs
 *
 * ## The trap this tool exists to avoid
 *
 * GTFS writes a trip that starts before midnight and finishes after it with hours past 24: `25:10:00`
 * is 01:10 of the next morning. A naive "next departures" query comparing those minutes against the
 * clock at 00:30 puts the trip hours in the future, when it left before midnight; the same query for
 * 23:50 misses yesterday's sleeper that arrives at 01:10 today. So every answer here is built from two
 * services days:
 *
 * - services running **today** with a departure minute inside the window (00:00–23:59), and
 * - services running **yesterday** with a departure minute of 1440 + the window — the legs of
 *   yesterday's run that happen during today's early hours.
 *
 * Each departure says which service day it belongs to and what the feed wrote, so nothing is smoothed
 * over. Both halves are filtered by the calendar, so a trip nobody runs today is never listed.
 *
 * ## What is not here yet
 *
 * `frequencies.txt` describes buses that run every N minutes instead of timed stops. Those departures
 * are not invented: the answer says when the stop has frequency-scheduled trips so the caller knows the
 * list is incomplete for that stop, rather than presenting the timed subset as the whole truth.
 */
export default defineTool({
  name: 'pro_gtfs_arrivals',
  description:
    'Bekadan chiqadigan reyslar: vaqt oynasi ichida, yurish kunlari (calendar + calendar_dates) bilan ' +
    'filtrlangan. Kechaga o‘tgan 25:10 vaqtlar ham to‘g‘ri hisobgaolinadi; har javobda qaysi xizmat ' +
    'kuniga tegishli ekanligi yoziladi.',
  category: 'gtfs',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      feed: { type: 'string', description: 'Feed identifikatori; bitta feed bo‘lsa bo‘sh qoldirsa bo‘ladi' },
      stop: { type: 'string', description: 'stop_id (pro_gtfs_stops orqali topiladi)' },
      date: { type: 'string', description: 'YYYY-MM-DD (standart: bugun)' },
      at: { type: 'string', description: 'HH:MM — qaysi vaqtdan boshlab (standart: hozir)' },
      window_min: { type: 'number', description: 'Necha daqiqlik oyna (standart 60, eng ko‘pi 720)' },
      route: { type: 'string', description: 'Faqat shu yo‘l (route_id) bo‘yicha' },
      limit: { type: 'number', description: 'Eng ko‘pi nechta qatnov (standart 20, eng ko‘pi 200)' },
    },
    required: ['stop'],
    additionalProperties: false,
  },
  async handler(input) {
    const p = view(input);
    const db = await openGtfsDb();
    const feedId = resolveFeedId(db, strOrEmpty(p, 'feed'));
    const stop = strOrEmpty(p, 'stop');
    const route = strOrEmpty(p, 'route');
    const window = Math.max(1, Math.min(720, Math.floor(num(p, 'window_min', 60))));
    const limit = Math.max(1, Math.min(200, Math.floor(num(p, 'limit', 20))));
    const date = isoDate(strOrEmpty(p, 'date'));
    const at = clockToMinutes(strOrEmpty(p, 'at'));
    const fromMinute = at ?? nowMinutes();

    const stopRow = prepared(db, 'select name, lat, lon from stops where feed_id = ? and stop_id = ?').get(
      feedId,
      stop,
    ) as { name: string; lat: number; lon: number } | undefined;
    if (!stopRow) {
      return jsonBlock('GTFS arrivals', {
        ok: false,
        feed_id: feedId,
        error: 'beka topilmadi: ' + stop,
        note: 'pro_gtfs_stops bilan nom yoki koordinata bo‘yicha izlab ko‘ring',
      });
    }

    const today = servicesOnDate(db, feedId, date);
    const yesterday = servicesOnDate(db, feedId, shiftIsoDate(date, -1) ?? date);

    const departures: Array<Record<string, unknown>> = [];
    for (const [day, running, low, high, offset] of [
      [date, today.services, fromMinute, Math.min(1439, fromMinute + window), 0] as const,
      [shiftIsoDate(date, -1) ?? date, yesterday.services, 1440 + fromMinute, 1440 + fromMinute + window, -1] as const,
    ]) {
      if (!running.length) continue;
      const marks = running.map(() => '?').join(',');
      const clauses = [
        'st.feed_id = ?',
        'st.stop_id = ?',
        'st.departure_min between ? and ?',
        't.service_id in (' + marks + ')',
      ];
      const params: Array<string | number> = [feedId, stop, low, high, ...running];
      if (route) {
        clauses.push('t.route_id = ?');
        params.push(route);
      }
      const rows = prepared(
        db,
        'select st.trip_id as trip_id, st.stop_sequence as seq, st.arrival_min as arrival_min, st.departure_min as departure_min, ' +
          'st.departure_raw as departure_raw, st.arrival_raw as arrival_raw, t.route_id as route_id, t.headsign as headsign, ' +
          't.service_id as service_id, r.short_name as short_name, r.long_name as long_name, r.type as type ' +
          'from stop_times st join trips t on t.feed_id = st.feed_id and t.trip_id = st.trip_id ' +
          'join routes r on r.feed_id = t.feed_id and r.route_id = t.route_id ' +
          'where ' +
          clauses.join(' and ') +
          ' order by st.departure_min limit ?',
      ).all(...params, limit) as Array<Record<string, unknown>>;
      for (const row of rows) {
        const absolute = Number(row.departure_min) + offset * 1440;
        departures.push({
          trip_id: row.trip_id,
          route_id: row.route_id,
          short_name: row.short_name,
          long_name: row.long_name,
          route_type: row.type,
          headsign: row.headsign,
          service_id: row.service_id,
          stop_sequence: row.seq,
          departure: minutesToClock(Number(row.departure_min)),
          departure_raw: row.departure_raw,
          arrival: minutesToClock(row.arrival_min === null ? null : Number(row.arrival_min)),
          service_day: day,
          day_offset: offset,
          minutes_until: absolute - fromMinute,
        });
      }
    }

    departures.sort((a, b) => Number(a.minutes_until) - Number(b.minutes_until));
    const hasFrequencies = prepared(
      db,
      'select exists(select 1 from frequencies f join stop_times st on st.feed_id = f.feed_id and st.trip_id = f.trip_id ' +
        'where f.feed_id = ? and st.stop_id = ?) as any',
    ).get(feedId, stop) as { any: number };

    return jsonBlock('GTFS arrivals', {
      ok: true,
      feed_id: feedId,
      stop: { stop_id: stop, name: stopRow.name, lat: stopRow.lat, lon: stopRow.lon },
      date,
      from_clock: minutesToClock(fromMinute),
      window_min: window,
      services_today: today.services.length,
      services_yesterday: yesterday.services.length,
      matched: departures.length,
      returned: Math.min(departures.length, limit),
      departures: departures.slice(0, limit),
      ...(departures.some((row) => Number(row.day_offset) < 0)
        ? { note: 'ba’zi qatnovlar kechagi xizmat kunining yarim tundan keyingi qismi' }
        : {}),
      ...(hasFrequencies.any
        ? { note: 'bu bekada frequencies.txt bilan yuradigan qatnovlar bor — ular ro‘yxatda emas' }
        : {}),
      ...(today.services.length === 0 && yesterday.services.length === 0
        ? { note: 'bugun ham, kecha ham hech qanday xizmat yurmaydi — calendar.txt va calendar_dates.txt tekshirildi' }
        : {}),
    });
  },
});

/** A real `YYYY-MM-DD`, defaulting to today when the caller left it out or typed something else. */
function isoDate(raw: string): string {
  const text = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text) && Number.isFinite(Date.parse(text + 'T00:00:00Z'))) return text;
  const now = new Date();
  return (
    now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0')
  );
}
