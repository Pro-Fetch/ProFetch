import { defineTool } from '../../core/tool.js';
import { failJson, jsonBlock } from '../../core/format.js';
import { bool, strOrEmpty, view } from '../../core/input.js';
import { dispatch } from '../../core/tool.js';
import { classifyIntent, nearestSuggestion, queryTerms } from '../../core/query-understanding.js';

/**
 * pro_query_understand — what a query means before an index is asked
 * Pack: search (pro-fetch)
 *
 * The step every search pipeline has and this server did not: turn the words into a language, an intent,
 * a corrected form and related terms, then use those to decide *where* to search and *how* to rank.
 *
 * Each field names the method that produced it, and nothing here is a model:
 *
 * - `language` comes from `pro_fetch_language_detect` — the server's one detector, called, not copied;
 * - `intent` comes from the marker lists in `query-understanding.ts`, which the answer quotes back, so a
 *   wrong classification can be argued with by looking at the list;
 * - `spelling` and `expansion` come from what people actually typed (Google's autocomplete endpoint), and
 *   `network: false` refuses them outright rather than returning less and staying quiet about it.
 */
export default defineTool({
  name: 'pro_query_understand',
  description:
    "So'rovni tahlil qiladi: til, niyat (buy|news|code|definition|howto|informational), imla taklifi va " +
    'bog‘liq so‘zlar. Har maydon qanday usul bilan aniqlangani yozilgan.',
  category: 'search',
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: "Tahlil qilinadigan so'rov" },
      network: {
        type: 'boolean',
        description:
          'false — imla va kengaytirish uchun tarmoqqa chiqmaydi (til va niyat baribir hisoblanadi). ' +
          'Standart: true',
      },
    },
    required: ['query'],
  },
  async handler(input) {
    const p = view(input);
    const query = strOrEmpty(p, 'query');
    if (!query) return failJson("So'rov tahlili", { error: 'query kerak' });
    const wantNetwork = p.network === undefined ? true : bool(p, 'network', true);
    const started = Date.now();

    const language = await dispatch('pro_fetch_language_detect', { text: query });
    const parsed = language.isError ? {} : jsonOf(language);
    const likely = Array.isArray(parsed.likely_languages) ? parsed.likely_languages : [];
    const lang = language.isError
      ? { code: 'und', basis: `pro_fetch_language_detect refused: ${textOf(language).slice(0, 120)}` }
      : {
          code: typeof likely[0] === 'string' ? likely[0] : 'und',
          scripts: parsed.scripts ?? [],
          basis:
            typeof likely[0] === 'string'
              ? 'pro_fetch_language_detect: birinchi likely_languages yozuvi'
              : 'pro_fetch_language_detect: likely_languages bo‘sh — skript(lar) ko‘rindi, lekin tilga ' +
                'nisbatan ishonch yetmadi. Bu bilmaslik, taxmin emas.',
        };

    const intent = classifyIntent(query);
    const terms = queryTerms(query);

    const spelling = { suggested: query, distance: 0, source: 'not asked', changed: false };
    const expansion: string[] = [];
    let networkError = '';
    if (wantNetwork) {
      try {
        const suggest = await dispatch('pro_fetch_search_suggest', { query });
        if (suggest.isError) throw new Error(textOf(suggest).slice(0, 160));
        const list = jsonOf(suggest).results;
        const candidates = Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
        const nearest = nearestSuggestion(query, candidates);
        spelling.suggested = nearest.suggested;
        spelling.distance = nearest.distance;
        spelling.changed = nearest.suggested.toLowerCase() !== query.toLowerCase();
        spelling.source =
          candidates.length > 0
            ? `Google autocomplete: ${candidates.length} taklifdan eng yaqini (Levenshtein)`
            : 'Google autocomplete javob berdi, lekin taklif qaytmadi — hech qanday tuzatish ko‘rib chiqilmadi';
        expansion.push(...candidates.filter((item) => item !== nearest.suggested).slice(0, 8));
      } catch (error) {
        networkError = (error as Error).message;
        spelling.source = `tarmoq javob bermadi: ${networkError.slice(0, 120)}`;
      }
    } else {
      spelling.source = "network: false — imla tekshiruvi qilinmadi, so'rov o'zgarmas holda qaytdi";
    }

    return jsonBlock("So'rov tahlili", {
      ok: true,
      query,
      took_ms: Date.now() - started,
      language: lang,
      intent: { class: intent.intent, marker: intent.marker, basis: intent.basis },
      terms,
      spelling,
      expansion,
      ...(networkError ? { network_error: networkError } : {}),
      how_to_use:
        "intent yangilik bo'lsa pro_fetch_news_search yoki engine='google-news'; code bo'lsa " +
        "pro_fetch_code_search; xarid bo'lsa pro_fetch_market_search. Bo'sh indeksda qidirishdan oldin " +
        'spelling.suggested ni sinab ko‘ring.',
    });
  },
});

function textOf(result: { content?: Array<{ type?: string; text?: string }> }): string {
  return (result.content ?? [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text ?? '')
    .join('\n');
}

function jsonOf(result: { content?: Array<{ type?: string; text?: string }> }): Record<string, any> {
  const match = /(\{[\s\S]*\})/.exec(textOf(result));
  return match ? JSON.parse(match[1]) : {};
}
