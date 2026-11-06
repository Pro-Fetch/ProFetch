import {
  SEARCH_ENGINES,
  engineById,
  enginesFor,
  type SearchEngine,
  type SearchEngineKind,
  type WebSearchResult,
} from './search-engines.js';
import { rankAndDedupeSearchResults } from './search-ranking.js';
import { log } from './log.js';

export type { WebSearchResult, SearchEngineKind };
export { SEARCH_ENGINES, engineById, enginesFor, engineStatuses } from './search-engines.js';

export interface SearchProviderResult {
  provider: string;
  results: WebSearchResult[];
  failedProviders: Array<{ provider: string; reason: string }>;
  /** Engines this server can use right now: the credentialed ones, plus the keyless scrapers. */
  configured: string[];
  /** Engines that exist but are not usable here, and what each one is waiting for. */
  skipped: Array<{ engine: string; needs: string[] }>;
}

export interface EngineOutcome {
  engine: string;
  label: string;
  kind: SearchEngineKind;
  results: number;
  ms: number;
  reason?: string;
}

/**
 * Why an engine did not answer, in words that name the fix.
 *
 * The buckets come from what the providers themselves return: a 429 is a limit, 401/403 is the key, 402 is
 * billing, 404/405 means the endpoint moved. Guessing between them is what makes a caller rotate a working
 * key or rewrite a query that was already right.
 */
function refusalReason(message: string): string {
  if (/429/.test(message)) return 'rate_limited';
  if (/HTTP 40[13]/.test(message)) return 'authorization_failed';
  if (/HTTP 402/.test(message)) return 'payment_required';
  if (/HTTP 40[45]/.test(message)) return 'endpoint_moved';
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|fetch failed|socket hang up/.test(message))
    return 'unreachable';
  return 'unavailable';
}

async function attempt(engine: SearchEngine, query: string, limit: number): Promise<WebSearchResult[]> {
  const results = await engine.search(query, limit);
  return results.filter((item) => item.url);
}

/**
 * How many engines a fan-out asks at the same instant.
 *
 * Four, not all twelve. Measured unbounded: `combine=true` opened a socket to every usable engine in the
 * same moment, and on this machine that starved the live browser suites past their 60 s hook timeout
 * (`profile-switch` went from 51 s to 194 s in the same run). Against the providers it is worse than slow —
 * twelve simultaneous requests from one client is the shape a rate limiter exists to catch, and the caller
 * spends their quota absorbing it, not ours.
 */
const FANOUT_DEFAULT = 4;

function fanoutSize(): number {
  const raw = Number(process.env.PRO_FETCH_SEARCH_FANOUT);
  if (!Number.isFinite(raw) || raw < 1) return FANOUT_DEFAULT;
  return Math.min(12, Math.floor(raw));
}

