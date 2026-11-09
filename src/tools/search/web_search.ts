import { defineTool } from '../../core/tool.js';
import { result } from '../../core/format.js';
import { rankAndDedupeSearchResults } from '../../core/search-ranking.js';
import {
  searchAcross,
  searchWeb,
  engineById,
  SEARCH_ENGINES,
  type SearchEngineKind,
} from '../../core/search-providers.js';

/**
 * pro_fetch_web_search — multi-engine web search with ranked results
 * Pack: search (pro-fetch)
 *
 * Three ways to ask, because they answer different questions:
 *   default          the fallback chain — the best configured engine, plus the reason each earlier one was
 *                    skipped;
 *   engine='tavily'  exactly one engine, so two indexes can be compared on the same query;
 *   combine=true     every usable engine at once, merged and deduplicated, with each engine's own outcome.
 */

const KINDS: SearchEngineKind[] = ['general', 'academic', 'news', 'community', 'packages', 'media', 'reference'];

export default defineTool({
  name: 'pro_fetch_web_search',
  description:
    'Web qidiruv. Umumiy zanjir endi FAQAT kalit bilan ishlaydi: Serper/Brave/Tavily/Exa/SerpAPI/Linkup/' +
    'DataForSEO/Google CSE/Perplexity. Kalit bo‘lmasa urinish ham qilinmaydi va xato qaytadi — akademik ' +
    'metadata “natija” bo‘lib qaytmaydi. Kalitsiz engine’lar vertikal sifatida ochiq: ' +
    'kind=academic|news|community|packages|reference|media yoki engine=wikipedia|hackernews|google-news|' +
    'duckduckgo. Bitta engine, zanjir yoki combine=true bilan so‘rash mumkin; holat: pro_fetch_search_engines.',
  category: 'search',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: "Web qidiruv so'rovi" },
      limit: { type: 'number', description: 'Natijalar soni (1-25)' },
      engine: {
        type: 'string',
        description: `Faqat shu engine (${SEARCH_ENGINES.map((item) => item.id).join(', ')}). Bo‘sh = zanjir.`,
      },
      kind: { type: 'string', description: `Engine turini cheklash: ${KINDS.join(', ')}.` },
      budget_ms: {
        type: 'number',
        description: 'combine=true da bitta engine uchun maksimal kutish (ms). 0 = cheklov yo‘q. Standart: 0',
      },
      combine: {
        type: 'boolean',
        description: "Hamda ishlaydigan barcha engine'larni so‘rab, natijalarni birlashtirish (default: false)",
      },
    },
    required: ['query'],
  },
  async handler(input) {
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    if (!query) throw new Error('query parametri kerak.');
    const limitValue = Number(input.limit ?? 10);
    const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(25, Math.floor(limitValue))) : 10;
    const engine = typeof input.engine === 'string' ? input.engine.trim() : '';
    const kind = (typeof input.kind === 'string' ? input.kind.trim() : '') as SearchEngineKind | '';
    if (kind && !KINDS.includes(kind)) throw new Error(`noma’lum kind "${kind}". Borlari: ${KINDS.join(', ')}.`);
    const combine = input.combine === true;

    if (combine) {
      const merged = await searchAcross(query, limit, {
        kind: kind || undefined,
        budgetMs: Math.max(0, Number(input.budget_ms) || 0),
      });
      return result(
        JSON.stringify(
          {
            provider: merged.provider,
            mode: 'combine',
            query,
            count: merged.results.length,
            deduplicated: merged.deduplicated,
            enginesUsed: merged.enginesUsed,
            perEngine: merged.perEngine,
            enginesSkipped: merged.enginesSkipped,
            ...(merged.results.length === 0
              ? {
                  empty: true,
                  note:
                    `${merged.perEngine.length} engine so‘raldi, hech biri natija bermadi. perEngine sabablarni ` +
                    'ko‘rsatadi: authorization_failed — kalit masalasi, unreachable yoki empty_answer — engine ' +
                    'masalasi. Bularni aralashtirish noto‘g‘ri tuzatishga olib boradi.',
                }
              : {}),
            results: merged.results,
          },
          null,
          2,
        ),
      );
    }

    const searched = await searchWeb(query, limit, { engine: engine || undefined, kind: kind || undefined });
    const ranked = rankAndDedupeSearchResults(query, searched.results, limit);
    const named = engine ? engineById(engine) : undefined;
    return result(
      JSON.stringify(
        {
          provider: searched.provider,
          mode: engine ? 'single' : 'chain',
          ...(named
            ? {
                legal: named.legal,
                terms: named.terms,
                ...(named.legal === 'serp_scraping_reseller'
                  ? {
                      legal_warning:
                        'Bu engine boshqa indeksning natijalarini skrabing qilib qayta sotadi. Chaqirish ' +
                        'huquqi kalitingizdan keladi; mahsulot poydevori sifatida ishlatish xavfi esa ' +
                        "shartnomaga bog'liq — Google o'z shartlarida skrabingni va natijani qayta " +
                        'tarqatishni taqiqlaydi.',
                    }
                  : {}),
              }
            : {}),
          query,
          count: ranked.length,
          deduplicated: searched.results.length - ranked.length,
          failedProviders: searched.failedProviders,
          enginesConfigured: searched.configured,
          enginesSkipped: searched.skipped,
          ...(ranked.length === 0
            ? {
                empty: true,
                note:
                  `"${searched.provider}" javob berdi, lekin 0 natija qaytardi — bu xato emas, bu bo‘sh javob. ` +
                  `Bu serverda ${searched.configured.length} ta engine ishlatishga tayyor; qolganlari qaysi ` +
                  'kalitni kutayotganini pro_fetch_search_engines aytadi. Muayyan manba kerak bo‘lsa ' +
                  'pro_fetch_wiki_search / pro_fetch_academic_search / pro_fetch_news_search ishlating.',
              }
            : {}),
          results: ranked,
        },
        null,
        2,
      ),
    );
  },
});
