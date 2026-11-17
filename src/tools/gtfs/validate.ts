import { defineTool } from '../../core/tool.js';
import { jsonBlock } from '../../core/format.js';
import { num, strOrEmpty, view } from '../../core/input.js';
import { openGtfsDb, prepared, resolveFeedId, type SqliteLike } from './_gtfs.js';

/**
 * pro_gtfs_validate — what is wrong with this feed, counted and sampled
 * Category: gtfs
 *
 * ## Why counts and samples, not lists
 *
 * A real feed has hundreds of small defects: a trip referencing a route that is not in routes.txt, a
 * stop sequence that jumps backwards, a service that runs on no date. Dumping them is unusable and
 * hides the shape of the problem, so every rule reports a **count** and at most `sample_limit`
 * examples. "312 dangling stop references" is actionable; 312 rows in a tool response is noise.
 *
 * ## Why these rules specifically
 *
 * Each one is a way a GTFS feed stops being usable by a consumer, taken from the reference: required
 * files, references between the five core tables, time ordering inside a trip, and services that
 * exist on paper but on no date. A feed can pass all of them and still be wrong in ways no checker
 * knows about — this is not a certification, it is a set of named questions with measured answers.
 */
interface Rule {
  id: string;
  severity: 'error' | 'warning';
  what: string;
  sql: string;
  /** How many times the feed id is bound. Declared, not guessed from the SQL text. */
  binds?: number;
}

const RULES: Rule[] = [
  {
    id: 'missing_required_file',
    severity: 'error',
    what: 'majburiy fayl yo‘q',
    sql: "select file as item from file_rows where feed_id = ? and missing = 1 and file in ('stops.txt','routes.txt','trips.txt','stop_times.txt')",
  },
  {
    id: 'no_calendar_at_all',
    severity: 'error',
    what: 'na calendar.txt, na calendar_dates.txt — qaysi kun yurishi noma’lum',
    sql: "select 'calendar' as item where not exists (select 1 from calendar where feed_id = ?) and not exists (select 1 from calendar_dates where feed_id = ?)",
    binds: 2,
  },
  {
    id: 'trip_route_unknown',
    severity: 'error',
    what: 'trips.txt yo‘q route_id ga havola qiladi',
    sql: 'select t.trip_id as item from trips t left join routes r on r.feed_id = t.feed_id and r.route_id = t.route_id where t.feed_id = ? and r.route_id is null limit 5000',
  },
  {
    id: 'stop_time_trip_unknown',
    severity: 'error',
    what: 'stop_times.txt yo‘q trip_id ga havola qiladi',
    sql: 'select distinct st.trip_id as item from stop_times st left join trips t on t.feed_id = st.feed_id and t.trip_id = st.trip_id where st.feed_id = ? and t.trip_id is null limit 5000',
  },
  {
    id: 'stop_time_stop_unknown',
    severity: 'error',
    what: 'stop_times.txt yo‘q stop_id ga havola qiladi',
    sql: 'select distinct st.stop_id as item from stop_times st left join stops s on s.feed_id = st.feed_id and s.stop_id = st.stop_id where st.feed_id = ? and s.stop_id is null limit 5000',
  },
  {
    id: 'trip_service_unknown',
    severity: 'warning',
    what: 'trip hech qanday service (calendar) ga bog‘lanmagan',
    sql: 'select t.trip_id as item from trips t left join calendar c on c.feed_id = t.feed_id and c.service_id = t.service_id left join calendar_dates cd on cd.feed_id = t.feed_id and cd.service_id = t.service_id where t.feed_id = ? and c.service_id is null and cd.service_id is null limit 5000',
  },
  {
    id: 'trip_without_times',
    severity: 'warning',
    what: 'trip mavjud, lekin hech qaysi bekada vaqti yo‘q',
    sql: 'select t.trip_id as item from trips t left join stop_times st on st.feed_id = t.feed_id and st.trip_id = t.trip_id where t.feed_id = ? and st.trip_id is null limit 5000',
  },
  {
    id: 'route_without_trips',
    severity: 'warning',
    what: 'yo‘l e’lon qilingan, lekin birorta reys yo‘q',
    sql: 'select r.route_id as item from routes r left join trips t on t.feed_id = r.feed_id and t.route_id = r.route_id where r.feed_id = ? and t.trip_id is null limit 5000',
  },
  {
    id: 'stop_never_visited',
    severity: 'warning',
    what: 'beka bor, lekin hech qaysi transport unda to‘xtamaydi',
    sql: 'select s.stop_id as item from stops s left join stop_times st on st.feed_id = s.feed_id and st.stop_id = s.stop_id where s.feed_id = ? and st.stop_id is null limit 5000',
  },
  {
    id: 'time_unparsable',
    severity: 'warning',
    what: 'vaqt GTFS formatida emas (H:MM:SS, 24 dan oshishi mumkin)',
    sql: "select st.trip_id || '@' || coalesce(st.stop_id,'?') as item from stop_times st where st.feed_id = ? and (st.arrival_min is null or st.departure_min is null) limit 5000",
  },
  {
    id: 'arrival_after_departure',
    severity: 'error',
    what: 'kelish vaqti jo‘nash vaqtidan keyin',
    sql: "select trip_id || '@' || coalesce(stop_id,'?') as item from stop_times where feed_id = ? and arrival_min is not null and departure_min is not null and arrival_min > departure_min limit 5000",
  },
  {
    id: 'sequence_not_increasing',
    severity: 'error',
    what: 'bitta reys ichida stop_sequence orqaga ketgan',
    sql: `select a.trip_id || ' #' || a.stop_sequence || '->' || b.stop_sequence as item
            from stop_times a
            join stop_times b on b.feed_id = a.feed_id and b.trip_id = a.trip_id and b.stop_sequence > a.stop_sequence
           where a.feed_id = ? and a.arrival_min is not null and b.arrival_min is not null and b.arrival_min < a.arrival_min
           limit 5000`,
  },
  {
    id: 'calendar_start_after_end',
    severity: 'warning',
    what: 'calendar boshlanishi tugashidan keyin',
    sql: 'select service_id as item from calendar where feed_id = ? and start_date > end_date limit 5000',
  },
  {
    id: 'service_runs_no_date',
    severity: 'warning',
    what: 'service haftada bir kuni ham yo‘q (barcha ustunlar 0)',
    sql: 'select service_id as item from calendar where feed_id = ? and days = 0 limit 5000',
  },
  {
    id: 'bad_wheelchair_value',
    severity: 'warning',
    what: 'wheelchair_boarding 0/1/2 dan tashqari',
    sql: "select stop_id as item from stops where feed_id = ? and wheelchair not in ('','0','1','2') limit 5000",
  },
];

