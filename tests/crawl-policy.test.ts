/**
 * The rules this server follows when it goes looking at somebody else's site.
 *
 * All offline: the SERP table is a set of address shapes, the wall detector reads a body we hand it, and the
 * User-Agent is a string. None of it needs the network, and none of it should — a policy that can only be
 * tested by asking Google is a policy that will not be tested.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/loader.js';
import { cache } from '../src/core/cache.js';
import { fetchUrl } from '../src/core/fetcher.js';
import { authWallRefusal, serpRefusal, serpRefusalMessage } from '../src/core/crawl-policy.js';
import { UA_CONTACT, USER_AGENT } from '../src/core/version.js';

describe('search-result pages are not documents', () => {
  const refused = [
    'https://www.google.com/search?q=sqlite+wal',
    'https://www.google.com/images?q=cat',
    'https://news.google.com/search?q=stress+test',
    'https://www.bing.com/search?q=pro-fetch',
    'https://duckduckgo.com/html/?q=pro-fetch',
    'https://duckduckgo.com/?q=pro-fetch',
    'https://search.brave.com/search?q=sqlite',
    'https://www.startpage.com/sp/search?query=x',
    'https://www.ecosia.org/search?q=x',
    'https://www.mojeek.com/search?q=x',
    'https://www.yandex.ru/search/?text=x',
    'https://www.baidu.com/s?wd=x',
    'https://search.naver.com/search.naver?query=x',
  ];

  it('names the engine whose index was being read through', () => {
    for (const url of refused) {
      const refusal = serpRefusal(url);
      expect(refusal, url).not.toBeNull();
      expect(refusal?.engine, url).toBeTruthy();
    }
  });

  it('says what to do instead of scraping', () => {
    const refusal = serpRefusal('https://www.google.com/search?q=sqlite')!;
    const message = serpRefusalMessage(refusal);
    expect(message).toContain('Google');
    expect(message).toContain('pro_fetch_web_search');
    // The site itself is not blocked, and the message has to say so or a caller assumes it is.
    expect(message).toContain('bloklanmagan');
  });

  it('leaves ordinary pages on the same hosts alone', () => {
    for (const url of [
      'https://www.sqlite.org/lang_transaction.html',
      'https://github.com/Pro-Fetch/ProFetch',
      'https://news.google.com/rss/topstories',
      'https://duckduckgo.com/security',
      'https://www.bing.com/maps?form=HBZegg',
      'https://brave.com/features/',
    ]) {
      expect(serpRefusal(url), url).toBeNull();
    }
  });

  it('does not refuse a document because its path looks like a results prefix', () => {
    // Measured on 2026-11-09 while reading Brave's own pricing page: `https://brave.com/search/api/` came
    // back as "Brave qidiruv natijalari sahifasi o'qilmaydi". The rule matched the company domain and the
    // first path segment. A results page is addressed by its query — without one there is nothing to
    // harvest — so requiring the query is what separates the index from the documentation.
    for (const url of [
      'https://brave.com/search/api/',
      'https://brave.com/search/api',
      'https://www.google.com/search/about/',
      'https://www.google.com/search/howsearchworks',
      'https://www.google.com/search',
      'https://www.bing.com/search',
    ]) {
      expect(serpRefusal(url), url).toBeNull();
    }
    // The first two are paths Google's robots.txt marks `Allow:` next to `Disallow: /search`. Refusing them
    // meant the guard contradicted the source it claims to respect.
  });

  it('still refuses the same hosts once a query makes them an index', () => {
    for (const [url, engine] of [
      ['https://brave.com/search?q=sqlite', 'Brave'],
      ['https://search.brave.com/search?q=sqlite', 'Brave'],
      ['https://www.google.com/search?q=sqlite&hl=en', 'Google'],
      ['https://www.bing.com/search?q=sqlite', 'Bing'],
    ] as const) {
      expect(serpRefusal(url)?.engine, url).toBe(engine);
    }
  });

  it('ignores a malformed address rather than throwing from a policy check', () => {
    expect(serpRefusal('not a url at all')).toBeNull();
    expect(serpRefusal('ftp://google.com/search?q=1')).toBeNull();
  });

  it('refuses through fetchUrl before spending a rate-limit slot', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (request: RequestInfo | URL) => {
        calls.push(String(request));
        return new Response('<html><body>should not be fetched</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }),
    );
    await expect(fetchUrl('https://www.google.com/search?q=pro-fetch')).rejects.toThrow(/pro_fetch_web_search/);
    expect(calls).toHaveLength(0);
  });
});

describe('a wall is reported as a wall', () => {
  it('recognises a redirect that landed on a sign-in path', () => {
    const wall = authWallRefusal({
      finalUrl: 'https://journal.example/login?redirect=%2Farticle%2F42',
      status: 200,
      markdown: '# Sign in\n\nEmail Password Log in',
    });
    expect(wall?.kind).toBe('auth_wall');
    expect(wall?.hint).toContain('kirish');
  });

  it('recognises a subscription prompt on a short body', () => {
    const wall = authWallRefusal({
      finalUrl: 'https://news.example/article/42',
      status: 200,
      markdown: 'Subscribe to continue reading this article. Already a member? Sign in.',
    });
    expect(wall?.kind).toBe('auth_wall');
    expect(wall?.marker).toContain('subscribe');
  });

  it('does not call a long article a paywall because it mentions logging in', () => {
    const long = 'word '.repeat(400) + ' Sign in to continue is mentioned in the sidebar of this page.';
    expect(authWallRefusal({ finalUrl: 'https://blog.example/post', status: 200, markdown: long })).toBeNull();
  });

  it('does not mistake an error page for a wall — that is the block detector’s job', () => {
    expect(
      authWallRefusal({ finalUrl: 'https://journal.example/login', status: 403, markdown: 'Access denied' }),
    ).toBeNull();
  });

  it('survives an address it cannot parse', () => {
    expect(authWallRefusal({ finalUrl: 'garbage', status: 200, markdown: 'x'.repeat(10) })).toBeNull();
  });

  it('reaches the caller through fetchUrl as a refusal, not as an empty document', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html><body><h1>Sign in</h1><p>Email Password Log in to view this article.</p></body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      ),
    );
    const r = await fetchUrl('http://93.184.216.34/article/1', { escalate: false });
    expect(r.blocked?.kind).toBe('auth_wall');
    expect(r.blocked?.marker).toContain('log in');
  });
});

describe('the User-Agent identifies who is asking', () => {
  afterEach(() => {
    delete process.env.PRO_FETCH_USER_AGENT_CONTACT;
  });

  it('carries a contact URL, not just a product name', () => {
    expect(USER_AGENT).toContain('(+' + UA_CONTACT + ')');
    expect(UA_CONTACT).toMatch(/^https:\/\//);
    expect(USER_AGENT).toMatch(/^[!#$%&'*+\-.^_`|~0-9A-Za-z\/ ()@:+]+$/);
  });

  it('lets an operator point the contact at their own page', async () => {
    vi.resetModules();
    process.env.PRO_FETCH_USER_AGENT_CONTACT = 'https://acme.example/bot';
    const version = await import('../src/core/version.js');
    expect(version.UA_CONTACT).toBe('https://acme.example/bot');
    expect(version.USER_AGENT).toContain('acme.example/bot');
    delete process.env.PRO_FETCH_USER_AGENT_CONTACT;
    vi.resetModules();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  cache.clear();
});
