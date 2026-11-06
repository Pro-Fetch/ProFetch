import { defineTool } from '../../core/tool.js';
import { jsonBlock, failJson } from '../../core/format.js';
import { num, strOrEmpty, view } from '../../core/input.js';
import { searchIndex } from '../../core/local-index.js';

/**
 * pro_index_search — ask what this installation has already read
 * Pack: index (pro-fetch)
 *
 * The point of the index is the latency: a query over what has been fetched costs about a millisecond,
 * while a call to any external engine costs hundreds. `took_ms` is in the answer for that reason — the
 * claim can be checked on the same line it is made.
 */
export default defineTool({
  name: 'pro_index_search',
  description: 'Lokal indeksda qidiruv (FTS5 + bm25). Natijada snippet, yosh soati, ochko va so‘rov davomiyligi.',
  category: 'index',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Qidiruv so‘rovi' },
      limit: { type: 'number', description: 'Natijalar soni (1-50, standart 10)' },
      site: { type: 'string', description: "Faqat shu host (masalan 'sqlite.org')" },
      kind: { type: 'string', description: 'news | docs | page | reference' },
      since_hours: { type: 'number', description: 'Shu soat ichida indekslanganlari (0 = cheklovsiz)' },
    },
    required: ['query'],
  },
  async handler(input) {
    const p = view(input);
    const query = strOrEmpty(p, 'query');
    if (!query) return failJson('Indeks qidiruvi', { error: 'query kerak' });
    const limit = Math.max(1, Math.min(50, num(p, 'limit', 10) || 10));
    const sinceHours = Math.max(0, num(p, 'since_hours', 0));
    const { hits, took_ms, matched } = await searchIndex(query, {
      limit,
      site: strOrEmpty(p, 'site') || undefined,
      kind: strOrEmpty(p, 'kind') || undefined,
      sinceMs: sinceHours > 0 ? Date.now() - sinceHours * 3600_000 : undefined,
    });
    return jsonBlock(`Indeks: ${query}`, {
      ok: true,
      query,
      took_ms,
      count: hits.length,
      matched,
      ...(hits.length === 0
        ? {
            empty: true,
            note:
              'indeksta mos hujjat yo‘q. Bu tashqi qidiruv emas: bu yerda faqat O‘ZIMIZ o‘qigan sahifalar ' +
              'bor. Bo‘sh javob normal — pro_index_fetch bilan sahifa qo‘shing yoki pro_fetch_web_search ' +
              'bilan tashqi indeksga murojaat qiling.',
          }
        : {}),
      results: hits,
    });
  },
});
