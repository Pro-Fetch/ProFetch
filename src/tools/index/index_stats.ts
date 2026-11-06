import { defineTool } from '../../core/tool.js';
import { jsonBlock } from '../../core/format.js';
import { indexStats } from '../../core/local-index.js';

/**
 * pro_index_stats — the state of the local index, including whether it can be trusted
 * Pack: index (pro-fetch)
 *
 * `index_matches_docs` is the number this file exists for. FTS5 runs here as an external-content table:
 * the searchable copy and the stored document are two views of one row, kept in step by triggers. If a
 * trigger ever stops firing, searches quietly miss documents that are plainly present in the table — the
 * worst kind of failure, because it looks exactly like "there is nothing about that". So the two counts
 * are reported side by side and a mismatch is stated in the answer, not left to be discovered.
 */
export default defineTool({
  name: 'pro_index_stats',
  description:
    'Indeks holati: hujjatlar, indeks qatorlari, havolalar, qayta o‘qish jadvali, fayl hajmi, FTS5 ' +
    'mavjudligi va indeks/hujjat sonlarining mosligi.',
  category: 'index',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: { type: 'object', properties: {}, required: [] },
  async handler() {
    const stats = await indexStats();
    return jsonBlock('Indeks holati', {
      ok: true,
      ...stats,
      ...(stats.index_matches_docs
        ? {}
        : {
            warning:
              `indeks qatorlari (${stats.indexed_rows}) hujjatlar soniga (${stats.documents}) teng emas — ` +
              'qidiruv ba’zi hujjatlarni ko‘rmayapti. Tuzatish: pro_index_rebuild.',
          }),
      note:
        'joylashuv PRO_FETCH_INDEX_PATH bilan (standart ~/.pro-fetch/index.sqlite). Bu fayl server holati, ' +
        'foydalanuvchi natijasi emas.',
    });
  },
});
