/**
 * Two-stage reading: knowing when the bytes you got are not a document.
 *
 * The detector half is tested offline, because the whole claim of the design is that the decision comes from
 * the response and not from a list of hostnames. The browser half runs against a stubbed page engine rather
 * than a real Chromium: what is being pinned here is the *reporting* — which stage answered, why the second
 * one was entered, what happens when it cannot be entered — and a real browser would make the assertion depend
 * on whether a 100 MB binary happens to be installed on the machine running the test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../src/loader.js';
import { cache } from '../src/core/cache.js';
import { dispatch } from '../src/core/tool.js';
import { fetchCacheKey, fetchCacheKeyUrl, fetchUrl } from '../src/core/fetcher.js';
import { countWords, hasEmptyMount, needsBrowser } from '../src/core/browser-escalation.js';

const SHELL =
  '<html><head><script src="/assets/app.js"></script><script>window.__cfg={}</script></head>' +
  '<body><div id="root"></div><noscript>You need to enable JavaScript to run this app.</noscript></body></html>';

const WRITTEN =
  '<html><head><script src="/analytics.js"></script></head><body><article>' +
  Array.from({ length: 60 }, (_, i) => `sentence number ${i} carries some substance`).join(' ') +
  '</article></body></html>';

/** What the fake page engine "paints" for a shell. */
const RENDERED = Array.from({ length: 80 }, (_, i) => `rendered paragraph ${i} with real content inside`).join(' ');

let mode: 'paints' | 'still_empty' | 'launch_fails' = 'paints';
let renderedBody = RENDERED;
let browserRequests: string[] = [];

vi.mock('../src/core/browser-tools.js', () => ({
  withGuardedPage: async (url: string, _input: unknown, fn: (page: never) => Promise<unknown>) => {
    browserRequests.push(url);
    if (mode === 'launch_fails') throw new Error('browserType.launch: Executable doesn‘t exist');
    const body = mode === 'still_empty' ? 'You need to enable JavaScript' : renderedBody;
    return fn({
      waitForLoadState: async () => {},
      locator: () => ({ innerText: async () => body }),
    } as never);
  },
}));

function stubHtml(html: string, init: { status?: number; contentType?: string } = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(html, {
          status: init.status ?? 200,
          headers: { 'content-type': init.contentType ?? 'text/html; charset=utf-8' },
        }),
    ),
  );
}

beforeEach(() => {
  mode = 'paints';
  renderedBody = RENDERED;
  browserRequests = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  cache.clear();
  delete process.env.PRO_FETCH_BROWSER_ESCALATION;
});

