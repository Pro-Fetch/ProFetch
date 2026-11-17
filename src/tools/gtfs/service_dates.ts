import { defineTool } from '../../core/tool.js';
import { jsonBlock } from '../../core/format.js';
import { num, strOrEmpty, view } from '../../core/input.js';
import {
  openGtfsDb,
  prepared,
  resolveFeedId,
  servicePattern,
  servicesOnDate,
  shiftIsoDate,
  todayIso,
} from './_gtfs.js';

/**
 * pro_gtfs_service_dates — when a service actually runs
 * Category: gtfs
 *
 * ## Why this exists as its own tool
 *
 * `stop_times.txt` gives a minute of the day, and nothing more. Whether that minute happens today, on
 * Sundays, or only until a date in March is written in two other files that most callers never open:
 * `calendar.txt` (a weekday mask plus a date range) and `calendar_dates.txt` (single days added or
 * cancelled). A departure list that ignores them is a list of vehicles that may not exist — so the
 * calendar is queried here, and every other gtfs time tool asks this one before answering.
 *
 * ## What the window means
 *
 * A service that runs to 2099 is not worth printing, so dates are walked inside a bounded window
 * (`from`/`to`, capped at 400 days). The answer always says whether it was cut short and how many days
 * really run, so a short list is never read as a complete one.
 */
