import { defineTool } from '../../core/tool.js';
import { jsonBlock } from '../../core/format.js';
import { reindex } from '../../core/local-index.js';

/**
 * pro_index_rebuild — rebuild the searchable copy from the stored documents
 * Pack: index (pro-fetch)
 *
 * FTS5 with an external-content table can be told to rebuild itself from its source rows. This is the fix
 * `pro_index_stats` points at when its two counts disagree, and it is a write: it changes the database
 * file, so read-only mode refuses it like any other write.
 */
export default defineTool({
  name: 'pro_index_rebuild',
  description: 'FTS indeksini docs jadvalidan qayta quradi. pro_index_stats nomoslikni ko‘rsatsa shu kerak.',
  category: 'index',
  inputSchema: { type: 'object', properties: {}, required: [] },
  async handler() {
    const result = await reindex();
    return jsonBlock('Indeks qayta qurildi', {
      ok: result.matched,
      ...result,
      ...(result.matched
        ? {}
        : {
            error:
              `qayta qurishdan keyin ham sonlar farq qiladi (${result.documents} hujjat, ` +
              `${result.indexed_rows} qator) — bu trigger muammosi emas, FTS5 imkoniyati bilan bog‘liq bo‘lishi mumkin.`,
          }),
    });
  },
});
