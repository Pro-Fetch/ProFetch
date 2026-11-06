import { defineTool } from '../../core/tool.js';
import { jsonBlock } from '../../core/format.js';
import { num, view } from '../../core/input.js';
import { indexAuthority } from '../../core/local-index.js';

/**
 * pro_index_authority — which sites the pages we read actually vouch for
 * Pack: index (pro-fetch)
 *
 * This is the only authority signal this server can honestly produce, and it says what it is built from:
 * links between documents **this installation fetched itself**. It is not PageRank and it does not claim
 * to be — it has no web to rank against, only the graph it has seen. `from_distinct_sites` is why both
 * counts are given: ten links from one site is one publisher citing itself ten times, and that is not a
 * vote.
 */
export default defineTool({
  name: 'pro_index_authority',
  description:
    'Indeksdagi havolalardan sayt ochkolari: nechta kirish havola va ular nechta XILO saytdan keldi. ' +
    'Faqat o‘zimiz o‘qigan sahifalar hisobga olinadi.',
  category: 'index',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Nechta sayt (standart 20)' },
    },
    required: [],
  },
  async handler(input) {
    const p = view(input);
    const limit = Math.max(1, Math.min(200, num(p, 'limit', 20) || 20));
    const rows = await indexAuthority(limit);
    return jsonBlock('Indeksdagi sayt ochkalari', {
      ok: true,
      count: rows.length,
      basis: 'this installation’s own crawl graph — not a web-wide link index',
      ...(rows.length === 0
        ? {
            empty: true,
            note:
              'hozircha birorta havola yozilmagan. pro_index_fetch sahifadagi havolalarni ham indekslaydi; ' +
              'yoki pro_index_put bilan links[] bering.',
          }
        : {}),
      sites: rows,
    });
  },
});