/** A pool over an async mapper. Results keep the input order, so per-engine reporting stays predictable. */
async function pool<T, R>(items: T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await run(items[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * One answer from the best engine available.
 *
 * Order is the registry's: credentialed engines that index the whole web first, then the keyless general
 * engines, then the narrower ones. An engine that returns *nothing* counts as a miss — measured on
 * 2026-11-06, `html.duckduckgo.com` answered HTTP 202 with an empty page, which is neither an error nor an
 * answer, and stopping there would have reported "the web has nothing" from one scraper's mood.
 */
export async function searchWeb(
  query: string,
  limit = 10,
  options: { engine?: string; kind?: SearchEngineKind } = {},
): Promise<SearchProviderResult> {
  let chain: SearchEngine[];
  if (options.engine) {
    const named = engineById(options.engine);
    if (!named) {
      throw new Error(
        `noma’lum qidiruv engine "${options.engine}". Borlari: ${SEARCH_ENGINES.map((item) => item.id).join(', ')}.`,
      );
    }
    chain = [named];
  } else {
    chain = enginesFor(options.kind);
  }

  const configured: string[] = [];
  const skipped: Array<{ engine: string; needs: string[] }> = [];
  const runnable: SearchEngine[] = [];
  for (const engine of chain) {
    if (!engine.configured()) {
      skipped.push({ engine: engine.id, needs: [...engine.credentials, ...engine.settings] });
      continue;
    }
    configured.push(engine.label);
    runnable.push(engine);
  }

  const failedProviders: SearchProviderResult['failedProviders'] = [];
  for (const engine of runnable) {
    const started = Date.now();
    try {
      const results = await attempt(engine, query, limit);
      if (results.length === 0) {
        failedProviders.push({ provider: engine.label, reason: 'empty_answer' });
        log(JSON.stringify({ event: 'search.provider_empty', provider: engine.id, ms: Date.now() - started }));
        continue;
      }
      return {
        provider: engine.label + (failedProviders.length ? ' (fallback)' : ''),
        results,
        failedProviders,
        configured,
        skipped,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason = refusalReason(message);
      failedProviders.push({ provider: engine.label, reason });
      log(JSON.stringify({ event: 'search.provider_fallback', provider: engine.id, reason }));
    }
  }

  throw new Error(
    `Hech bir qidiruv engine javob bermadi (${runnable.length} urinish): ` +
      failedProviders.map((item) => `${item.provider}=${item.reason}`).join(', ') +
      (skipped.length
        ? `. Yana ${skipped.length} engine sozlanmagan: ${skipped.map((item) => item.engine).join(', ')} —` +
          ' ularga kalit kerak, ro‘yxatni pro_fetch_search_engines beradi.'
        : ''),
  );
}

/**
 * Several engines at once, merged.
 *
 * This is what makes an answer broader than any single index: every usable engine is asked in parallel,
 * results are deduplicated by canonical URL and ranked, and each engine's own outcome is reported — including
 * the ones that refused, with the reason. A caller can then see that four engines failed over a key rather
 * than concluding the web has nothing about the query.
 */
export async function searchAcross(
  query: string,
  limit = 10,
  options: { engines?: string[]; kind?: SearchEngineKind } = {},
): Promise<{
  provider: string;
  results: WebSearchResult[];
  perEngine: EngineOutcome[];
  enginesUsed: string[];
  enginesSkipped: Array<{ engine: string; needs: string[] }>;
  deduplicated: number;
}> {
  let chosen: SearchEngine[];
  if (options.engines?.length) {
    const unknown = options.engines.filter((name) => !engineById(name));
    if (unknown.length) {
      throw new Error(
        `noma’lum engine${unknown.length > 1 ? 'lar' : ''}: ${unknown.join(', ')}. Borlari: ${SEARCH_ENGINES.map(
          (item) => item.id,
        ).join(', ')}.`,
      );
    }
    chosen = options.engines.map((name) => engineById(name)!);
  } else {
    chosen = enginesFor(options.kind);
  }

  const enginesSkipped: Array<{ engine: string; needs: string[] }> = [];
  const runnable: SearchEngine[] = [];
  for (const engine of chosen) {
    if (engine.configured()) runnable.push(engine);
    else enginesSkipped.push({ engine: engine.id, needs: [...engine.credentials, ...engine.settings] });
  }

  const settled = await pool(
    runnable,
    fanoutSize(),
    async (engine): Promise<EngineOutcome & { items: WebSearchResult[] }> => {
      const started = Date.now();
      try {
        const items = await attempt(engine, query, limit);
        return {
          engine: engine.id,
          label: engine.label,
          kind: engine.kind,
          items,
          results: items.length,
          ms: Date.now() - started,
        };
      } catch (error) {
        return {
          engine: engine.id,
          label: engine.label,
          kind: engine.kind,
          items: [],
          results: 0,
          ms: Date.now() - started,
          reason: refusalReason(error instanceof Error ? error.message : String(error)),
        };
      }
    },
  );

  const merged: WebSearchResult[] = [];
  for (const outcome of settled) merged.push(...outcome.items);
  const ranked = rankAndDedupeSearchResults(query, merged, limit);

  return {
    provider: `${settled.filter((item) => item.results > 0).length}/${settled.length} engine javob berdi`,
    results: ranked,
    perEngine: settled.map(({ items: _items, ...rest }) => rest),
    enginesUsed: settled.filter((item) => item.results > 0).map((item) => item.engine),
    enginesSkipped,
    deduplicated: merged.length - ranked.length,
  };
}
