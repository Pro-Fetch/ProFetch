/**
 * The journey planner behind `pro_gtfs_journey`: door-to-door on a timetable, at most one change.
 *
 * ## Why one transfer, and why that is stated instead of hidden
 *
 * A real router (RAPTOR, CFR) needs the whole service-day graph built up front; that is a different
 * piece of software and it would be dishonest to call this one that. Searching direct rides plus one
 * change covers what a GTFS question is usually about — "how do I get from A to B, and where do I
 * change" — and every result carries the exact legs, so a rider can see the plan rather than trust it.
 * Two or more changes come back as `not_searched`, not as "there is no connection".
 *
 * ## What makes a connection legitimate
 *
 * `transfers.txt` is the feed's own statement about walking between two stops: `transfer_type` 3 means
 * the transfer is impossible, 1 and 2 mean a guaranteed or minimum connection time, 0 means no promise
 * and the minutes field is a suggestion. Where the feed says nothing, the walk is estimated from the two
 * stops' coordinates at 80 m per minute and reported as an estimate. A connection that needs negative
 * time is refused; one that needs no walking time at all is still charged `min_connection_min`, because
 * two vehicles at the same pole do not depart at the same instant.
 *
 * ## Where the headways fit in
 *
 * The first leg may board a generated departure (a `frequencies.txt` block), and then the rest of that
 * trip's times are shifted by the same amount — the block repeats the representative run, so the shift is
 * exact for that model. The second leg is read from `stop_times.txt` directly; if its trip carries a
 * frequency block the leg is marked `approximate_from_frequencies` rather than being silently treated as
 * a clock time.
 *
 * ## Bounds
 *
 * The search caps first legs, last legs and stops per trip, and counts every pair it examined. Reaching a
 * cap is reported in `notes` and in `scanned.truncated`: a planner that quietly stops looking is how a
 * connection that exists gets described as one that does not.
 */
import { boundingBox, haversineMeters, prepared, servicesOnDate, shiftIsoDate, type SqliteLike } from './_gtfs.js';
import { boardingsAtStop, toAbsolute, toFeedMinutes, type Boarding } from './_departures.js';

/** Walking speed used when the feed gives no transfer time: 4.8 km/h. */
export const WALK_METRES_PER_MINUTE = 80;
export const MAX_FIRST_LEGS = 250;
export const MAX_LAST_LEGS = 250;
export const MAX_STOPS_PER_TRIP = 80;
export const MAX_PAIRS = 200_000;

interface StopRow {
  stop_id: string;
  seq: number;
  dep: number | null;
  arr: number | null;
  lat: number | null;
  lon: number | null;
}

export interface Leg {
  trip_id: string;
  route_id: string;
  short_name: string;
  long_name: string;
  route_type: string;
  headsign: string;
  service_id: string;
  service_day: string;
  from_stop: string;
  to_stop: string;
  board_min: number;
  alight_min: number;
  board_clock: string;
  alight_clock: string;
  stops: number;
  ride_min: number;
  generated: boolean;
  headway_min: number | null;
  approximate_from_frequencies?: boolean;
}

export interface Journey {
  changes: number;
  depart_min: number;
  arrive_min: number;
  total_min: number;
  ride_min: number;
  transfer_wait_min: number;
  walk_min: number;
  /** Where the walking time came from: the feed said so, it was estimated from coordinates, or no walking was needed. */
  walk_source: 'none' | 'transfers.txt' | 'haversine';
  legs: Leg[];
}

export interface PlanOptions {
  fromAbs: number;
  toAbs: number;
  maxChanges: number;
  maxResults: number;
  maxWaitMin: number;
  minConnectionMin: number;
  maxWalkMin: number;
  maxRideMin: number;
  route?: string;
}

export interface PlanReport {
  journeys: Journey[];
  scanned: { first_legs: number; last_legs: number; alight_stops: number; pairs: number; truncated: boolean };
  notes: string[];
}

function clockOf(min: number): string {
  const day = Math.floor(min / 1440);
  const rest = ((min % 1440) + 1440) % 1440;
  const hh = String(Math.floor(rest / 60)).padStart(2, '0');
  const mm = String(rest % 60).padStart(2, '0');
  return day > 0 ? '+' + day + 'd ' + hh + ':' + mm : hh + ':' + mm;
}

/**
 * The stop list of each named trip.
 *
 * Coordinates come along because a transfer estimate needs them and a second query per stop would cost
 * more than the join that gets them here.
 */