export default defineTool({
  name: 'pro_gtfs_service_dates',
  description:
    'GTFS xizmat kunlari: service_id qaysi kunlari yuradi (calendar + calendar_dates), yoki bir kun ' +
    'uchun qaysi xizmatlar ishlaydi, yoki bir yo‘l qaysi xizmatlardan foydalanadi.',
  category: 'gtfs',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      feed: { type: 'string', description: 'Feed identifikatori; bitta feed bo‘lsa bo‘sh qoldirsa bo‘ladi' },
      service: { type: 'string', description: 'service_id — shu xizmatning kunlari so‘raladi' },
      date: { type: 'string', description: 'YYYY-MM-DD — shu kun uchun ishlaydigan xizmatlar ro‘yxati' },
      route: { type: 'string', description: 'route_id — shu yo‘l ishlatadigan xizmatlar' },
      from: { type: 'string', description: 'Deraza boshi YYYY-MM-DD (standart: date yoki bugun)' },
      to: { type: 'string', description: 'Deraza oxiri YYYY-MM-DD (standart: boshidan 120 kun)' },
      limit: { type: 'number', description: 'Sanalar ro‘yxatining eng katta uzunligi (standart 30, eng ko‘pi 400)' },
    },
    additionalProperties: false,
  },
  async handler(input) {
    const p = view(input);
    const db = await openGtfsDb();
    const feedId = resolveFeedId(db, strOrEmpty(p, 'feed'));
    const service = strOrEmpty(p, 'service');
    const date = strOrEmpty(p, 'date');
    const route = strOrEmpty(p, 'route');
    const limit = Math.max(1, Math.min(400, Math.floor(num(p, 'limit', 30))));

    const anchor = validDate(date) ?? validDate(strOrEmpty(p, 'from')) ?? todayIso();
    const from = validDate(strOrEmpty(p, 'from')) ?? anchor;
    const to = validDate(strOrEmpty(p, 'to')) ?? shiftIsoDate(from, 120) ?? from;

    const tripsByService = new Map(
      (
        prepared(db, 'select service_id, count(*) as trips from trips where feed_id = ? group by service_id').all(
          feedId,
        ) as Array<{ service_id: string; trips: number }>
      ).map((row) => [row.service_id, row.trips]),
    );

    if (service) {
      const pattern = servicePattern(db, feedId, service, from, to, limit);
      return jsonBlock('GTFS service dates', {
        ok: true,
        feed_id: feedId,
        mode: 'service',
        window: { from, to },
        trips: tripsByService.get(service) ?? 0,
        ...pattern,
        ...(pattern.truncated ? { note: 'limit bilan kesildi: ' + pattern.total_runs + ' ta kun yuradi' } : {}),
        ...(pattern.start_date === null && !pattern.added.length
          ? { note: 'bu service_id uchun na calendar, na calendar_dates yozuvi bor' }
          : {}),
      });
    }

    if (date) {
      const running = servicesOnDate(db, feedId, date);
      // An empty list would make `in ()` a syntax error, and it also means no route can be running.
      const routesRunning = running.services.length
        ? ((
            prepared(
              db,
              'select count(distinct t.route_id) as n from trips t where t.feed_id = ? and t.service_id in (' +
                running.services.map(() => '?').join(',') +
                ')',
            ).get(feedId, ...running.services) as { n: number }
          ).n ?? 0)
        : 0;
      return jsonBlock('GTFS service dates', {
        ok: true,
        feed_id: feedId,
        mode: 'date',
        date,
        weekday: running.weekday,
        services: running.services,
        total_services: running.services.length,
        returned: Math.min(running.services.length, limit),
        with_trips: running.services
          .slice(0, limit)
          .map((id) => ({ service_id: id, trips: tripsByService.get(id) ?? 0 })),
        from_calendar: running.from_calendar,
        added_by_date: running.added_by_date,
        removed_by_date: running.removed_by_date,
        date_rows: running.date_rows,
        routes_running: routesRunning,
        ...(running.services.length > limit
          ? { note: 'limit bilan kesildi: ' + running.services.length + ' ta xizmat' }
          : {}),
        ...(running.services.length === 0 ? { note: 'bu kunda hech qanday xizmat yurmaydi' } : {}),
      });
    }

    if (route) {
      const rows = prepared(
        db,
        'select distinct service_id from trips where feed_id = ? and route_id = ? order by service_id',
      ).all(feedId, route) as Array<{ service_id: string }>;
      return jsonBlock('GTFS service dates', {
        ok: true,
        feed_id: feedId,
        mode: 'route',
        route_id: route,
        window: { from, to },
        services: rows.map((row) => {
          const pattern = servicePattern(db, feedId, row.service_id, from, to, limit);
          return {
            service_id: row.service_id,
            trips: tripsByService.get(row.service_id) ?? 0,
            weekdays: pattern.weekdays,
            start_date: pattern.start_date,
            end_date: pattern.end_date,
            runs_in_window: pattern.total_runs,
            sample_dates: pattern.runs_on,
            added: pattern.added.slice(0, 5),
            removed: pattern.removed.slice(0, 5),
            truncated: pattern.truncated,
          };
        }),
        ...(rows.length ? {} : { note: 'bu yo‘lning reyslari yo‘q yoki route_id topilmadi: ' + route }),
      });
    }

    const summary = prepared(
      db,
      'select (select count(*) from calendar where feed_id = ?) as patterns, ' +
        '(select count(*) from calendar_dates where feed_id = ?) as exceptions, ' +
        '(select min(start_date) from calendar where feed_id = ?) as first_start, ' +
        '(select max(end_date) from calendar where feed_id = ?) as last_end',
    ).get(feedId, feedId, feedId, feedId) as {
      patterns: number;
      exceptions: number;
      first_start: string | null;
      last_end: string | null;
    };
    return jsonBlock('GTFS service dates', {
      ok: true,
      feed_id: feedId,
      mode: 'overview',
      ...summary,
      today: todayIso(),
      services: [...tripsByService.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([service_id, trips]) => ({ service_id, trips })),
      note: 'service, date yoki route berilsa aniq javob qaytadi; hozircha umumiy ko‘rinish',
    });
  },
});

/** The date only if it is a real `YYYY-MM-DD`; anything else is not a day to ask about. */
function validDate(raw: string): string | null {
  const text = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  return Number.isFinite(Date.parse(text + 'T00:00:00Z')) ? text : null;
}
