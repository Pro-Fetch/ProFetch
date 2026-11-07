import { defineTool } from '../../core/tool.js';
import { failJson, jsonBlock } from '../../core/format.js';
import { num, strOrEmpty, view } from '../../core/input.js';
import { fetchUrl } from '../../core/fetcher.js';
import { searchWeb } from '../../core/search-providers.js';
import { canonicalize, digestOf } from '../../core/evidence-store.js';
import { queryTerms } from '../../core/query-understanding.js';
import { rankResults, type RankableResult } from '../../core/result-ranking.js';

/**
 * pro_fetch_answer_packet — clean fragments, each with the place it came from
 * Pack: search (pro-fetch)
 *
 * ## Why this is the differentiator and not a formatting exercise
 *
 * An agent that gets ten links has to fetch ten pages, decide what is boilerplate, and then produce a
 * claim with nothing behind it. This tool does that work once and returns fragments of *page body text*
 * with the coordinates of where each came from: the URL, the character offsets into the document as it was
 * fetched, a digest of the fragment, and the time. A claim built on it can be re-checked by anybody who
 * runs the same URL again — which is the half of "proof attached" that a search API does not do at all.
 *
 * ## What it refuses to do
 *
 * - It never returns a fragment without provenance. A source that could not be read is listed in
 *   `failures` with the reason the host gave, including the block-page kind — a missing source is a fact
 *   about the web, and pretending otherwise is how a pipeline starts inventing.
 * - It does not summarise. The text is the page's own, cut at word boundaries around the query's terms;
 *   any condensing is the caller's, and is then the caller's responsibility.
 * - It does not claim the fragment is still there. `checked_at_ms` is absent by design; re-checking is
 *   `pro_evidence_check`'s job, and the digest here is the thing it compares.
 */
const SCHEMA = 'pro-fetch.answer/1';

export default defineTool({
  name: 'pro_fetch_answer_packet',
  description:
    "So'rov bo'yicha saralangan manbalardan toza parchalar oladi: har parcha url, belgi offsetlari, " +
    "sha256 va o'qilgan vaqti bilan. Reklama/sahifa qobig'i emas — sahifaning o'z matni.",
  category: 'search',
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: "Savolga javob qidirilayotgan so'rov" },
      engine: { type: 'string', description: 'Manba tanlash uchun engine; bo‘sh = zanjir' },
      sources: { type: 'number', description: 'Nechta sahifa o‘qilsin (1-8, standart 3)' },
      max_fragment_chars: { type: 'number', description: 'Bir parchaning maksimal uzunligi (standart 700)' },
      rank: {
        type: 'boolean',
        description: 'Natijalarni pro_fetch_rank_results modeli bilan saralash (standart: true)',
      },
    },
    required: ['query'],
  },
  async handler(input) {
    const p = view(input);
    const query = strOrEmpty(p, 'query');
    if (!query) return failJson('Javob paketi', { error: 'query kerak' });
    const sources = Math.max(1, Math.min(8, num(p, 'sources', 3) || 3));
    const maxChars = Math.max(120, Math.min(4000, num(p, 'max_fragment_chars', 700) || 700));
    const doRank = p.rank === undefined ? true : p.rank === true;
    const started = Date.now();

    const searched = await searchWeb(query, sources * 3, { engine: strOrEmpty(p, 'engine') || undefined });
    const ordered: RankableResult[] = doRank
      ? rankResults(query, searched.results as RankableResult[])
      : searched.results;

    // One page per host: three fragments from the same publisher is one source quoted three times, and a
    // caller counting corroboration would read it as three.
    const queue: RankableResult[] = [];
    const hosts = new Set<string>();
    for (const item of ordered) {
      let host = '';
      try {
        host = new URL(item.url).hostname.replace(/^www\./, '');
      } catch {
        continue;
      }
      if (hosts.has(host)) continue;
      hosts.add(host);
      queue.push(item);
      if (queue.length >= sources) break;
    }

    const fragments: Record<string, unknown>[] = [];
    const failures: Record<string, unknown>[] = [];
    for (const item of queue) {
      let fetched;
      try {
        fetched = await fetchUrl(item.url, { useCache: true });
      } catch (error) {
        failures.push({ url: item.url, reason: (error as Error).message.slice(0, 200) });
        continue;
      }
      if (fetched.blocked) {
        failures.push({
          url: item.url,
          status: fetched.status,
          reason: fetched.blocked.kind,
          marker: fetched.blocked.marker,
          hint: fetched.blocked.hint,
        });
        continue;
      }
      const body = canonicalize(fetched.markdown);
      const window = bestWindow(body, query, maxChars);
      if (!window) {
        failures.push({
          url: item.url,
          status: fetched.status,
          reason: 'page body read, but no passage contains any query term',
          body_chars: body.length,
        });
        continue;
      }
      const digest = digestOf(window.text);
      fragments.push({
        text: window.text,
        source: {
          url: fetched.url,
          site: new URL(fetched.url).hostname.replace(/^www\./, ''),
          title: item.title,
          offset_chars: [window.start, window.end],
          body_chars: body.length,
          sha256: digest.sha256,
          words: digest.words,
          status: fetched.status,
          read_at_ms: Date.now(),
          cached: fetched.cached,
        },
      });
    }

    return jsonBlock('Javob paketi', {
      ok: true,
      schema: SCHEMA,
      query,
      generated_at_ms: Date.now(),
      took_ms: Date.now() - started,
      provider: searched.provider,
      ranked: doRank,
      sources_considered: ordered.length,
      sources_requested: sources,
      count: fragments.length,
      fragments,
      failures,
      ...(fragments.length === 0
        ? {
            empty: true,
            note:
              'birorta manbadan parcha olinmadi — yuqoridagi failures sabablari bilan ko‘rsatilgan. Bu ' +
              '"javob yo‘q" emas: bu "biz o‘qib bo‘lolmadik" deganidir, va farq qidiruvchini aldaydi.',
          }
        : {}),
      limits:
        'matn sahifaning o‘zidan, qisqartirilmagan; xulosa qilish chaqiruvchiga tegishli. parcha hozir ham ' +
        'shu yerda ekanini tekshirish uchun pro_evidence_check ishlatiladi — bu yerda faqat digest bor.',
    });
  },
});