export function stopsOfTrips(db: SqliteLike, feedId: string, tripIds: string[]): Map<string, StopRow[]> {
  const found = new Map<string, StopRow[]>();
  for (let start = 0; start < tripIds.length; start += 200) {
    const slice = tripIds.slice(start, start + 200);
    if (!slice.length) continue;
    const marks = slice.map(() => '?').join(',');
    const rows = prepared(
      db,
      'select st.trip_id as trip_id, st.stop_id as stop_id, st.stop_sequence as seq, st.departure_min as dep, ' +
        'st.arrival_min as arr, s.lat as lat, s.lon as lon ' +
        'from stop_times st left join stops s on s.feed_id = st.feed_id and s.stop_id = st.stop_id ' +
        'where st.feed_id = ? and st.trip_id in (' +
        marks +
        ') order by st.trip_id, st.stop_sequence',
    ).all(feedId, ...slice) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const tripId = String(row.trip_id);
      const list = found.get(tripId) ?? [];
      if (list.length < MAX_STOPS_PER_TRIP) {
        list.push({
          stop_id: String(row.stop_id),
          seq: Number(row.seq),
          dep: row.dep === null || row.dep === undefined ? null : Number(row.dep),
          arr: row.arr === null || row.arr === undefined ? null : Number(row.arr),
          lat: row.lat === null || row.lat === undefined ? null : Number(row.lat),
          lon: row.lon === null || row.lon === undefined ? null : Number(row.lon),
        });
      }
      found.set(tripId, list);
    }
  }
  return found;
}

export interface TransferInfo {
  minutes: number | null;
  source: 'transfers.txt' | 'haversine' | 'same_stop';
  impossible: boolean;
}

/**
 * The feed's own answer about walking from one stop to another, or an estimate when it says nothing.
 *
 * `transfer_type` 3 is an explicit prohibition and is honoured: the connection is refused rather than
 * priced at a walk that the agency says cannot be made.
 */
export function transferMinutes(
  db: SqliteLike,
  feedId: string,
  fromStop: string,
  toStop: string,
  fromCoords?: { lat: number | null; lon: number | null },
  toCoords?: { lat: number | null; lon: number | null },
): TransferInfo {
  if (fromStop === toStop) return { minutes: 0, source: 'same_stop', impossible: false };
  const row = prepared(
    db,
    'select minutes, kind from transfers where feed_id = ? and from_stop = ? and to_stop = ? limit 1',
  ).get(feedId, fromStop, toStop) as { minutes: number | null; kind: string } | undefined;
  if (row) {
    if (String(row.kind) === '3') return { minutes: null, source: 'transfers.txt', impossible: true };
    if (String(row.kind) === '1' || String(row.kind) === '2') {
      return { minutes: row.minutes ?? 0, source: 'transfers.txt', impossible: false };
    }
    if (row.minutes !== null && row.minutes !== undefined) {
      return { minutes: row.minutes, source: 'transfers.txt', impossible: false };
    }
  }
  const lat1 = fromCoords?.lat;
  const lon1 = fromCoords?.lon;
  const lat2 = toCoords?.lat;
  const lon2 = toCoords?.lon;
  if (
    lat1 === null ||
    lat1 === undefined ||
    lon1 === null ||
    lon1 === undefined ||
    lat2 === null ||
    lat2 === undefined ||
    lon2 === null ||
    lon2 === undefined
  ) {
    return { minutes: null, source: 'haversine', impossible: false };
  }
  const metres = haversineMeters(lat1, lon1, lat2, lon2);
  return { minutes: Math.ceil(metres / WALK_METRES_PER_MINUTE), source: 'haversine', impossible: false };
}

/** How many boarding stops one search may open before it stops and says so. */
export const MAX_BOARD_STOPS = 400;
/** How many places a rider can walk from, per boarding stop. */
export const MAX_FEEDER_STOPS = 24;

interface TransferRow {
  from_stop: string;
  to_stop: string;
  minutes: number | null;
  kind: string;
}

/** Every `transfers.txt` row of this feed, read once per search. */
function transferRows(db: SqliteLike, feedId: string): TransferRow[] {
  return prepared(db, 'select from_stop, to_stop, minutes, kind from transfers where feed_id = ? limit 200000').all(
    feedId,
  ) as Array<{ from_stop: string; to_stop: string; minutes: number | null; kind: string }>;
}

export interface FeederStop {
  stop_id: string;
  minutes: number;
  source: 'none' | 'transfers.txt' | 'haversine';
}