describe('the decision, taken from the response', () => {
  it('names the numbers it saw when it says a page is a shell', () => {
    const signal = needsBrowser({ status: 200, contentType: 'text/html', markdown: 'root', html: SHELL });
    expect(signal.escalate).toBe(true);
    expect(signal.words).toBe(1);
    expect(signal.scriptTags).toBe(2);
    expect(signal.mountPoint).toBe(true);
    expect(signal.reason).toContain('1 words');
    expect(signal.reason).toContain('2 script tag(s)');
    expect(signal.reason).toContain('empty mount element');
  });

  it('leaves a page that has actual text on HTTP even when it carries scripts', () => {
    const signal = needsBrowser({
      status: 200,
      contentType: 'text/html',
      markdown: Array.from({ length: 50 }, (_, i) => `sentence ${i} substance here`).join(' '),
      html: WRITTEN,
    });
    expect(signal.escalate).toBe(false);
    expect(signal.reason).toContain('no browser needed');
  });

  it('does not pay for a browser on a short page that is simply short', () => {
    // The live reading behind this case: 24 words of markdown and one script tag, all of it already there.
    const shortButComplete =
      '<html><head><script src="/analytics.js"></script></head><body><p>' +
      Array.from({ length: 24 }, (_, i) => `word${i}`).join(' ') +
      '</p></body></html>';
    const signal = needsBrowser({
      status: 200,
      contentType: 'text/html',
      markdown: Array.from({ length: 24 }, (_, i) => `word${i}`).join(' '),
      html: shortButComplete,
    });
    expect(signal.words).toBe(24);
    expect(signal.scriptTags).toBe(1);
    expect(signal.mountPoint).toBe(false);
    expect(signal.escalate).toBe(false);
    expect(signal.reason).toContain('not a shell');
  });

  it('separates a short page from an unrendered one: no script tag, no browser', () => {
    const signal = needsBrowser({
      status: 200,
      contentType: 'text/html',
      markdown: 'Just a note. Two lines. Nothing to paint.',
      html: '<html><body><p>Just a note. Two lines. Nothing to paint.</p></body></html>',
    });
    expect(signal.escalate).toBe(false);
    expect(signal.reason).toMatch(/short, not rendered/);
  });

  it('never treats a refusal as an empty page to be re-read', () => {
    const signal = needsBrowser({
      status: 403,
      contentType: 'text/html',
      markdown: 'Access denied',
      html: '<html><body>Access denied</body></html>',
      blocked: { kind: 'waf', marker: 'Access denied', hint: 'ask nicely' },
    });
    expect(signal.escalate).toBe(false);
    expect(signal.reason).toContain('refused');
  });

  it('reads an HTTP error as an answer rather than a page that failed to draw', () => {
    const signal = needsBrowser({ status: 500, contentType: 'text/html', markdown: '', html: SHELL });
    expect(signal.escalate).toBe(false);
    expect(signal.reason).toContain('HTTP 500 is an answer');
  });

  it('does not reach for a browser at something that was never a page', () => {
    const signal = needsBrowser({
      status: 200,
      contentType: 'application/json',
      markdown: '{"a":1}',
      html: '{"a":1}',
    });
    expect(signal.escalate).toBe(false);
    expect(signal.reason).toContain('not HTML');
  });

  it('counts words the way the threshold is described, not by splitting on every space', () => {
    expect(countWords('  \n\t ')).toBe(0);
    expect(countWords('a bb ccc')).toBe(2);
    expect(countWords('one two three four five')).toBe(5);
  });
});

describe('the mount element the source left empty', () => {
  it('recognises the shapes that mean scripts still have to run', () => {
    expect(hasEmptyMount('<div id="root"></div>')).toBe(true);
    expect(hasEmptyMount('<div id="__next"></div>')).toBe(true);
    expect(hasEmptyMount('<app-root></app-root>')).toBe(true);
    expect(hasEmptyMount('<html><body></body></html>')).toBe(true);
    expect(hasEmptyMount('<div id="root">\n  </div>')).toBe(true);
    expect(hasEmptyMount('<div id=app></div>')).toBe(true);
  });

  it('does not call a server-rendered page a shell because it hydrates', () => {
    expect(hasEmptyMount('<div id="apples"></div>')).toBe(false);
    expect(hasEmptyMount('<div id="app-container"></div>')).toBe(false);
    expect(hasEmptyMount('<div id="root"><h1>Real headline</h1><p>text</p></div>')).toBe(false);
    expect(hasEmptyMount('<div id="__next"><div id="spinner"></div></div>')).toBe(false);
    expect(hasEmptyMount('<body><p>content</p></body>')).toBe(false);
    expect(hasEmptyMount('<div id="sidebar"></div><div id="root">content here</div>')).toBe(false);
  });
});

describe('the cache address of a reading', () => {
  it('keeps the URL last so an address containing a pipe still round-trips', () => {
    const url = 'https://93.184.216.34/path?a=1|2';
    expect(fetchCacheKeyUrl(fetchCacheKey(url, 8000, true))).toBe(url);
    expect(fetchCacheKey('https://93.184.216.34/', 8000, true)).toBe('fetch:t8000|e1|https://93.184.216.34/');
    expect(fetchCacheKey('https://93.184.216.34/', 200, false)).toBe('fetch:t200|e0|https://93.184.216.34/');
  });

  it('is a distinct slot per stage and per budget, so two readings cannot be confused for one another', () => {
    const url = 'https://93.184.216.34/x';
    expect(fetchCacheKey(url, 8000, true)).not.toBe(fetchCacheKey(url, 8000, false));
    expect(fetchCacheKey(url, 8000, true)).not.toBe(fetchCacheKey(url, 100, true));
  });
});

