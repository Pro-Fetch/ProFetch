/**
 * Result ranking: an order with a reason attached to every move.
 *
 * ## What this is not
 *
 * It is not a learned ranker. A ranker needs labelled judgements — thousands of queries with humans
 * saying which result answered them — and this repository has none, so anything claiming to be one would
 * be a weight list wearing a costume. What is here is three signals that can be *computed from data this
 * server actually holds*, each returned with its own number and its own explanation, so a worse order can
 * be argued about instead of merely noticed.
 *
 * 1. **coverage** — how much of the query's own terms appear in the result. Not relevance: it is the
 *    overlap, which is measurable and which a caller can recompute from the same two strings.
 * 2. **authority** — inbound links *from our own crawl graph* (`local-index`). An empty graph scores
 *    everything zero and says so, because "we have not seen links to this site" and "this site is weak"
 *    are different sentences and must not collapse into one number.
 * 3. **freshness** — decay from a date the result, the index, or the provider supplied. When no date
 *    exists the term is neutral and the basis says `date unknown`; it is never silently treated as new.
 *
 * Near-duplicates are collapsed by title overlap before scoring, and the collapse is reported: five
 * syndicated copies of one story are five results only to a ranker that is not looking.
 */

import { queryTerms } from './query-understanding.js';

export interface RankableResult {
  title: string;
  url: string;
  snippet: string;
  published_date?: string;
}

export interface ScoredResult extends RankableResult {
  score: number;
  components: { coverage: number; authority: number; freshness: number };
  /** Why each component has the number it has — the part a caller can audit. */
  basis: { coverage: string; authority: string; freshness: string };
  site: string;
  duplicate_of?: string;
}

export interface RankWeights {
  coverage: number;
  authority: number;
  freshness: number;
}

/** Stated, not tuned: there is no labelled corpus here to tune against. */
export const DEFAULT_WEIGHTS: RankWeights = { coverage: 0.45, authority: 0.3, freshness: 0.25 };

/** Half-life in days. Thirty days old is half as fresh as new; that is the whole model. */
const FRESHNESS_HALF_LIFE_DAYS = 30;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Parse a date from whatever the caller has: ISO, RFC-2822, or a bare year.
 * Returns `undefined` rather than a guess — an unknown date must stay unknown through the whole model.
 */
export function parseDate(value?: string): number | undefined {
  if (!value) return undefined;
  const text = String(value).trim();
  const iso = Date.parse(text);
  if (!Number.isNaN(iso)) return iso;
  const year = /^(19|20)\d{2}$/.exec(text);
  if (year) return Date.UTC(Number(text), 0, 1);
  return undefined;
}

export interface AuthorityInput {
  /** Inbound links from this installation's own crawl graph, by host. */
  byHost: Record<string, number>;
  /** Whether the graph has anything in it at all. Empty is not the same as zero-scored. */
  graph_empty: boolean;
}

export interface RankOptions {
  weights?: RankWeights;
  authority?: AuthorityInput;
  /** Dates by URL, from the index or the provider. Missing entries stay unknown. */
  datesByHost?: Record<string, number>;
  nowMs?: number;
}

/**
 * Titles must share both a ratio and substance to count as the same story.
 *
 * A ratio alone over-folded in testing: two different pages titled "SQLite" share 100% of their title
 * terms and were collapsed into one. Dropping a real result is worse than showing a near-twin, so three
 * shared terms are required — which a headline has and a two-word title does not.
 */
const DUPLICATE_RATIO = 0.85;
const DUPLICATE_MIN_SHARED = 3;

function isTwin(key: Set<string>, previous: Set<string>): boolean {
  if (key.size === 0 || previous.size === 0) return false;
  let shared = 0;
  for (const term of previous) if (key.has(term)) shared += 1;
  if (shared < DUPLICATE_MIN_SHARED) return false;
  return shared / (key.size + previous.size - shared) >= DUPLICATE_RATIO;
}

/**
 * Rank a result set. The order is the output; the `basis` on every result is the point.
 */
export function rankResults(query: string, results: RankableResult[], options: RankOptions = {}): ScoredResult[] {
  const weights = options.weights ?? DEFAULT_WEIGHTS;
  const now = options.nowMs ?? Date.now();
  const terms = new Set(queryTerms(query));
  const authority = options.authority ?? { byHost: {}, graph_empty: true };

  // Near-duplicate collapse first: a ranker that scores five syndicated copies of one story has not
  // ranked them, it has counted them five times. `duplicatesOf` reports what was folded.
  const seen: Array<{ key: Set<string>; url: string }> = [];
  const kept: RankableResult[] = [];
  for (const item of results) {
    const key = new Set(queryTerms(item.title || item.url));
    if (seen.some((previous) => isTwin(key, previous.key))) continue;
    seen.push({ key, url: item.url });
    kept.push(item);
  }

  const scored = kept.map((item) => {
    const site = hostOf(item.url);
    const haystack = new Set(queryTerms(`${item.title} ${item.snippet} ${item.url}`));
    const hit = [...terms].filter((term) => haystack.has(term)).length;
    const coverage = terms.size === 0 ? 0 : hit / terms.size;

    const inbound = authority.byHost[site] ?? 0;
    const authorityScore = authority.graph_empty ? 0 : Math.log1p(inbound) / Math.log1p(50);
    const authorityBasis = authority.graph_empty
      ? 'our crawl graph is empty — authority is neutral for every result, not zero for this one'
      : inbound > 0
        ? `${inbound} inbound link(s) from pages this installation fetched (log-scaled, cap 50)`
        : 'this installation has not seen a link to this site — that is unknown, not weak';

    const knownMs = parseDate(item.published_date) ?? options.datesByHost?.[site];
    const ageDays = knownMs === undefined ? undefined : Math.max(0, (now - knownMs) / 86_400_000);
    const freshness = ageDays === undefined ? 0.5 : Math.pow(0.5, ageDays / FRESHNESS_HALF_LIFE_DAYS);
    const freshnessBasis =
      ageDays === undefined
        ? 'date unknown — neutral 0.5, not treated as new'
        : `about ${Math.round(ageDays)} day(s) old, half-life ${FRESHNESS_HALF_LIFE_DAYS}`;

    return {
      ...item,
      site,
      score:
        Math.round(
          (weights.coverage * coverage +
            weights.authority * Math.min(1, authorityScore) +
            weights.freshness * freshness) *
            1000,
        ) / 1000,
      components: {
        coverage: Math.round(coverage * 1000) / 1000,
        authority: Math.round(Math.min(1, authorityScore) * 1000) / 1000,
        freshness: Math.round(freshness * 1000) / 1000,
      },
      basis: {
        coverage: `${hit}/${terms.size} query term(s) appear in title+snippet+url`,
        authority: authorityBasis,
        freshness: freshnessBasis,
      },
    };
  });

  scored.sort((a, b) => b.score - a.score || a.site.localeCompare(b.site));
  return scored;
}

/** Which URLs were folded into which, so a collapsed result set can be audited. */
export function duplicatesOf(results: RankableResult[]): Record<string, string[]> {
  const seen: Array<{ key: Set<string>; url: string }> = [];
  const out: Record<string, string[]> = {};
  for (const item of results) {
    const key = new Set(queryTerms(item.title || item.url));
    const twin = seen.find((previous) => isTwin(key, previous.key));
    if (twin) (out[twin.url] ??= []).push(item.url);
    else seen.push({ key, url: item.url });
  }
  return out;
}
