/**
 * The shared "what can be boarded at this stop" engine behind pro_gtfs_arrivals and pro_gtfs_journey.
 *
 * ## Absolute minutes
 *
 * Every time in this module is minutes from midnight of the date that was asked about. A feed writes a
 * trip that starts on Saturday and finishes after midnight with hours past 24 (`25:15:00`), and that
 * minute belongs to the service day it started on. Converting once, here, is what keeps a sleeper from
 * appearing fourteen hours early: a departure of 1515 on yesterday's service is 75 minutes past midnight
 * of the asked date.
 *
 * ## Frequencies are expanded, not skipped
 *
 * `frequencies.txt` says a trip runs every N minutes between two times instead of listing clocks.
 * `stop_times.txt` for such a trip describes one representative run, so a board that ignores the file
 * hides the service, and a board that only adds `start_time` invents one vehicle an hour. Both blocks
 * are enumerated from the trip's own origin times, shifted by the offset of the asked stop, which is how
 * the spec defines it. A block with an unusable headway is reported, never guessed around.
 */
import { minutesToClock, prepared, servicesOnDate, shiftIsoDate, type SqliteLike } from './_gtfs.js';

/** How many departures one frequency block may produce before it is refused as runaway. */
export const MAX_FREQUENCY_DEPARTURES = 400;

export interface Boarding {
  trip_id: string;
  route_id: string;
  short_name: string;
  long_name: string;
  route_type: string;
  headsign: string;
  service_id: string;
  stop_sequence: number;
  /** Minutes from midnight of the asked date. */
  dep_min: number;
  arr_min: number | null;
  /** What the feed wrote for this stop, kept because 25:15 and 01:15 are different answers. */
  raw: string;
  service_day: string;
  day_offset: number;
  generated: boolean;
  frequency?: { start_min: number; end_min: number; headway_min: number; exact_times: boolean };
  /**
   * Minutes this departure is shifted from the representative run the feed wrote in `stop_times.txt`.
   *
   * A headway block repeats the same vehicle pattern, so every later stop of that trip moves by the same
   * amount — which is what a journey planner needs to carry a generated boarding forward. Always 0 for a
   * departure the feed timed directly.
   */
  shift_min: number;
}

export interface BoardingReport {
  boards: Boarding[];
  scanned: { timed: number; frequency_blocks: number; frequency_generated: number; skipped_blocks: number };
  notes: string[];
}

/** Feed minutes on a service day → minutes from midnight of the date that was asked about. */
export function toAbsolute(feedMin: number, dayOffset: number): number {
  return feedMin + dayOffset * 1440;
}

/** The reverse of `toAbsolute`: the window in the feed's own minute space for one service day. */
export function toFeedMinutes(absolute: number, dayOffset: number): number {
  return absolute - dayOffset * 1440;
}

export function clockOf(absoluteMin: number): string | null {
  return minutesToClock(absoluteMin);
}

/**
 * The departures a stop offers between two absolute minutes, timed and headway-driven alike.
 *
 * Only services the calendar actually runs are consulted — for the asked date, and for the day before it
 * (whose after-midnight legs fall into the early hours of the asked date). A route filter is applied
 * inside SQL, so asking for one line does not scan the whole feed.
 */