export default defineTool({
  name: 'pro_gtfs_validate',
  description:
    'Yuklangan GTFS feedini tekshiradi: majburiy fayllar, jadval orasidagi havolalar, vaqt tartibi, ' +
    "yurish kunlari, yo'lsiz reyslar. Har qoida uchun NECHTA ekanligi va kamida namuna qaytadi — " +
    "butun ro'yxat emas.",
  category: 'gtfs',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      feed: { type: 'string', description: 'Feed identifikatori' },
      sample_limit: { type: 'number', description: 'Har qoida uchun namuna soni (standart 5, eng ko‘pi 50)' },
    },
    additionalProperties: false,
  },
  async handler(input) {
    const p = view(input);
    const db = await openGtfsDb();
    const feedId = resolveFeedId(db, strOrEmpty(p, 'feed'));
    const sampleLimit = Math.max(1, Math.min(50, Math.floor(num(p, 'sample_limit', 5))));

    const findings = RULES.map((rule) => runRule(db, rule, feedId, sampleLimit));
    const errors = findings.filter((f) => f.severity === 'error' && f.count > 0);
    const warnings = findings.filter((f) => f.severity === 'warning' && f.count > 0);

    return jsonBlock('GTFS validate', {
      ok: true,
      feed_id: feedId,
      verdict: errors.length ? 'errorlar bor' : warnings.length ? 'ogohlantirishlar bor' : 'toza',
      error_rules: errors.length,
      warning_rules: warnings.length,
      total_problems: findings.reduce((sum, f) => sum + f.count, 0),
      findings: findings.filter((f) => f.count > 0),
      checked_rules: RULES.length,
      note:
        'Bu ro‘yxat sertifikat emas — u savollarning javobi. Hech narsa topilmasa, feed to‘g‘ri degani ' +
        'emas; tekshirilgan 15 qoidaga binoan xato yo‘q deganidir.',
    });
  },
});

interface Finding {
  rule: string;
  severity: string;
  what: string;
  count: number;
  examples: string[];
  truncated_examples: number;
}

function runRule(db: SqliteLike, rule: Rule, feedId: string, sampleLimit: number): Finding {
  const params = Array.from({ length: rule.binds ?? 1 }, () => feedId);
  const rows = prepared(db, rule.sql).all(...params) as Array<{ item: string }>;
  return {
    rule: rule.id,
    severity: rule.severity,
    what: rule.what,
    count: rows.length,
    examples: rows.slice(0, sampleLimit).map((row) => String(row.item)),
    truncated_examples: Math.max(0, rows.length - sampleLimit),
  };
}
