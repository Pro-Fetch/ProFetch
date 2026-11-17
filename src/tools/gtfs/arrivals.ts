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
  type SqliteLike,
} from './_gtfs.js';
import { boardingsAtStop } from './_departures.js';

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
 * services days, converted to minutes from midnight of the asked date:
 *
 * - services running on the date itself, and
 * - services running the day before, whose past-midnight minutes fall into this morning.
 *
 * Each departure names its service day and carries `day_offset`, and both halves are filtered by the
 * calendar, so a trip nobody runs today is never listed.
 *
 * ## Headways are on the board
 *
 * `frequencies.txt` describes vehicles that run every N minutes rather than at listed clocks. Those
 * departures are generated and marked `generated: true` with their headway, because a board that hides
 * them is worse than a board that says a bus comes every 12 minutes. See `_departures.ts` for how the
 * offset from the trip's origin is applied.
 */
export default defineTool({
  name: 'pro_gtfs_arrivals',
  description:
    'Bekadan chiqadigan qatnovlar: vaqt oynasi ichida, yurish kunlari (calendar + calendar_dates) bilan ' +
    'filtrlangan va frequencies.txt boshliqlari ochilgan holda. Kechaga o‘tgan 25:10 vaqtlar ham to‘g‘ri ' +
    'hisoblanadi; har qatnov qaysi xizmat kuniga tegishli ekanligi bilan qaytadi.',
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
    const windowMin = Math.max(1, Math.min(720, Math.floor(num(p, 'window_min', 60))));
    const limit = Math.max(1, Math.min(200, Math.floor(num(p, 'limit', 20))));
    const date = isoDate(strOrEmpty(p, 'date'));
    const at = clockToMinutes(strOrEmpty(p, 'at'));
    const fromMinute = at ?? nowMinutes();

    const stopRow = preparedStop(db, feedId, stop);
    if (!stopRow) {
      return jsonBlock('GTFS arrivals', {
        ok: false,
        feed_id: feedId,
        error: 'beka topilmadi: ' + stop,
        note: 'pro_gtfs_stops bilan nom yoki koordinata bo‘yicha izlab ko‘ring',
      });
    }

    const scan = boardingsAtStop(db, feedId, stop, date, fromMinute, fromMinute + windowMin, {
      route: route || undefined,
      limit: 400,
    });
    const shown = scan.boards.slice(0, limit);
    const today = servicesOnDate(db, feedId, date);
    const yesterday = servicesOnDate(db, feedId, shiftIsoDate(date, -1) ?? date);

    return jsonBlock('GTFS arrivals', {
      ok: true,
      feed_id: feedId,
      stop: { stop_id: stop, name: stopRow.name, lat: stopRow.lat, lon: stopRow.lon },
      date,
      from_clock: minutesToClock(fromMinute),
      window_min: windowMin,
      services_today: today.services.length,
      services_yesterday: yesterday.services.length,
      scanned: scan.scanned,
      matched: scan.boards.length,
      returned: shown.length,
      departures: shown.map((row) => ({
        trip_id: row.trip_id,
        route_id: row.route_id,
        short_name: row.short_name,
        long_name: row.long_name,
        route_type: row.route_type,
        headsign: row.headsign,
        service_id: row.service_id,
        stop_sequence: row.stop_sequence,
        departure: minutesToClock(row.dep_min),
        departure_raw: row.raw,
        arrival: minutesToClock(row.arr_min),
        minutes_until: row.dep_min - fromMinute,
        service_day: row.service_day,
        day_offset: row.day_offset,
        generated: row.generated,
        ...(row.frequency ? { headway_min: row.frequency.headway_min } : {}),
      })),
      ...(shown.some((row) => row.day_offset < 0)
        ? { note: 'ba’zi qatnovlar kechagi xizmat kunining yarim tundan keyingi qismi' }
        : {}),
      ...noteOf(scan.notes),
      ...(today.services.length === 0 && yesterday.services.length === 0
        ? { note: 'bugun ham, kecha ham hech qanday xizmat yurmaydi — calendar.txt va calendar_dates.txt tekshirildi' }
        : {}),
    });
  },
});

/** The engine's own notes, if it had any (a runaway headway block is never silently dropped). */
function noteOf(notes: string[]): { note?: string } {
  return notes.length ? { note: notes.join('; ') } : {};
}

function preparedStop(
  db: SqliteLike,
  feedId: string,
  stop: string,
): { name: string; lat: number; lon: number } | undefined {
  return prepared(db, 'select name, lat, lon from stops where feed_id = ? and stop_id = ?').get(feedId, stop) as
    { name: string; lat: number; lon: number } | undefined;
}

/** A real `YYYY-MM-DD`, defaulting to today when the caller left it out or typed something else. */
function isoDate(raw: string): string {
  const text = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text) && Number.isFinite(Date.parse(text + 'T00:00:00Z'))) return text;
  const now = new Date();
  return (
    now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0')
  );
}