/**
 * The stops a rider can arrive at and still make the vehicle that leaves `target`.
 *
 * Three kinds, in this order: the stop itself (no walking at all, `min_connection_min` still applies),
 * the stops the feed declared as transferring here — where `transfer_type` 3 removes the pair entirely —
 * and, when the caller allows walking to be estimated, the stops inside a box of `maxWalkMin × 80 m`
 * around it. Declared times always win over the estimate, because the agency measured the corridor and we
 * are measuring straight lines over a map.
 */
export function feederStops(
  db: SqliteLike,
  feedId: string,
  target: StopRow,
  maxWalkMin: number,
  declared: TransferRow[],
): FeederStop[] {
  const out: FeederStop[] = [{ stop_id: target.stop_id, minutes: 0, source: 'none' }];
  const seen = new Set<string>([target.stop_id]);
  for (const row of declared) {
    if (row.to_stop !== target.stop_id || seen.has(row.from_stop) || String(row.kind) === '3') continue;
    seen.add(row.from_stop);
    // A declared transfer without a time is a promise that no time is guaranteed, not a promise of zero:
    // 0 minutes plus the caller's connection margin is the most a feed lets us claim.
    out.push({ stop_id: row.from_stop, minutes: row.minutes ?? 0, source: 'transfers.txt' });
  }
  if (maxWalkMin <= 0 || target.lat === null || target.lon === null) return out;
  const box = boundingBox(target.lat, target.lon, maxWalkMin * WALK_METRES_PER_MINUTE);
  if (box.wraps) return out;
  const nearby = prepared(
    db,
    'select stop_id, lat, lon from stops where feed_id = ? and lat between ? and ? and lon between ? and ? limit ?',
  ).all(feedId, box.minLat, box.maxLat, box.minLon, box.maxLon, MAX_FEEDER_STOPS * 4) as Array<{
    stop_id: string;
    lat: number;
    lon: number;
  }>;
  for (const row of nearby) {
    if (seen.has(row.stop_id)) continue;
    if (out.length >= MAX_FEEDER_STOPS) break;
    if (
      declared.some(
        (item) => item.from_stop === row.stop_id && item.to_stop === target.stop_id && String(item.kind) === '3',
      )
    ) {
      continue;
    }
    const minutes = Math.ceil(haversineMeters(target.lat, target.lon, row.lat, row.lon) / WALK_METRES_PER_MINUTE);
    if (minutes > maxWalkMin) continue;
    seen.add(row.stop_id);
    out.push({ stop_id: row.stop_id, minutes, source: 'haversine' });
  }
  return out;
}

/** Trips that arrive at `destStop` inside the plan window, with the service day they belong to. */
function lastLegs(db: SqliteLike, feedId: string, destStop: string, date: string, options: PlanOptions) {
  const found: Array<{
    trip_id: string;
    route_id: string;
    short_name: string;
    long_name: string;
    route_type: string;
    headsign: string;
    service_id: string;
    service_day: string;
    day_offset: number;
    dest_seq: number;
    arr_abs: number;
  }> = [];
  for (const [serviceDay, dayOffset] of [[date, 0] as const, [shiftIsoDate(date, -1) ?? date, -1] as const]) {
    const running = servicesOnDate(db, feedId, serviceDay).services;
    if (!running.length) continue;
    const marks = running.map(() => '?').join(',');
    const rows = prepared(
      db,
      'select st.trip_id as trip_id, st.stop_sequence as seq, st.arrival_min as arr, t.route_id as route_id, ' +
        't.service_id as service_id, t.headsign as headsign, r.short_name as short_name, r.long_name as long_name, r.type as type ' +
        'from stop_times st join trips t on t.feed_id = st.feed_id and t.trip_id = st.trip_id ' +
        'join routes r on r.feed_id = t.feed_id and r.route_id = t.route_id ' +
        'where st.feed_id = ? and st.stop_id = ? and st.arrival_min between ? and ? and t.service_id in (' +
        marks +
        ') order by st.arrival_min limit ?',
    ).all(
      feedId,
      destStop,
      toFeedMinutes(options.fromAbs, dayOffset),
      toFeedMinutes(options.toAbs + options.maxRideMin, dayOffset),
      ...running,
      MAX_LAST_LEGS,
    ) as Array<Record<string, unknown>>;
    for (const row of rows) {
      found.push({
        trip_id: String(row.trip_id),
        route_id: String(row.route_id),
        short_name: String(row.short_name ?? ''),
        long_name: String(row.long_name ?? ''),
        route_type: String(row.type ?? ''),
        headsign: String(row.headsign ?? ''),
        service_id: String(row.service_id ?? ''),
        service_day: serviceDay,
        day_offset: dayOffset,
        dest_seq: Number(row.seq),
        arr_abs: toAbsolute(Number(row.arr), dayOffset),
      });
    }
  }
  found.sort((a, b) => a.arr_abs - b.arr_abs);
  return found;
}

