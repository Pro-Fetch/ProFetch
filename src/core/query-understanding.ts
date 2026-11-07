/**
 * Query understanding: what the words of a search say the asker means.
 *
 * ## Why this is a separate module and not a bigger model
 *
 * The four things a search pipeline needs before it queries an index are all decidable from the query
 * string itself, and each one here states the method that decided it:
 *
 * - **language** — delegated to `pro_fetch_language_detect`. There is already one detector in this
 *   server; a second one in a second place is a second opinion waiting to disagree with the first.
 * - **intent** — marker words, listed below in full. This is a classifier in the honest sense: it maps a
 *   string to one of five classes, and it is wrong in a way a reader can see and check, rather than a
 *   score nobody can question. Anything better needs a model, and this server does not run one.
 * - **spelling** — the suggestion comes from Google's autocomplete endpoint, i.e. from what real people
 *   typed, not from an edit-distance guess over a wordlist. Edit distance is used only to pick *which*
 *   returned suggestion is closest to the original query, which is arithmetic, not judgement.
 * - **expansion** — related queries, same source. A thesaurus would be my vocabulary pretending to be
 *   the world's.
 *
 * Every field carries `basis`, and `pro_fetch_query_understand` refuses the network half when the caller asks
 * for `network: false` instead of quietly returning less and saying nothing.
 */

export type QueryIntent = 'buy' | 'news' | 'code' | 'definition' | 'howto' | 'informational';

/**
 * The marker lists, in full, because a classifier whose features are hidden cannot be argued with.
 * Lower-cased substring matches. Uzbek markers are included: this server answers in both languages.
 */
export const INTENT_MARKERS: Record<Exclude<QueryIntent, 'informational'>, readonly string[]> = {
  buy: [
    'buy',
    'price',
    'pricing',
    'cheap',
    'deal',
    'coupon',
    'purchase',
    'order',
    'for sale',
    'shop',
    'sotib olish',
    'narxi',
    'narzi',
    'arzon',
    'chegirma',
    'sotish',
  ],
  news: ['news', 'today', 'breaking', 'latest', 'announced', 'report', 'yangilik', "so'nggi", 'bugun', "e'lon"],
  code: [
    'error',
    'exception',
    'traceback',
    'stack overflow',
    'github',
    'api',
    'function',
    'class',
    'npm',
    'pypi',
    'compile',
    'syntax',
    'xato',
    'kod',
    'funksiya',
  ],
  definition: ['what is', 'who is', 'define', 'definition', 'meaning of', 'means', 'nima', "ta'rif", "ma'nosi"],
  howto: ['how to', 'how do', 'guide', 'tutorial', 'steps', 'recipe', 'qanday', "yo'li", "qilib ko'rsatish"],
};

/**
 * Which intent the query looks like, and the marker that said so.
 *
 * Order is the list's own and is stated rather than tuned: a query matching both `buy` and `howto` is a
 * purchase question, because money beats instructions in what the caller then does with the results.
 */
export function classifyIntent(query: string): { intent: QueryIntent; marker: string; basis: string } {
  const text = ` ${String(query).toLowerCase().replace(/\s+/g, ' ')} `;
  for (const intent of ['buy', 'news', 'code', 'definition', 'howto'] as const) {
    const marker = INTENT_MARKERS[intent].find((needle) => text.includes(needle.toLowerCase()));
    if (marker) return { intent, marker, basis: `marker word "${marker}" in the ${intent} list` };
  }
  return { intent: 'informational', marker: '', basis: 'no marker from any list matched' };
}

/** Words a search index gains nothing from. Kept short and visible, not a downloaded stopword file. */
export const QUERY_STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'to',
  'in',
  'on',
  'for',
  'is',
  'are',
  'it',
  'this',
  'that',
  'with',
  'about',
  'what',
  'how',
  'why',
  'qanday',
  'nima',
  'nechta',
  'haqida',
  'bilan',
  'uchun',
]);

export function queryTerms(query: string): string[] {
  return String(query)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s+#.-]+/gu, ' ')
    .split(/[\s.]+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 1 && !QUERY_STOPWORDS.has(term));
}

/** Levenshtein, bounded to the two rows — used only to rank returned suggestions by distance. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * Pick the suggestion closest to the query, ignoring the ones that merely extend it.
 *
 * Autocomplete returns continuations as well as corrections, and the two must not be confused:
 *
 * - a **continuation** (`sqlite wal checkpoint d3` for `sqlite wal`) contains every word of the query and
 *   adds more — it answers a longer question than the one asked, so it is skipped on term count;
 * - a **correction** (`sqlite wal` for `sqllite wal`) changes a word, which is the whole point of asking.
 *
 * The first version tested "did the candidate drop a word of the query", which got both cases backwards:
 * it rejected every real correction and accepted every continuation. The two are pinned in
 * `tests/query-understanding.test.ts`, and the rule is now term count, then edit distance.
 */
export function nearestSuggestion(
  query: string,
  suggestions: readonly string[],
): { suggested: string; distance: number } {
  const normalized = String(query).toLowerCase().trim();
  const wanted = queryTerms(normalized).length;
  let best = { suggested: query, distance: Number.POSITIVE_INFINITY };
  for (const raw of suggestions) {
    const candidate = String(raw).toLowerCase().trim();
    if (!candidate || candidate === normalized) continue;
    if (queryTerms(candidate).length > wanted) continue;
    const distance = editDistance(normalized, candidate);
    if (distance >= best.distance) continue;
    best = { suggested: candidate, distance };
  }
  return best.distance === Number.POSITIVE_INFINITY ? { suggested: query, distance: 0 } : best;
}
