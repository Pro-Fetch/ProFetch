import { defineTool } from '../../core/tool.js';
import { jsonBlock } from '../../core/format.js';
import { strOrEmpty, view } from '../../core/input.js';
import { gtfsDbPath, openGtfsDb, prepared } from './_gtfs.js';

/**
 * pro_gtfs_feeds — what is loaded, when, and how big
 * Category: gtfs
 *
 * Exists because every other gtfs tool has to choose a feed, and the honest way to ask "which one do
 * you mean" is to show the list with its ages. A feed loaded last month is a different answer from one
 * loaded an hour ago, so `age_days` is reported rather than left to the caller to subtract.
 */
export default defineTool({
  name: 'pro_gtfs_feeds',
  description:
    "Yuklangan GTFS feedlar ro'yxati: identifikator, manba, qachon yuklangan, necha kunlik, har jadvalda " +
    "qancha qator. feed parametrlari shu ro'yxatdan tanlanadi.",
  category: 'gtfs',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      feed: { type: 'string', description: 'Faqat shu feedni qaytar (qisman nom ham yetadi)' },
    },
    additionalProperties: false,
  },
  async handler(input) {
    const p = view(input);
    const wanted = strOrEmpty(p, 'feed');
    const db = await openGtfsDb();
    const rows = prepared(
      db,
      'select feed_id, source, loaded_at_ms, counts, warnings from feeds order by loaded_at_ms desc',
    ).all() as Array<{
      feed_id: string;
      source: string;
      loaded_at_ms: number;
      counts: string;
      warnings: string;
    }>;

    const chosen = wanted ? rows.filter((row) => row.feed_id.includes(wanted)) : rows;
    const now = Date.now();
    return jsonBlock('GTFS feeds', {
      ok: true,
      database: gtfsDbPath(),
      total: rows.length,
      returned: chosen.length,
      feeds: chosen.map((row) => ({
        feed_id: row.feed_id,
        source: row.source,
        loaded_at_ms: row.loaded_at_ms,
        age_days: Math.round(((now - row.loaded_at_ms) / 86_400_000) * 10) / 10,
        counts: JSON.parse(row.counts) as Record<string, number>,
        warnings: (JSON.parse(row.warnings) as string[]).length,
      })),
      ...(rows.length === 0 ? { note: 'hech narsa yuklanmagan — boshlang: pro_gtfs_load' } : {}),
    });
  },
});
