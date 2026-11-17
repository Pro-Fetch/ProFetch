import { defineTool } from '../../core/tool.js';
import { jsonBlock } from '../../core/format.js';
import { bool, num, strOrEmpty, view } from '../../core/input.js';
import {
  clockToMinutes,
  minutesToClock,
  nowMinutes,
  openGtfsDb,
  prepared,
  resolveFeedId,
  type SqliteLike,
} from './_gtfs.js';
import { planJourneys, type Journey } from './_journey.js';

/**
 * pro_gtfs_journey — get from one stop to another
 * Category: gtfs
 *
 * ## What is searched
 *
 * Direct rides and rides with exactly one change, on one service date, filtered through the calendar, with
 * headway-driven first legs expanded from `frequencies.txt` and walking taken from `transfers.txt` where
 * the feed states it. The engine is in `_journey.ts` with the reasoning; this file only turns the caller's
 * words into a window and the answer into something readable.
 *
 * ## What is not claimed
 *
 * No routing between stops beyond the walk estimate, no live delays, no two-change journeys. When the caps
 * in the search are reached the answer says so: "no journey found" and "the search stopped early" are
 * different statements and must never look the same.
 */
export default defineTool({
  name: 'pro_gtfs_journey',
  description:
    'GTFS bo‘yicha sayr: bir bekadan ikkinchisiga to‘g‘ridan-to‘g‘ri yoki bitta ko‘chish bilan, ' +
    'yurish kunlari va frequencies hisobga olingan holda. Vaqt, davomiylik, har qadam (qaysi reys, ' +
    'qachon o‘tirish/tushish, necha beka) va ko‘chish davomi qaytadi.',
  category: 'gtfs',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      feed: { type: 'string', description: 'Feed identifikatori; bitta feed bo‘lsa bo‘sh qoldirsa bo‘ladi' },
      from: { type: 'string', description: 'stop_id — binosidan chiqiladigan beka' },
      to: { type: 'string', description: 'stop_id — boriladigan beka' },
      date: { type: 'string', description: 'YYYY-MM-DD (standart: bugun)' },
      at: { type: 'string', description: 'HH:MM — qachon chiqmoqchisiz (standart: hozir)' },
      arrive_by: { type: 'string', description: 'HH:MM — shu vaqtga kelib yetish kerak (at o‘rnina ishlatiladi)' },
      window_min: { type: 'number', description: 'Chiqish oynasi daqiqada (standart 120, eng ko‘pi 720)' },
      max_changes: { type: 'number', description: '0 — faqat to‘g‘ridan-to‘g‘ri, 1 — bitta ko‘chish (standart 1)' },
      max_results: { type: 'number', description: 'Nechta sayr (standart 10, eng ko‘pi 50)' },
      max_wait_min: { type: 'number', description: 'Ikkinchi transportga eng ko‘p kutish (standart 45)' },
      min_connection_min: { type: 'number', description: 'Bir bekada tushishdan o‘tirishgacha minimum (standart 1)' },
      max_walk_min: { type: 'number', description: 'Ko‘chishda eng ko‘pi yurish daqiqasi (standart 15)' },
      route: { type: 'string', description: 'Birinchi qadamni shu yo‘l bilan cheklash' },
      include_frequencies: { type: 'boolean', description: 'Birinchi qadamda frequencies ochilsin (standart true)' },
    },
    required: ['from', 'to'],
    additionalProperties: false,
  },
  async handler(input) {
    const p = view(input);
    const db = await openGtfsDb();
    const feedId = resolveFeedId(db, strOrEmpty(p, 'feed'));
    const fromStop = strOrEmpty(p, 'from');
    const toStop = strOrEmpty(p, 'to');
    const route = strOrEmpty(p, 'route');
    const includeFrequencies = bool(p, 'include_frequencies', true);
    const maxChanges = num(p, 'max_changes', 1) === 0 ? 0 : 1;
    const maxResults = Math.max(1, Math.min(50, Math.floor(num(p, 'max_results', 10))));
    const maxWait = Math.max(0, Math.min(240, Math.floor(num(p, 'max_wait_min', 45))));
    const minConnection = Math.max(0, Math.min(30, Math.floor(num(p, 'min_connection_min', 1))));
    const maxWalk = Math.max(0, Math.min(60, Math.floor(num(p, 'max_walk_min', 15))));
    const windowMin = Math.max(1, Math.min(720, Math.floor(num(p, 'window_min', 120))));
    const date = isoDate(strOrEmpty(p, 'date'));

    const missing = missingStops(db, feedId, [fromStop, toStop]);
    if (missing.length) {
      return jsonBlock('GTFS journey', {
        ok: false,
        feed_id: feedId,
        error: 'beka topilmadi: ' + missing.join(', '),
        note: 'pro_gtfs_stops bilan nom yoki koordinata bo‘yicha toping',
      });
    }

    const arriveBy = clockToMinutes(strOrEmpty(p, 'arrive_by'));
    const departAt = clockToMinutes(strOrEmpty(p, 'at'));
    let fromAbs: number;
    let toAbs: number;
    if (arriveBy !== null && departAt === null) {
      // "Be there by 10:00": search departures in the two hours before it, then keep only what arrives in time.
      toAbs = arriveBy;
      fromAbs = Math.max(0, arriveBy - Math.max(windowMin, 120));
    } else {
      const start = departAt ?? nowMinutes();
      fromAbs = start;
      toAbs = start + windowMin;
    }

    const report = planJourneys(db, feedId, fromStop, toStop, date, {
      fromAbs,
      toAbs,
      maxChanges,
      maxResults,
      maxWaitMin: maxWait,
      minConnectionMin: minConnection,
      maxWalkMin: maxWalk,
      maxRideMin: 240,
      ...(route ? { route } : {}),
    });

    let journeys = report.journeys;
    if (arriveBy !== null && departAt === null) {
      journeys = journeys.filter((journey) => journey.arrive_min <= arriveBy).sort(byLatestArrival);
    }
    if (!includeFrequencies) {
      journeys = journeys.filter((journey) => !journey.legs.some((leg) => leg.generated));
    }

    return jsonBlock('GTFS journey', {
      ok: true,
      feed_id: feedId,
      from: fromStop,
      to: toStop,
      date,
      search: {
        from_clock: minutesToClock(fromAbs),
        to_clock: minutesToClock(toAbs),
        ...(arriveBy !== null && departAt === null ? { arrive_by: minutesToClock(arriveBy) } : {}),
        max_changes: maxChanges,
        window_min: windowMin,
        max_walk_min: maxWalk,
        min_connection_min: minConnection,
      },
      scanned: report.scanned,
      matched: journeys.length,
      journeys: journeys.slice(0, maxResults).map(shape),
      ...(journeys.length === 0
        ? {
            note: report.scanned.truncated
              ? 'qidiruv to‘liq tugamadi — hisoblanganlar chekloviga urildi, javob "yo‘q" degani EMAS'
              : 'bu oynada to‘g‘ridan-to‘g‘ri yoki bitta ko‘chish bilan yo‘l topilmadi',
          }
        : {}),
      ...(report.notes.length ? { notes: report.notes } : {}),
      caveats: [
        'jadval bo‘yicha plan: jonlik kechikishlar hisobga olinmaydi',
        'ikki va undan ortiq ko‘chish qidirmaydi',
        'yurish vaqti transfers.txt bo‘lmasa koordinatalardan 80 m/daqiqada hisoblanadi',
      ],
    });
  },
});

