import {
  SEARCH_ENGINES,
  engineById,
  enginesFor,
  generalWebEngines,
  type SearchEngine,
  type SearchEngineKind,
  type WebSearchResult,
} from './search-engines.js';
import { rankAndDedupeSearchResults } from './search-ranking.js';
import { log } from './log.js';
import { cache } from './cache.js';
import { canSkipSideEffect } from './read-only-guard.js';

export type { WebSearchResult, SearchEngineKind };
export { SEARCH_ENGINES, engineById, enginesFor, engineStatuses, generalWebEngines } from './search-engines.js';

export interface SearchProviderResult {
  provider: string;
  results: WebSearchResult[];
  failedProviders: Array<{ provider: string; reason: string }>;
  /** Engines this server can use right now for the request as asked. */
  configured: string[];
  /** Engines that exist but are not usable here, and what each one is waiting for. */
  skipped: Array<{ engine: string; needs: string[] }>;
  /** True when no request left this machine — the answer came from the search cache. */
  cached?: boolean;
  /** How long ago the cached answer was measured, in ms. Present only when `cached`. */
  cached_age_ms?: number;
  /** The TTL in force for search results, so a caller can tell 15 minutes from disabled. */
  cache_ttl_ms?: number;
}

/**
 * How long a search answer may be reused.
 *
 * Serper states on its own site: *"We do not cache anything so the returned response will reflect the
 * latest SERP results of Google."* So every query we repeat is paid for twice — once in credits, once in
 * the 1.2-1.5 s the live scrape takes. Measured here on 2026-11-09: a search through pro-fetch answers in
 * 1 186-1 459 ms, while a cached page read answers in 1-2 ms.
 *
 * `boundedEnv` cannot express this setting: it treats zero as "unset" and returns the fallback, and zero
 * here has to mean *disabled*. A value that is not a number still falls back to the default — a typo in
 * `.env` must not silently turn caching off, because the symptom of that is a bill, not an error.
 */
export function searchCacheTtlMs(): number {
  const raw = process.env.PRO_FETCH_SEARCH_CACHE_MS?.trim();
  if (raw === undefined || raw === '') return 900_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 900_000;
  return Math.min(Math.floor(parsed), 86_400_000);
}

/**
 * One key per engine, never one key per request.
 *
 * A chain that cached under "the query" alone would serve a Serper answer to a caller who asked
 * `engine='tavily'` — different index, different results, same cache entry. Keying by engine means a hit
 * is always an answer that engine actually gave, and the reported `provider` stays true.
 */
