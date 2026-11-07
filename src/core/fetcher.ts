import { fetchWithOptions } from './http-client.js';
import type { BlockPage } from './block-page.js';
import { assertSafeUrl } from './ssrf-guard.js';
import { take } from './ratelimit.js';
import { cache } from './cache.js';
import { canSkipSideEffect } from './read-only-guard.js';
import { clipToTokens, estimateTokens } from './chunker.js';
import { htmlToMarkdown } from './parser.js';
import { boundedEnv } from './bounded-env.js';
import { needsBrowser, renderWithBrowser, type FetchMethod } from './browser-escalation.js';

export interface FetchResult {
  url: string;
  status: number;
  contentType: string;
  markdown: string;
  tokens: number;
  cached: boolean;
  truncated: boolean;
  /** Set when the host answered a refusal page instead of content. */
  blocked?: BlockPage | null;
  /** Set when only the opt-in browser user-agent got through (PRO_FETCH_HTTP_COMPAT_UA). */
  compat_ua?: boolean;
  /**
   * Which stage produced this document.
   *
   * `http` is what the server sent; `browser` is what the site drew after its scripts ran. They are
   * different artefacts and the answer must not let a caller confuse them — a page that only exists in the
   * DOM after JavaScript is not something a server "gave" anyone.
   */
  method?: FetchMethod;
  /** Why the browser was used, or why it was not. Stated from the measured response, never a guess. */
  escalation_reason?: string;
  /** Wall time of the browser stage, when there was one. */
  browser_ms?: number;
}
export interface FetchUrlOptions {
  maxTokens?: number;
  useCache?: boolean;
  timeoutMs?: number;
  /**
   * Re-read an HTML shell in a headless browser. Default on; `PRO_FETCH_BROWSER_ESCALATION=0` turns it off
   * server-wide, and a caller can override either way.
   */
  escalate?: boolean;
}

/**
 * Where a fetched document is kept.
 *
 * The modifiers come before the address, not after it. A URL may legally contain a pipe in its query, so
 * `'fetch:' + url + '|t8000'` could not be read back reliably - and `pro_fetch_offline_browse` does read the
 * keys back to answer "what is in the cache", where the old format made it report a URL with `|t8000` glued
 * on the end. Address-last means the parse is the one split, and it is exact.
 */
export function fetchCacheKey(url: string, limit: number, escalate: boolean): string {
  return 'fetch:t' + limit + '|e' + (escalate ? '1' : '0') + '|' + url;
}

/** The address a fetch cache key was built from; keys that are not in the format come back unchanged. */
export function fetchCacheKeyUrl(key: string): string {
  if (!key.startsWith('fetch:')) return key;
  // An anchored match rather than a split: the address itself may contain pipes, so "the part after the
  // separator" is only defined once the two fixed modifiers have been recognised. `pro_fetch_cache_put`
  // writes arbitrary strings under arbitrary keys, so anything that is not our format keeps its body.
  const shaped = /^fetch:t[0-9.]+\|e[01]\|(.*)$/.exec(key);
  return shaped ? shaped[1] : key.slice('fetch:'.length);
}

