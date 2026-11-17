import { defineTool } from '../../core/tool.js';
import { jsonBlock } from '../../core/format.js';
import { num, strOrEmpty, view } from '../../core/input.js';
import { loadFeed } from './_gtfs.js';

/**
 * pro_gtfs_load — read a GTFS zip into the local feed database
 * Category: gtfs
 *
 * ## What it does and why the answer is a summary, not the data
 *
 * A national feed holds millions of rows. Returning them would be useless to a model and fatal to a
 * context window, so this tool reports what was read — files, row counts per table, and the problems
 * found while parsing — and the following tools query the stored rows.
 *
 * ## Sources
 *
 * An `http(s)` URL is downloaded through the same safe path every other fetch uses: SSRF guard, redirect
 * budget, size cap. A local file path works too, because most agencies publish the zip and analysts
 * download it first.
 *
 * ## Reload semantics
 *
 * Loading the same feed id again replaces it inside one transaction. A caller cannot observe half a new
 * timetable and half an old one, which is what a naive delete-then-insert loop would allow.
 */
export default defineTool({
  name: 'pro_gtfs_load',
  description:
    'GTFS feedini (zip arxiv) yuklab, joyli SQLite bazasiga joylaydi: stops, routes, trips, stop_times, ' +
    'calendar. Javobda ma’lumot emas, o‘qilgan fayllar, qator sonlari va topilgan xatolar qaytadi — ' +
    'keyingi savollar pro_gtfs_stops / pro_gtfs_validate orqali beriladi. url http(s) yoki lokal fayl yo‘li.',
  category: 'gtfs',
  annotations: { readOnlyHint: false, openWorldHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'GTFS zip manzili: https://… yoki lokal fayl yo‘li' },
      feed: { type: 'string', description: 'Feed identifikatori; bo‘sh bo‘lsa manzildan yasaladi' },
      max_bytes: { type: 'number', description: 'Yuklab olishning eng katta hajmi (standart 134217728 = 128 MB)' },
    },
    required: ['url'],
    additionalProperties: false,
  },
  async handler(input) {
    const p = view(input);
    const source = strOrEmpty(p, 'url');
    if (!source) return jsonBlock('GTFS load', { ok: false, error: 'url kerak' });
    const feedId = strOrEmpty(p, 'feed');
    const maxBytes = num(p, 'max_bytes', 128 * 1024 * 1024);

    const loaded = await loadFeed(source, { feedId, maxBytes });
    return jsonBlock('GTFS load', {
      ok: true,
      ...loaded,
      next: [
        'pro_gtfs_validate — feedni to‘liq tekshirish',
        'pro_gtfs_stops — bekalarni qidirish',
        'pro_gtfs_feeds — yuklangan feedlar ro‘yxati',
      ],
    });
  },
});