/**
 * The passage of the body that carries the most query terms, snapped to paragraph boundaries.
 *
 * Ties go to the earlier passage: a page answers its own title first, and choosing the later occurrence
 * would be quoting the footnote instead of the claim. The window starts on a grid and is then snapped
 * back and forward to the nearest blank line within `SNAP_LIMIT` characters — measured before this, the
 * grid cut a fragment mid-word ("OIN queries from S3"), which reads as a slice rather than as a passage
 * somebody wrote.
 */
const SNAP_LIMIT = 160;

export function bestWindow(
  body: string,
  query: string,
  maxChars: number,
): { text: string; start: number; end: number } | undefined {
  if (!body) return undefined;
  const terms = queryTerms(query);
  if (terms.length === 0) return undefined;
  const step = Math.max(200, Math.floor(maxChars / 3));
  let best: { text: string; start: number; end: number; hits: number } | undefined;
  for (let grid = 0; grid < body.length; grid += step) {
    const start = snapBack(body, grid);
    const rawEnd = Math.min(body.length, start + maxChars);
    const end = snapForward(body, rawEnd, start + 40);
    const text = body.slice(start, end).trim();
    if (text.length < 40) continue;
    const lower = text.toLowerCase();
    const hits = terms.filter((term) => lower.includes(term)).length;
    if (hits === 0) continue;
    // Density before position: a window that reaches the answer by swallowing the paragraph before it
    // has the same hit count as the passage itself, and the shorter one is the passage somebody wrote.
    const bestDensity = best ? best.hits / best.text.length : -1;
    if (!best || hits > best.hits || (hits === best.hits && hits / text.length > bestDensity)) {
      best = { text, start, end, hits };
    }
  }
  return best ? { text: best.text, start: best.start, end: best.end } : undefined;
}

/** Back to the blank line before the grid point, if one is close enough to be the real paragraph start. */
function snapBack(body: string, at: number): number {
  if (at === 0) return 0;
  const boundary = body.lastIndexOf('\n\n', at);
  if (boundary < 0 || at - boundary > SNAP_LIMIT) return at;
  return boundary + 2;
}

/** Forward to the blank line after the cut, so a fragment does not end mid-sentence. */
function snapForward(body: string, at: number, floor: number): number {
  if (at >= body.length) return body.length;
  const boundary = body.indexOf('\n\n', at);
  if (boundary < 0) return body.length;
  if (boundary - at > SNAP_LIMIT) return backToWord(body, at);
  return Math.max(floor, boundary);
}

function backToWord(text: string, at: number): number {
  const space = text.lastIndexOf(' ', at);
  return space > at - 200 ? space : at;
}