export async function fetchUrl(rawUrl: string, opts: FetchUrlOptions = {}): Promise<FetchResult> {
  const url = await assertSafeUrl(rawUrl);
  // The cached value is the CLIPPED document, so the limit belongs in the key.
  //
  // Measured: a call that asked for 100 tokens left behind a 400-character document, and the next
  // call - which asked for 8000 - was served that document from the cache with `truncated: false`,
  // so nothing in the answer said the page had been cut down to a tenth of what was requested. The
  // key carries the effective limit now, and the limit is computed the same way `clipToTokens`
  // computes it, so the two cannot disagree about what was stored.
  const limit =
    opts.maxTokens !== undefined && Number.isFinite(opts.maxTokens) && opts.maxTokens > 0 ? opts.maxTokens : 8000;
  // Two stages can disagree about the same URL: an answer stored by an HTTP-only read must never be handed
  // to a caller who asked for the rendered page, and a rendered answer must not be served to a caller who
  // asked for exactly what the server sends. The mode therefore belongs in the key.
  const switchValue = (process.env.PRO_FETCH_BROWSER_ESCALATION ?? '').trim().toLowerCase();
  const escalate = opts.escalate ?? !(switchValue === '0' || switchValue === 'false');
  const key = fetchCacheKey(url.toString(), limit, escalate);
  if (opts.useCache !== false) {
    const hit = cache.get(key);
    if (hit) {
      // The value under this key is not guaranteed to be a stored document. `pro_fetch_cache_put` writes an
      // arbitrary string under an arbitrary key and this key format is guessable, so a foreign value used to
      // reach `JSON.parse` and throw a raw SyntaxError at the caller — an internal fault wearing the shape of
      // a tool result. A bad entry is dropped and the document is fetched again.
      let parsed: Omit<FetchResult, 'cached'> | null = null;
      try {
        parsed = JSON.parse(hit.value) as Omit<FetchResult, 'cached'>;
      } catch {
        parsed = null;
      }
      if (parsed && typeof parsed.status === 'number' && typeof parsed.markdown === 'string') {
        return { ...parsed, cached: true };
      }
      // A delete is a side effect, and read-only mode refuses one. That refusal must not become a crash on
      // somebody else's bad entry: the document is fetched fresh either way, and the stale value simply ages
      // out on its own ttl.
      if (!canSkipSideEffect()) cache.delete(key);
    }
  }
  if (!take('domain:' + url.hostname)) {
    throw new Error('Rate limit tugadi (domain): ' + url.hostname);
  }
  const res = await fetchWithOptions(url.toString(), { timeoutMs: opts.timeoutMs });
  const isHtml = res.contentType.includes('text/html') || res.contentType.includes('application/xhtml');
  const raw = isHtml ? await htmlToMarkdown(res.text) : res.text;
  const clipped = clipToTokens(raw, limit);
  const result: FetchResult = {
    // Where the answer actually came from after redirects, not the address it was asked with —
    // `url: url.toString()` was the request line, and a caller recording the result described the
    // wrong document when the origin redirected. The cache key stays the requested URL: that is
    // what a repeat lookup is about.
    url: res.url ?? url.toString(),
    status: res.status,
    contentType: res.contentType,
    markdown: clipped,
    tokens: estimateTokens(clipped),
    cached: false,
    truncated: res.truncated,
    blocked: res.blocked ?? null,
    compat_ua: res.compat_ua,
    method: 'http',
  };
  // Stage two, taken only when the first stage did not deliver a document.
  //
  // The detector reads the bytes we already hold, so an ordinary page costs one string scan and no browser.
  // When it does say "shell", the caller is told which of the two artefacts they are looking at, in the words
  // that were measured — and when the browser cannot be started at all, the HTTP shell is still returned with
  // that reason attached, because an honest empty document beats a failed call.
  if (escalate) {
    const signal = needsBrowser({
      status: res.status,
      contentType: res.contentType,
      markdown: clipped,
      html: res.text,
      blocked: res.blocked,
    });
    if (signal.escalate) {
      const rendered = await renderWithBrowser(res.url ?? url.toString(), limit * 4);
      if (rendered.ok) {
        const drawn = clipToTokens(rendered.markdown, limit);
        result.method = 'browser';
        result.markdown = drawn;
        result.tokens = estimateTokens(drawn);
        // Either half can have cut the text short, and the answer has to say so about the one it returns.
        result.truncated = res.truncated || rendered.truncated;
        result.browser_ms = rendered.ms;
        result.escalation_reason = signal.reason;
      } else {
        result.escalation_reason = signal.reason + '; ikkinchi bosqich bo‘lmadi: ' + rendered.reason;
      }
    }
  }
  // Caching is a side effect, not the purpose of the call: read-only mode skips the write, the document still
  // comes back, and the only cost is that the next call is not served from memory. Storing is also no longer
  // unconditional — an answer the server marked private, an error page, a truncated body or a response
  // carrying a session cookie is not a document to hand back an hour later as `cached: true`.
  if (!canSkipSideEffect() && res.storeAllowed) cache.put(key, JSON.stringify(result), 3_600_000);
  return result;
}

export async function fetchBatch(
  urls: string[],
  concurrency = 10,
  opts: FetchUrlOptions = {},
): Promise<Array<{ ok: boolean; url: string; result?: FetchResult; error?: string }>> {
  const results: Array<{ ok: boolean; url: string; result?: FetchResult; error?: string }> = [];
  let i = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const idx = i++;
      if (idx >= urls.length) return;
      const u = urls[idx];
      try {
        results[idx] = { ok: true, url: u, result: await fetchUrl(u, opts) };
      } catch (err) {
        results[idx] = { ok: false, url: u, error: err instanceof Error ? err.message : String(err) };
      }
    }
  }
  // A non-finite concurrency cannot become a worker count: `Math.max(1, Math.min(NaN, len))` is
  // NaN and `Array.from({ length: NaN })` is empty, so every URL was dropped silently and the
  // caller got an empty result for a successful-looking call. A bad value falls back to the
  // documented default instead of erasing the batch.
  const width = Number.isFinite(concurrency) ? concurrency : 10;
  // Never fan out wider than the server's own global concurrency limit, whatever the caller asked for.
  const cap = boundedEnv('PRO_FETCH_MAX_CONCURRENCY', 64, 1, 4096);
  const n = Math.max(1, Math.min(width, urls.length, cap));
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}