export function boardingsAtStop(
  db: SqliteLike,
  feedId: string,
  stopId: string,
  date: string,
  fromAbs: number,
  toAbs: number,
  options: { route?: string; limit?: number; includeFrequencies?: boolean } = {},
): BoardingReport {
  const limit = options.limit ?? 400;
  const includeFrequencies = options.includeFrequencies !== false;
  const boards: Boarding[] = [];
  const notes: string[] = [];
  const scanned = { timed: 0, frequency_blocks: 0, frequency_generated: 0, skipped_blocks: 0 };

  for (const [serviceDay, dayOffset] of [[date, 0] as const, [shiftIsoDate(date, -1) ?? date, -1] as const]) {
    const running = servicesOnDate(db, feedId, serviceDay).services;
    if (!running.length) continue;
    const marks = running.map(() => '?').join(',');
    const low = toFeedMinutes(fromAbs, dayOffset);
    const high = toFeedMinutes(toAbs, dayOffset);
    const clauses = [
      'st.feed_id = ?',
      'st.stop_id = ?',
      'st.departure_min between ? and ?',
      't.service_id in (' + marks + ')',
    ];
    const params: Array<string | number> = [feedId, stopId, low, high, ...running];
    if (options.route) {
      clauses.push('t.route_id = ?');
      params.push(options.route);
    }
    const rows = prepared(
      db,
      'select st.trip_id as trip_id, st.stop_sequence as seq, st.arrival_min as arr_min, st.departure_min as dep_min, ' +
        'st.departure_raw as dep_raw, t.route_id as route_id, t.headsign as headsign, t.service_id as service_id, ' +
        'r.short_name as short_name, r.long_name as long_name, r.type as type ' +
        'from stop_times st join trips t on t.feed_id = st.feed_id and t.trip_id = st.trip_id ' +
        'join routes r on r.feed_id = t.feed_id and r.route_id = t.route_id ' +
        'where ' +
        clauses.join(' and ') +
        ' order by st.departure_min limit ?',
    ).all(...params, limit) as Array<Record<string, unknown>>;
    scanned.timed += rows.length;
    for (const row of rows) {
      const depMin = Number(row.dep_min);
      boards.push({
        trip_id: String(row.trip_id),
        route_id: String(row.route_id),
        short_name: String(row.short_name ?? ''),
        long_name: String(row.long_name ?? ''),
        route_type: String(row.type ?? ''),
        headsign: String(row.headsign ?? ''),
        service_id: String(row.service_id ?? ''),
        stop_sequence: Number(row.seq),
        dep_min: toAbsolute(depMin, dayOffset),
        arr_min: row.arr_min === null || row.arr_min === undefined ? null : toAbsolute(Number(row.arr_min), dayOffset),
        raw: String(row.dep_raw ?? ''),
        service_day: serviceDay,
        day_offset: dayOffset,
        generated: false,
        shift_min: 0,
      });
    }

    if (!includeFrequencies) continue;
    const blocks = prepared(
      db,
      'select f.trip_id as trip_id, f.start_min as start_min, f.end_min as end_min, f.headway as headway, ' +
        'f.exact_times as exact_times, cur.stop_sequence as seq, cur.arrival_min as arr_min, ' +
        'cur.departure_min as stop_dep, org.departure_min as origin_dep, t.route_id as route_id, ' +
        't.headsign as headsign, t.service_id as service_id, r.short_name as short_name, r.long_name as long_name, ' +
        'r.type as type ' +
        'from frequencies f ' +
        'join trips t on t.feed_id = f.feed_id and t.trip_id = f.trip_id ' +
        'join routes r on r.feed_id = t.feed_id and r.route_id = t.route_id ' +
        'join stop_times cur on cur.feed_id = f.feed_id and cur.trip_id = f.trip_id and cur.stop_id = ? ' +
        'join stop_times org on org.feed_id = f.feed_id and org.trip_id = f.trip_id ' +
        'and org.stop_sequence = (select min(s.stop_sequence) from stop_times s where s.feed_id = f.feed_id and s.trip_id = f.trip_id) ' +
        'where f.feed_id = ? and t.service_id in (' +
        marks +
        ')' +
        (options.route ? ' and t.route_id = ?' : ''),
      // Placeholder order is the order they appear in the statement: cur.stop_id, f.feed_id, services, route.
    ).all(stopId, feedId, ...running, ...(options.route ? [options.route] : [])) as Array<Record<string, unknown>>;
    scanned.frequency_blocks += blocks.length;

    for (const block of blocks) {
      const start = Number(block.start_min);
      const end = Number(block.end_min);
      const headwaySec = Number(block.headway);
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        !Number.isFinite(headwaySec) ||
        headwaySec < 1 ||
        end < start
      ) {
        scanned.skipped_blocks++;
        continue;
      }
      // `start_time` and `end_time` were parsed into minutes while `headway_secs` is still seconds: the
      // units are matched here, because this is the one place all three meet.
      const headway = headwaySec / 60;
      // The stop's own minute sits this far behind the origin's; the representative run gives the offset.
      const delta = Number(block.stop_dep) - Number(block.origin_dep);
      const possible = Math.floor((end - start) / headway) + 1;
      const steps = Math.min(MAX_FREQUENCY_DEPARTURES, possible);
      if (possible > MAX_FREQUENCY_DEPARTURES) {
        notes.push(
          'frequencies bloki ' +
            MAX_FREQUENCY_DEPARTURES +
            ' qatnovda to‘xtatildi: trip=' +
            block.trip_id +
            ' headway=' +
            headwaySec +
            's',
        );
      }
      for (let k = 0; k < steps; k++) {
        const originMin = start + k * headway;
        if (originMin > end) break;
        const stopFeedMin = originMin + delta;
        const absolute = toAbsolute(stopFeedMin, dayOffset);
        if (absolute < fromAbs || absolute > toAbs) continue;
        scanned.frequency_generated++;
        boards.push({
          trip_id: String(block.trip_id),
          route_id: String(block.route_id),
          short_name: String(block.short_name ?? ''),
          long_name: String(block.long_name ?? ''),
          route_type: String(block.type ?? ''),
          headsign: String(block.headsign ?? ''),
          service_id: String(block.service_id ?? ''),
          stop_sequence: Number(block.seq),
          dep_min: absolute,
          // The representative arrival shifts by the same amount as the departure.
          arr_min:
            block.arr_min === null || block.arr_min === undefined
              ? null
              : toAbsolute(Number(block.arr_min) + (originMin - Number(block.origin_dep)), dayOffset),
          raw: clockOf(absolute)?.replace(/^\+\d+d /, '') ?? String(originMin),
          service_day: serviceDay,
          day_offset: dayOffset,
          generated: true,
          shift_min: originMin - Number(block.origin_dep),
          frequency: {
            start_min: start,
            end_min: end,
            headway_min: Math.round(headway * 10) / 10,
            exact_times: String(block.exact_times ?? '') === '1',
          },
        });
      }
    }
  }

  boards.sort((a, b) => a.dep_min - b.dep_min || a.trip_id.localeCompare(b.trip_id));
  if (scanned.skipped_blocks) {
    notes.push(
      scanned.skipped_blocks +
        ' ta frequencies bloki ishlamas holda o‘tkazib yuborildi (headway yo‘q yoki end < start)',
    );
  }
  return { boards, scanned, notes };
}