export function searchCacheKey(engineId: string, query: string, limit: number): string {
  return `search:${engineId}:${limit}:${query.trim().toLowerCase()}`;
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
  if (/BUDGET_EXCEEDED/.test(message)) return 'budget_exceeded';
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
 * With no `kind`, the chain is `generalWebEngines()`: whole-web indexes that require a credential. The
 * keyless rows are not in it — see that function for the measurement that ended them — and a server with
 * no search key now says so instead of walking into academic metadata. With a `kind`, the caller asked for
 * a vertical and every engine of that kind is eligible, keyless included.
 *
 * An engine that returns *nothing* counts as a miss — measured on 2026-11-06, `html.duckduckgo.com`
 * answered HTTP 202 with an empty page, which is neither an error nor an answer, and stopping there would
 * have reported "the web has nothing" from one scraper's mood.
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
    if (!named.configured()) {
      const needs = [...named.credentials, ...named.settings];
      throw new Error(
        `"${named.label}" sozlanmagan — ${needs.length ? `kerak: ${needs.join(' + ')}` : 'bu engine sozlamasi talab qilinadi'} ` +
          `(hech qanday urinish qilinmadi). Ro‘yxat va holati: pro_fetch_search_engines.`,
      );
    }
    chain = [named];
  } else {
    chain = options.kind ? enginesFor(options.kind) : generalWebEngines();
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

  if (runnable.length === 0) {
    const wanted = [...new Set(chain.flatMap((engine) => engine.credentials))].join(' | ');
    throw new Error(
      options.kind
        ? `"${options.kind}" turidagi ${chain.length} engine'dan biri ham sozlanmagan` +
            (wanted ? ` — kerak: ${wanted}` : ' — ulardan birida sozlama talab qilinadi') +
            '. Hech qanday urinish qilinmadi. Holat: pro_fetch_search_engines.'
        : `Web qidiruv kalit talab qiladi. Qabul qilinadiganlardan biri kerak: ${wanted}. ` +
            'Hozir hech biri sozlanmagan, shuning uchun urinish ham qilinmadi — eski zanjir kalitsiz engine’lardan ' +
            'akademik metadata’gacha tushib, so‘rovga aloqador bo‘lmagan natijani "javob" qilib qaytarardi. ' +
            "Bepul vertikal qidiruv ochiq: kind='academic' | 'news' | 'community' | 'packages' | 'reference' | 'media', " +
            "yoki engine='wikipedia' / engine='hackernews' / engine='google-news'. Ro‘yxat va holat: pro_fetch_search_engines.",
    );
  }

  const failedProviders: SearchProviderResult['failedProviders'] = [];
  const ttlMs = searchCacheTtlMs();
  for (const engine of runnable) {
    const key = searchCacheKey(engine.id, query, limit);
    const hit = ttlMs > 0 ? cache.get(key) : undefined;
    if (hit) {
      const stored = JSON.parse(hit.value) as { provider: string; results: WebSearchResult[] };
      if (stored.results.length > 0) {
        const ageMs = Date.now() - hit.createdAt;
        log(JSON.stringify({ event: 'search.cache_hit', provider: engine.id, age_ms: ageMs }));
        return {
          provider: stored.provider,
          results: stored.results,
          failedProviders,
          configured,
          skipped,
          cached: true,
          cached_age_ms: ageMs,
          cache_ttl_ms: ttlMs,
        };
      }
      // An empty answer is not an answer, and caching it would freeze the failure for the whole TTL.
      cache.delete(key);
    }
    const started = Date.now();
    try {
      const results = await attempt(engine, query, limit);
      if (results.length === 0) {
        failedProviders.push({ provider: engine.label, reason: 'empty_answer' });
        log(JSON.stringify({ event: 'search.provider_empty', provider: engine.id, ms: Date.now() - started }));
        continue;
      }
      const providerName = engine.label + (failedProviders.length ? ' (fallback)' : '');
      // Storing is a side effect, not part of the answer: read-only mode skips the write, the results still
      // come back, and the only cost is that the next call is not served from memory.
      if (ttlMs > 0 && !canSkipSideEffect()) {
        cache.put(key, JSON.stringify({ provider: providerName, results }), ttlMs, { engine: engine.id, query });
      }
      return {
        provider: providerName,
        results,
        failedProviders,
        configured,
        skipped,
        cache_ttl_ms: ttlMs,
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
 * A deadline for one engine inside a fan-out.
 *
 * Without it the whole call is only as fast as its slowest provider, and one index having a bad minute
 * costs the caller twenty-five seconds they did not ask for. A timed-out engine is reported as
 * `budget_exceeded` with its own elapsed time — an accounting entry, not a dropped result.
 */
async function withBudget<T>(work: Promise<T>, budgetMs: number): Promise<T> {
  if (!budgetMs || budgetMs <= 0) return work;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), budgetMs);
  });
  try {
    const outcome = await Promise.race([work.then((value) => ({ value }) as const), deadline]);
    if (outcome === null) throw new Error('BUDGET_EXCEEDED');
    return outcome.value;
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  options: { engines?: string[]; kind?: SearchEngineKind; budgetMs?: number } = {},
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
    chosen = options.kind ? enginesFor(options.kind) : generalWebEngines();
  }

  const enginesSkipped: Array<{ engine: string; needs: string[] }> = [];
  const runnable: SearchEngine[] = [];
  for (const engine of chosen) {
    if (engine.configured()) runnable.push(engine);
    else enginesSkipped.push({ engine: engine.id, needs: [...engine.credentials, ...engine.settings] });
  }

  if (runnable.length === 0) {
    const wanted = [...new Set(chosen.flatMap((engine) => [...engine.credentials, ...engine.settings]))].join(' | ');
    throw new Error(
      `Birlashtirilgan qidiruv uchun ham hech bir engine sozlanmagan (${chosen.length} nomzod; kerak: ${wanted}). ` +
        "Urinish qilinmadi. Vertikal bo'yicha so'rasangiz kalitsiz engine'lar ochiq: kind='academic' | 'news' | " +
        "'community' | 'packages' | 'reference' | 'media'. Holat: pro_fetch_search_engines.",
    );
  }

  const settled = await pool(
    runnable,
    fanoutSize(),
    async (engine): Promise<EngineOutcome & { items: WebSearchResult[] }> => {
      const started = Date.now();
      try {
        const items = await withBudget(attempt(engine, query, limit), options.budgetMs ?? 0);
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
