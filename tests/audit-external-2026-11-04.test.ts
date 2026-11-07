/**
 * Regression pins for the external audit of 2026-11-04.
 *
 * The audit was run on a Linux clone at commit `ce5db30` and each finding below was reproduced by the
 * auditor with a command and an exit code. These files pin the fixes so the same environment cannot regress
 * them silently: every case here is the audited input, and the assertion is the behaviour that input should
 * have produced in the first place.
 *
 * Covered here: a foreign value under a fetch cache key must not throw a raw SyntaxError (2.2), and an error
 * page, a private response or a cookie-bearing one must not be stored as if it were a document (2.3). The
 * rate limiter's bucket ceiling is pinned in `audit-ratelimit-bound.test.ts` (2.1).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/loader.js';
import { allTools, ARCHIVE_TOOL_PROPERTIES, ARCHIVE_TOOL_REQUIREMENTS } from '../src/core/tool.js';
import { cache } from '../src/core/cache.js';
import { fetchCacheKey, fetchUrl } from '../src/core/fetcher.js';
import { mayStoreHttpAnswer } from '../src/core/http-client.js';

process.env.PRO_FETCH_PROFILE = 'full';

const registered = (name: string) => allTools().find((candidate) => candidate.name === name);

const HTML = '<html><body><main><h1>Doc</h1><p>Body text that is long enough to render.</p></main></body></html>';

/** Stub the network and count the addresses it was actually asked for. */
function stubFetch(make: () => Response): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (request: RequestInfo | URL) => {
      calls.push(String(request));
      return make();
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  cache.clear();
});

describe('a fetch cache entry nobody stored as a document', () => {
  it('is dropped and the page is fetched again, instead of throwing at the caller', async () => {
    // The audited input: `pro_fetch_cache_put` writes any string under any key, and the key format
    // `fetch:t<limit>|e<mode>|<url>` is guessable, so a foreign value reached `JSON.parse` and the caller got
    // a raw `SyntaxError` where it should have got a tool result.
    const url = 'http://93.184.216.34/audit-poison';
    // Written through the fetcher's own helper: hand-spelling this key is exactly how the format was once
    // allowed to drift away from the case that was supposed to catch it.
    cache.put(fetchCacheKey(url, 8000, true), 'BU-JSON-EMAS');
    const calls = stubFetch(() => new Response(HTML, { status: 200, headers: { 'content-type': 'text/html' } }));
    const result = await fetchUrl(url);
    expect(result.status).toBe(200);
    expect(result.cached).toBe(false);
    expect(result.markdown).toContain('Body text');
    expect(calls).toHaveLength(1);
  });

  it('is rejected on shape as well as on syntax', async () => {
    // Valid JSON that is not a stored document is the same fault: `status` and `markdown` are what the
    // caller is handed back, and a value without them is not a document whatever it parses to.
    const url = 'http://93.184.216.34/audit-shape';
    cache.put(fetchCacheKey(url, 8000, true), JSON.stringify({ hello: 'world' }));
    const calls = stubFetch(() => new Response(HTML, { status: 200, headers: { 'content-type': 'text/html' } }));
    const result = await fetchUrl(url);
    expect(result.markdown).toContain('Body text');
    expect(calls).toHaveLength(1);
  });
});

describe('what the fetch cache may hold', () => {
  it('stores an ordinary document, and serves the next call from it', async () => {
    // The guard against over-correction: refusing to store failures must not quietly disable caching.
    const url = 'http://93.184.216.34/audit-ok';
    const calls = stubFetch(() => new Response(HTML, { status: 200, headers: { 'content-type': 'text/html' } }));
    const first = await fetchUrl(url);
    const second = await fetchUrl(url);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('does not store an error page', async () => {
    const url = 'http://93.184.216.34/audit-404';
    const calls = stubFetch(() => new Response(HTML, { status: 404, headers: { 'content-type': 'text/html' } }));
    const first = await fetchUrl(url);
    const second = await fetchUrl(url);
    expect(first.status).toBe(404);
    expect(second.cached).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it('does not store a response the server marked no-store', async () => {
    const url = 'http://93.184.216.34/audit-nostore';
    const calls = stubFetch(
      () => new Response(HTML, { status: 200, headers: { 'content-type': 'text/html', 'cache-control': 'no-store' } }),
    );
    await fetchUrl(url);
    const second = await fetchUrl(url);
    expect(second.cached).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it('does not store a response that handed the caller a session cookie', async () => {
    const url = 'http://93.184.216.34/audit-cookie';
    const calls = stubFetch(
      () =>
        new Response(HTML, {
          status: 200,
          headers: { 'content-type': 'text/html', 'set-cookie': 'session=abc; Path=/' },
        }),
    );
    await fetchUrl(url);
    const second = await fetchUrl(url);
    expect(calls).toHaveLength(2);
    expect(second.cached).toBe(false);
  });

  it('states the rule once, in one place', () => {
    expect(mayStoreHttpAnswer(200, '', false, false)).toBe(true);
    expect(mayStoreHttpAnswer(301, '', false, false)).toBe(true);
    expect(mayStoreHttpAnswer(404, '', false, false)).toBe(false);
    expect(mayStoreHttpAnswer(500, '', false, false)).toBe(false);
    expect(mayStoreHttpAnswer(200, 'no-store', false, false)).toBe(false);
    expect(mayStoreHttpAnswer(200, 'private, max-age=0', false, false)).toBe(false);
    expect(mayStoreHttpAnswer(200, 'no-cache', false, false)).toBe(false);
    expect(mayStoreHttpAnswer(200, '', true, false)).toBe(false);
    expect(mayStoreHttpAnswer(200, '', false, true)).toBe(false);
  });
});

describe('a schema table row that names no reachable tool is a dead contract', () => {
  it('every archive table row names a registered tool in the archive category', () => {
    // `applyCategorySchema` only runs for the `archive` category, so a row naming a tool elsewhere — the
    // audit found `pro_fetch_cache_tune`, which is `admin` and takes `default_ttl_ms`/`max_entries` — can
    // never match. It narrows nothing and advertises arguments that belong to no tool.
    const dead: string[] = [];
    for (const name of [...Object.keys(ARCHIVE_TOOL_PROPERTIES), ...Object.keys(ARCHIVE_TOOL_REQUIREMENTS)]) {
      const found = registered(name);
      if (!found) dead.push(`${name}: not registered`);
      else if (found.category !== 'archive')
        dead.push(`${name}: category is ${found.category}, table runs for archive`);
    }
    expect(dead).toEqual([]);
  });

  it('cache_clear declares nothing it does not read', () => {
    // The schema used to require a `url` that no line of the handler looked at, hidden from the schema audit
    // by an unused `view(input)` — a statement touching the whole input reads like a read of every property.
    const found = registered('pro_fetch_cache_clear');
    expect(Object.keys(found?.inputSchema.properties ?? {})).toEqual([]);
    expect(found?.inputSchema.required ?? []).toEqual([]);
  });
});
