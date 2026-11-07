import { defineTool } from '../../core/tool.js';
import { jsonBlock } from '../../core/format.js';
import { view } from '../../core/input.js';
import { engineStatuses, type EngineStatus } from '../../core/search-engines.js';

/**
 * pro_fetch_search_engines — which search engines this server can actually use
 * Pack: search (pro-fetch)
 *
 * The answer to "does pro-fetch work without an API key?" without guessing. Each row states what is known
 * about it, and `verified` is the field that keeps the claim honest:
 *
 * - `live` — this exact code path was run against the real endpoint from this machine and returned results;
 * - `endpoint` — the provider answered with its own authentication or validation error, so the URL, the verb
 *   and the credential header are proven, but the success path has not been observed because that needs a
 *   paid key. `evidence` quotes what the provider said;
 * - `operator` — reachable only at an address the operator supplies (a self-hosted SearXNG).
 *
 * Keys are never echoed. A row says which variable it wants, not what it holds.
 */

const VERIFIED_MEANS: Record<EngineStatus['verified'], string> = {
  live: 'bu mashinadan haqiqiy so‘rov bilan tekshirildi',
  endpoint: 'faqat endpoint va kalit sarlavhasi tekshirildi; natijali yo‘l kalit bilan kuzatilmagan',
  operator: 'operator sozlamasi kerak (masalan SEARXNG_URL)',
};

export default defineTool({
  name: 'pro_fetch_search_engines',
  description:
    'Qidiruv engine’lari ro‘yxati: qaysi biri kalit bilan, qaysi biri kalitsiz ishlaydi, qaysi biri nimani ' +
    'kutyapti va har biri haqida qanday dalil bor. Kalit qiymatlari ko‘rsatilmaydi.',
  category: 'search',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        description: "Faqat shu turdagi engine'lar: general, academic, news, community, packages, media, reference",
      },
      usable_only: { type: 'boolean', description: 'Faqat hozir ishlatishga tayyor bo‘lganlarini ko‘rsatish' },
    },
    required: [],
  },
  async handler(input) {
    const p = view(input);
    const kind = typeof p.kind === 'string' && p.kind.trim() ? (p.kind.trim() as EngineStatus['kind']) : '';
    const usableOnly = p.usable_only === true;
    const all = engineStatuses(kind || undefined);
    const rows = usableOnly ? all.filter((engine) => engine.usable) : all;
    const risky = all.filter((engine) => engine.legal === 'serp_scraping_reseller');
    return jsonBlock('Qidiruv engine’lari', {
      total: all.length,
      usable: all.filter((engine) => engine.usable).length,
      needs_key: all.filter((engine) => !engine.usable && engine.needs.length > 0).length,
      keyless_unavailable: all.filter((engine) => !engine.usable && engine.needs.length === 0).length,
      by_legality: Object.entries(
        all.reduce<Record<string, number>>((tally, engine) => {
          tally[engine.legal] = (tally[engine.legal] ?? 0) + 1;
          return tally;
        }, {}),
      )
        .sort((a, b) => b[1] - a[1])
        .reduce<Record<string, number>>((out, [key, value]) => ({ ...out, [key]: value }), {}),
      warning:
        risky.length === 0
          ? ''
          : `${risky.map((engine) => engine.id).join(', ')} — bu engine’lar Google natijalarini skrabing ` +
            "qilib qayta sotadi. Google o'z shartlarida ham skrabingni, ham natijani qayta tarqatishni " +
            'taqiqlaydi: chaqirish mumkin, biznes poydevori qilish mumkin emas. Halol yo‘l — o‘zingizning ' +
            'indeksingiz (pro_index_*) yoki rasmiy API (google-cse).',
      note:
        'verified=live — bu mashinada haqiqiy so‘rov bilan ko‘rilgan; verified=endpoint — provider o‘z rad ' +
        'javobini berdi (URL, metod va kalit sarlavhasi to‘g‘ri), lekin natijali yo‘l kalitsiz kuzatilmadi; ' +
        'verified=operator — so‘rov manzili operatornikiga bog‘liq. legal maydoni maʼlumot qanday olinganini ' +
        '(official_api | serp_scraping_reseller | public_feed | undocumented_endpoint | self_hosted), terms ' +
        'esa provayder shartlarining o‘zini aytadi.',
      engines: rows.map((engine) => ({
        ...engine,
        verified_means: VERIFIED_MEANS[engine.verified],
        usable: engine.usable,
      })),
    });
  },
});
