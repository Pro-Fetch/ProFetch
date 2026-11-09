import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cache } from '../src/core/cache.js';
import { searchCacheKey, searchCacheTtlMs, searchWeb } from '../src/core/search-providers.js';

// Serper says on its own site that it caches nothing, so every repeated query is paid for twice: once in
// credits and once in the 1.2-1.5 s a live scrape takes. The search cache is what removes both — and these
// tests are the reason it is allowed to be trusted: the answer must say it came from cache, the key must
// belong to the engine that produced it, an empty answer must never be stored as if it were one, and
// read-only mode must skip the write instead of failing the call.

const saved = new Map<string, string | undefined>();
function setEnv(name: string, value: string | undefined): void {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
});

describe('search cache settings', () => {
  it('defaults to fifteen minutes', () => {
    setEnv('PRO_FETCH_SEARCH_CACHE_MS', undefined);
    expect(searchCacheTtlMs()).toBe(900_000);
  });

  it('treats an explicit zero as disabled, which boundedEnv cannot express', () => {
    setEnv('PRO_FETCH_SEARCH_CACHE_MS', '0');
    expect(searchCacheTtlMs()).toBe(0);
  });

  it('falls back to the default on a typo instead of silently disabling caching', () => {
    // The symptom of a disabled cache is a bigger bill, not an error — so a bad value must not be able to
    // produce it.
    setEnv('PRO_FETCH_SEARCH_CACHE_MS', 'fifteen-minutes');
    expect(searchCacheTtlMs()).toBe(900_000);
    setEnv('PRO_FETCH_SEARCH_CACHE_MS', '-1');
    expect(searchCacheTtlMs()).toBe(900_000);
  });

  it('clamps a request for an unbounded TTL to one day', () => {
    setEnv('PRO_FETCH_SEARCH_CACHE_MS', '999999999999');
    expect(searchCacheTtlMs()).toBe(86_400_000);
  });
});

describe('search cache keys', () => {
  it('belong to the engine that answered, not to the question', () => {
    const a = searchCacheKey('serper', 'SQLite WAL', 5);
    const b = searchCacheKey('tavily', 'SQLite WAL', 5);
    expect(a).not.toBe(b);
    expect(a).toContain('serper');
  });

  it('normalises case and padding, and keeps the limit separate', () => {
    expect(searchCacheKey('serper', '  SQLite WAL  ', 5)).toBe(searchCacheKey('serper', 'sqlite wal', 5));
    expect(searchCacheKey('serper', 'sqlite wal', 5)).not.toBe(searchCacheKey('serper', 'sqlite wal', 10));
  });
});

describe('search cache behaviour', () => {
  // A keyless vertical so the test needs nobody's paid key. The query has to be one the index actually
  // answers: an earlier version of this file appended Date.now() for uniqueness and every test then failed
  // with `Wikipedia=empty_answer` — a real refusal, correctly reported, caused by a fixture that asked for
  // an article that does not exist. Uniqueness now comes from clearing the key, not from inventing a query.
  const QUERY = 'DuckDB';
  const KEY = searchCacheKey('wikipedia', QUERY, 3);

  beforeEach(() => {
    cache.delete(KEY);
    setEnv('PRO_FETCH_SEARCH_CACHE_MS', '900000');
    setEnv('PRO_FETCH_READ_ONLY', undefined);
  });

  it('answers live the first time and from cache the second', async () => {
    const first = await searchWeb(QUERY, 3, { kind: 'reference' });
    expect(first.results.length).toBeGreaterThan(0);
    expect(first.cached).toBeUndefined();
    expect(first.cache_ttl_ms).toBe(900_000);

    const second = await searchWeb(QUERY, 3, { kind: 'reference' });
    expect(second.cached).toBe(true);
    expect(typeof second.cached_age_ms).toBe('number');
    expect(second.results.length).toBe(first.results.length);
    expect(second.provider).toBe(first.provider);
  });

  it('drops a cached empty answer instead of serving it as a result', async () => {
    // The failure this exists to prevent: an engine that answered nothing gets its nothing stored, and for
    // the rest of the TTL every caller is told the web has nothing about the query.
    cache.put(KEY, JSON.stringify({ provider: 'Wikipedia', results: [] }), 900_000);
    const answer = await searchWeb(QUERY, 3, { kind: 'reference' });
    expect(answer.cached).toBeUndefined();
    const stored = JSON.parse(cache.get(KEY)!.value) as { results: unknown[] };
    expect(stored.results.length).toBeGreaterThan(0);
  });

  it('skips the write in read-only mode and still returns the answer', async () => {
    setEnv('PRO_FETCH_READ_ONLY', 'true');
    const answer = await searchWeb(QUERY, 3, { kind: 'reference' });
    expect(answer.results.length).toBeGreaterThan(0);
    // Storing is a side effect. Read-only must skip it quietly, not throw and not lose the results.
    expect(cache.get(KEY)).toBeUndefined();
  });
});