describe('fetchUrl, stage by stage', () => {
  const url = 'http://93.184.216.34/escalation';

  it('re-reads an HTML shell and reports that the answer is what the scripts drew', async () => {
    stubHtml(SHELL);
    const r = await fetchUrl(url);
    expect(r.method).toBe('browser');
    expect(r.markdown).toContain('rendered paragraph 0');
    expect(r.escalation_reason).toContain('script tag(s)');
    expect(r.browser_ms).toBeGreaterThanOrEqual(0);
    expect(browserRequests).toEqual([url]);
  });

  it('serves the rendered document from cache on the next call, without a second browser', async () => {
    stubHtml(SHELL);
    await fetchUrl(url);
    const second = await fetchUrl(url);
    expect(second.cached).toBe(true);
    expect(second.method).toBe('browser');
    expect(second.markdown).toContain('rendered paragraph 0');
    expect(browserRequests).toHaveLength(1);
  });

  it('keeps an HTTP-only reading in its own slot instead of handing it to a caller who asked for the page', async () => {
    stubHtml(SHELL);
    const plain = await fetchUrl(url, { escalate: false });
    expect(plain.method).toBe('http');
    expect(plain.markdown).not.toContain('rendered paragraph');
    expect(browserRequests).toHaveLength(0);
    // The stored HTTP shell must not satisfy this call: different stage, different document.
    const rendered = await fetchUrl(url, { escalate: true });
    expect(rendered.cached).toBe(false);
    expect(rendered.method).toBe('browser');
    expect(browserRequests).toHaveLength(1);
  });

  it('does not open a browser for a page that already has its text', async () => {
    stubHtml(WRITTEN);
    const r = await fetchUrl(url);
    expect(r.method).toBe('http');
    expect(r.escalation_reason).toBeUndefined();
    expect(browserRequests).toHaveLength(0);
  });

  it('returns the HTTP document with the reason attached when the browser cannot be started', async () => {
    mode = 'launch_fails';
    stubHtml(SHELL);
    const r = await fetchUrl(url);
    expect(r.method).toBe('http');
    // The shell's own text is empty once the script tags and the <noscript> line are dropped — which is the
    // fault this whole stage exists to catch. Without a browser the caller still gets that answer, labelled,
    // instead of a crash: nothing invented, nothing hidden.
    expect(r.markdown).toBe('');
    expect(r.escalation_reason).toContain('script tag(s)');
    expect(r.escalation_reason).toContain('Executable doesn‘t exist');
  });

  it('reports an empty shell as empty rather than inventing content, and says the page stayed blank', async () => {
    mode = 'still_empty';
    stubHtml(SHELL);
    const r = await fetchUrl(url);
    expect(r.method).toBe('browser');
    expect(r.markdown).toContain('You need to enable JavaScript');
    expect(countWords(r.markdown)).toBeLessThan(40);
  });

  it('says so when the rendered page had to be cut to the requested budget', async () => {
    stubHtml(SHELL);
    renderedBody = Array.from({ length: 4000 }, (_, i) => `word${i}`).join(' ');
    const r = await fetchUrl(url, { maxTokens: 50 });
    expect(r.method).toBe('browser');
    expect(r.truncated).toBe(true);
    expect(r.tokens).toBeLessThanOrEqual(60);
  });

  it('turns the second stage off server-wide without touching the caller', async () => {
    process.env.PRO_FETCH_BROWSER_ESCALATION = '0';
    stubHtml(SHELL);
    const r = await fetchUrl(url);
    expect(r.method).toBe('http');
    expect(browserRequests).toHaveLength(0);
    // And the off switch is its own cache slot, so nothing rendered earlier leaks into it.
    expect(fetchCacheKeyUrl(fetchCacheKey(url, 8000, false))).toBe(url);
  });
});

describe('the tool surface', () => {
  const url = 'http://93.184.216.34/escalation-tool';

  it('accepts escalate and names the stage that answered', async () => {
    stubHtml(SHELL);
    const rendered = await dispatch('pro_fetch_fetch_url', { url });
    expect(rendered.content[0].text).toContain('method: browser');
    expect(rendered.content[0].text).toContain('rendered paragraph 0');
    expect(browserRequests).toHaveLength(1);
    // The same address with the second stage refused must not be served the rendered document from memory,
    // and must not be reported as a browser answer: different reading, different slot, different label.
    const plain = await dispatch('pro_fetch_fetch_url', { url, escalate: false });
    expect(plain.content[0].text).toContain('method: http');
    expect(plain.content[0].text).not.toContain('rendered paragraph');
    expect(browserRequests).toHaveLength(1);
  });
});