/**
 * The named stops the feed does not have.
 *
 * Checked before any search so an invented stop cannot come back as "no journey exists" — that answer
 * would be about the stop, not the timetable.
 */
function missingStops(db: SqliteLike, feedId: string, stops: string[]): string[] {
  const check = prepared(db, 'select 1 as ok from stops where feed_id = ? and stop_id = ? limit 1');
  return stops.filter((stop) => !check.get(feedId, stop));
}

/** Latest arrival first: for "be there by T" the useful plan is the one that gets in last but still on time. */
function byLatestArrival(a: Journey, b: Journey): number {
  return b.arrive_min - a.arrive_min || a.depart_min - b.depart_min;
}

function shape(journey: Journey): Record<string, unknown> {
  return {
    changes: journey.changes,
    depart: minutesToClock(journey.depart_min),
    arrive: minutesToClock(journey.arrive_min),
    total_min: journey.arrive_min - journey.depart_min,
    ride_min: journey.ride_min,
    transfer_wait_min: journey.transfer_wait_min,
    walk_min: journey.walk_min,
    walk_source: journey.walk_source,
    legs: journey.legs.map((leg) => ({
      route: leg.short_name || leg.long_name ? leg.short_name + ' ' + leg.long_name : leg.route_id,
      route_type: leg.route_type,
      trip_id: leg.trip_id,
      headsign: leg.headsign,
      from_stop: leg.from_stop,
      to_stop: leg.to_stop,
      board: leg.board_clock,
      alight: leg.alight_clock,
      stops: leg.stops,
      ride_min: leg.ride_min,
      service_day: leg.service_day,
      // `generated` is the answer to "did the feed time this, or did a headway block produce it" — it is
      // always present so a caller can filter on it without guessing at a key that may be missing.
      generated: leg.generated,
      headway_min: leg.headway_min,
      ...(leg.approximate_from_frequencies ? { approximate_from_frequencies: true } : {}),
    })),
  };
}

function isoDate(raw: string): string {
  const text = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text) && Number.isFinite(Date.parse(text + 'T00:00:00Z'))) return text;
  const now = new Date();
  return (
    now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0')
  );
}
