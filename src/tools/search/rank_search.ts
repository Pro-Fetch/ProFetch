import { defineTool } from '../../core/tool.js';
import { failJson, jsonBlock } from '../../core/format.js';
import { num, strOrEmpty, view } from '../../core/input.js';
import { searchWeb } from '../../core/search-providers.js';
import { DEFAULT_WEIGHTS, duplicatesOf, rankResults, type RankableResult } from '../../core/result-ranking.js';
import { indexAuthority, searchIndex } from '../../core/local-index.js';

/**
 * pro_fetch_rank_results — order results, and , and say why each one moved
 * Pack: search (pro-fetch)
 *
 * Feed it the output of `pro_fetch_web_search` (or let it fetch with `engine`), and it returns the same
 * results with three computed signals, the weights applied to them, and a basis line per result.
 *
 * **What it deliberately does not do:** it is not a learned ranker and there is no spam classifier.
 * A ranker needs labelled judgements and this repository has none; a spam list would be somebody's
 * opinion about domains, presented as a fact. The two things it does use — term coverage and links this
 * installation actually saw — are recomputable from the answer itself. If the crawl graph is empty,
 * authority is neutral for everyone and the answer says that, instead of scoring every site zero and
 * letting the number look like a judgement.
 */
export default defineTool({
  name: 'pro_fetch_rank_results',
  description:
    "Natijalarni qayta saralaydi: so'rov qamrovi + o'z indeksimizdagi havola avtoriteti + yangilik. " +
    'Har natijaga nech ochko va nega — sababi bilan. O‘qitilgan ranker emas, spam klassifikatori emas.',
  category: 'search',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: "So'rov (qamrov shundan hisoblanadi)" },
      results: {
        type: 'array',
        description:
          "Saralanadigan natijalar (pro_fetch_web_search chiqishi). Bo'sh bo'lsa va engine berilsa, o'sha " +
          'yerdan oladi',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            url: { type: 'string' },
            snippet: { type: 'string' },
            published_date: { type: 'string' },
          },
        },
      },
      engine: { type: 'string', description: 'results berilmasa, shu engine’dan so‘rab oladi' },
      limit: { type: 'number', description: 'Qaytariladigan natijalar (standart 10)' },
      use_index: { type: 'boolean', description: 'Avtoritet va sanani lokal indeksdan olish (standart: true)' },
    },
    required: ['query'],
  },
  async handler(input) {
    const p = view(input);
    const query = strOrEmpty(p, 'query');
    if (!query) return failJson('Natijalarni saralash', { error: 'query kerak' });
    const limit = Math.max(1, Math.min(50, num(p, 'limit', 10) || 10));
    const useIndex = p.use_index === undefined ? true : p.use_index === true;

    let items = Array.isArray(p.results) ? (p.results as RankableResult[]) : [];
    let fetchedFrom = 'provided';
    if (items.length === 0) {
      const engine = strOrEmpty(p, 'engine');
      if (!engine) {
        return failJson('Natijalarni saralash', {
          error: 'results bo‘sh va engine berilmagan — saralanadigan narsa yo‘q',
          hint: "pro_fetch_web_search natijasini results ga bering, yoki engine='hackernews' kabi tanlang",
        });
      }
      const searched = await searchWeb(query, limit, { engine });
      items = searched.results as RankableResult[];
      fetchedFrom = searched.provider;
    }

    let authority = { byHost: {} as Record<string, number>, graph_empty: true };
    const datesByHost: Record<string, number> = {};
    let indexNote = 'lokal indeks so‘ralmadi (use_index: false)';
    if (useIndex) {
      try {
        const rows = await indexAuthority(200);
        authority = {
          byHost: Object.fromEntries(rows.map((row) => [row.site, row.inbound])),
          graph_empty: rows.length === 0,
        };
        const hits = await searchIndex(query, { limit: 25 });
        for (const hit of hits.hits) {
          const host = hit.site;
          if (host && (!datesByHost[host] || hit.fetched_at_ms > datesByHost[host]))
            datesByHost[host] = hit.fetched_at_ms;
        }
        indexNote = authority.graph_empty
          ? 'indeksda birorta havola yo‘q — avtoritet hamma uchun neytral; pro_index_fetch bilan to‘ldiring'
          : `${rows.length} sayt indeks graphimizda; eng ko‘p kirish havola: ${rows[0].site} (${rows[0].inbound})`;
      } catch (error) {
        indexNote = `lokal indeksga bo‘lmadi: ${(error as Error).message.slice(0, 140)} — avtoritet neytral`;
        authority = { byHost: {}, graph_empty: true };
      }
    }

    const ranked = rankResults(query, items, { authority, datesByHost });
    const folded = duplicatesOf(items);
    const collapsedCount = Object.values(folded).reduce((sum, list) => sum + list.length, 0);

    return jsonBlock('Saralangan natijalar', {
      ok: true,
      query,
      source: fetchedFrom,
      weights: DEFAULT_WEIGHTS,
      weights_note:
        'Raqamlar sozlangan emas — ular e’lon qilingan. O‘qitilgan ranker uchun belgilangan javob ' +
        'kerak; bu repozitoriyda yo‘q. Har ochko natijaning o‘zida qayta hisoblanishi mumkin.',
      authority_basis: indexNote,
      count: ranked.slice(0, limit).length,
      collapsed_duplicates: collapsedCount,
      ...(collapsedCount > 0 ? { folded_into: folded } : {}),
      results: ranked.slice(0, limit),
      limits: [
        'spam klassifikatori yo‘q — domen ro‘yxati fikr-mulohaza bo‘lardi, fakt emas',
        'o‘qitilgan ranker yo‘q — belgilangan korpus bo‘lmasa vazn ro‘yxati kostyum bo‘lardi',
        'avtoritet faqat O‘ZIMIZ ko‘rgan havolalar; PageRank emas va PageRank deb da’vo qilmaydi',
      ].join(' · '),
    });
  },
});