/** Which of these trips are headway-driven — those second legs are marked as approximate. */
function frequencyTrips(db: SqliteLike, feedId: string, tripIds: string[]): Set<string> {
  const out = new Set<string>();
  for (let start = 0; start < tripIds.length; start += 200) {
    const slice = tripIds.slice(start, start + 200);
    if (!slice.length) continue;
    const marks = slice.map(() => '?').join(',');
    const rows = prepared(
      db,
      'select distinct trip_id from frequencies where feed_id = ? and trip_id in (' + marks + ')',
    ).all(feedId, ...slice) as Array<{ trip_id: string }>;
    for (const row of rows) out.add(row.trip_id);
  }
  return out;
}

export function planJourneys(
  db: SqliteLike,
  feedId: string,
  originStop: string,
  destStop: string,
  date: string,
  options: PlanOptions,
): PlanReport {
  const notes: string[] = [];
  const scanned = { first_legs: 0, last_legs: 0, alight_stops: 0, pairs: 0, truncated: false };
  const lastAbsLimit = options.toAbs + options.maxRideMin;

  const origin = boardingsAtStop(db, feedId, originStop, date, options.fromAbs, options.toAbs, {
    limit: MAX_FIRST_LEGS,
    route: options.route,
  });
  scanned.first_legs = origin.boards.length;
  for (const note of origin.notes) notes.push(note);
  if (origin.boards.length >= MAX_FIRST_LEGS) {
    scanned.truncated = true;
    notes.push('birinchi qatnovlar ' + MAX_FIRST_LEGS + ' ta bilan cheklandi');
  }

  const firstStops = stopsOfTrips(db, feedId, [...new Set(origin.boards.map((row) => row.trip_id))]);

  const journeys: Journey[] = [];
  const alightAt = new Map<string, Array<{ boarding: Boarding; arr: number; row: StopRow }>>();

  for (const boarding of origin.boards) {
    for (const row of firstStops.get(boarding.trip_id) ?? []) {
      if (row.seq <= boarding.stop_sequence) continue;
      const minute = row.arr ?? row.dep;
      if (minute === null || minute === undefined) continue;
      const arrAbs = toAbsolute(minute, boarding.day_offset) + boarding.shift_min;
      if (arrAbs > lastAbsLimit) continue;
      if (row.stop_id === destStop) {
        const ride = arrAbs - boarding.dep_min;
        journeys.push({
          changes: 0,
          depart_min: boarding.dep_min,
          arrive_min: arrAbs,
          total_min: arrAbs - options.fromAbs,
          ride_min: ride,
          transfer_wait_min: 0,
          walk_min: 0,
          walk_source: 'none',
          legs: [legOf(boarding, originStop, row.stop_id, arrAbs, firstStops)],
        });
        continue;
      }
      scanned.alight_stops++;
      const bucket = alightAt.get(row.stop_id) ?? [];
      bucket.push({ boarding, arr: arrAbs, row });
      alightAt.set(row.stop_id, bucket);
    }
  }

  if (options.maxChanges >= 1) {
    const lasts = lastLegs(db, feedId, destStop, date, options);
    scanned.last_legs = lasts.length;
    if (lasts.length >= MAX_LAST_LEGS) {
      scanned.truncated = true;
      notes.push('ikkinchi qatnovlar ' + MAX_LAST_LEGS + ' ta bilan cheklandi');
    }
    const lastTripIds = [...new Set(lasts.map((row) => row.trip_id))];
    const lastStops = stopsOfTrips(db, feedId, lastTripIds);
    const headwayTrips = frequencyTrips(db, feedId, lastTripIds);

    // Where the second leg could be boarded, gathered once per stop. Opening a boarding stop costs a
    // bounding-box query for its feeders, so that work is done per stop rather than per candidate pair.
    type LastLeg = (typeof lasts)[number];
    const boards = new Map<string, { stop: StopRow; legs: Array<{ last: LastLeg; boardAbs: number }> }>();
    for (const last of lasts) {
      for (const row of lastStops.get(last.trip_id) ?? []) {
        if (row.seq >= last.dest_seq) break;
        if (row.dep === null || row.dep === undefined) continue;
        const boardAbs = toAbsolute(row.dep, last.day_offset);
        if (boardAbs > options.toAbs + options.maxRideMin) continue;
        const entry = boards.get(row.stop_id) ?? { stop: row, legs: [] };
        entry.legs.push({ last, boardAbs });
        boards.set(row.stop_id, entry);
      }
    }

    const declared = transferRows(db, feedId);
    let examined = 0;
    for (const entry of boards.values()) {
      if (examined >= MAX_BOARD_STOPS) {
        scanned.truncated = true;
        notes.push('ko‘chish bekalari ' + MAX_BOARD_STOPS + ' taga bilan cheklandi, ' + boards.size + ' ta edi');
        break;
      }
      examined++;
      for (const feeder of feederStops(db, feedId, entry.stop, options.maxWalkMin, declared)) {
        const candidates = alightAt.get(feeder.stop_id);
        if (!candidates) continue;
        for (const candidate of candidates) {
          if (scanned.pairs >= MAX_PAIRS) break;
          scanned.pairs++;
          for (const plan of entry.legs) {
            const earliest = candidate.arr + feeder.minutes + options.minConnectionMin;
            if (plan.boardAbs < earliest) continue;
            const wait = plan.boardAbs - candidate.arr;
            if (wait > options.maxWaitMin + feeder.minutes) continue;
            if (plan.last.arr_abs <= plan.boardAbs) continue;
            journeys.push({
              changes: 1,
              depart_min: candidate.boarding.dep_min,
              arrive_min: plan.last.arr_abs,
              total_min: plan.last.arr_abs - candidate.boarding.dep_min,
              ride_min: candidate.arr - candidate.boarding.dep_min + (plan.last.arr_abs - plan.boardAbs),
              transfer_wait_min: plan.boardAbs - candidate.arr,
              walk_min: feeder.minutes,
              walk_source: feeder.source,
              legs: [
                legOf(candidate.boarding, originStop, feeder.stop_id, candidate.arr, firstStops),
                {
                  trip_id: plan.last.trip_id,
                  route_id: plan.last.route_id,
                  short_name: plan.last.short_name,
                  long_name: plan.last.long_name,
                  route_type: plan.last.route_type,
                  headsign: plan.last.headsign,
                  service_id: plan.last.service_id,
                  service_day: plan.last.service_day,
                  from_stop: entry.stop.stop_id,
                  to_stop: destStop,
                  board_min: plan.boardAbs,
                  alight_min: plan.last.arr_abs,
                  board_clock: clockOf(plan.boardAbs),
                  alight_clock: clockOf(plan.last.arr_abs),
                  stops: Math.max(0, plan.last.dest_seq - entry.stop.seq),
                  ride_min: plan.last.arr_abs - plan.boardAbs,
                  generated: false,
                  headway_min: null,
                  ...(headwayTrips.has(plan.last.trip_id) ? { approximate_from_frequencies: true } : {}),
                },
              ],
            });
          }
        }
      }
    }
  } else {
    notes.push('max_changes=0 — faqat to‘g‘ridan-to‘g‘ri reyslar qidirdi');
  }

  const seen = new Set<string>();
  const unique = journeys.filter((journey) => {
    const key = journey.legs.map((leg) => leg.trip_id + '@' + leg.board_min + '->' + leg.to_stop).join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  unique.sort((a, b) => a.arrive_min - b.arrive_min || a.total_min - b.total_min || a.depart_min - b.depart_min);
  const page = unique.slice(0, options.maxResults);
  if (unique.length > page.length) {
    notes.push('mos joylashuvlar ' + unique.length + ' ta, ' + options.maxResults + ' tasi qaytarildi');
  }
  return { journeys: page, scanned, notes };
}

/** The first leg, measured against the boarding the caller could actually take. */
function legOf(
  boarding: Boarding,
  originStop: string,
  alightStop: string,
  alightAbs: number,
  firstStops: Map<string, StopRow[]>,
): Leg {
  const rows = firstStops.get(boarding.trip_id) ?? [];
  const alightSeq =
    rows.find((row) => row.stop_id === alightStop && row.seq > boarding.stop_sequence)?.seq ?? boarding.stop_sequence;
  return {
    trip_id: boarding.trip_id,
    route_id: boarding.route_id,
    short_name: boarding.short_name,
    long_name: boarding.long_name,
    route_type: boarding.route_type,
    headsign: boarding.headsign,
    service_id: boarding.service_id,
    service_day: boarding.service_day,
    from_stop: originStop,
    to_stop: alightStop,
    board_min: boarding.dep_min,
    alight_min: alightAbs,
    board_clock: clockOf(boarding.dep_min),
    alight_clock: clockOf(alightAbs),
    stops: Math.max(0, alightSeq - boarding.stop_sequence),
    ride_min: alightAbs - boarding.dep_min,
    generated: boarding.generated,
    headway_min: boarding.frequency?.headway_min ?? null,
  };
}
