import { load } from 'cheerio';
import { fetchWithOptions } from './http-client.js';
import { parseUpstreamJson } from './json-response.js';
import { getCredential } from './credentials.js';
import { COMPAT_USER_AGENT, compatUaEnabled } from './block-page.js';

/**
 * The search engine registry.
 *
 * ## Why one table instead of three if-else branches
 *
 * The server used to know exactly three engines: Serper, Brave and DuckDuckGo. That made the answer depend
 * on which keys happened to be set: with none, one keyless scraper stood between the caller and "no results",
 * and when it was having a bad day the whole tool returned nothing. Measured on 2026-11-06 from this machine:
 * `html.duckduckgo.com` answered **HTTP 202 with zero results** — an anti-bot answer that is not an error and
 * not an answer — while fourteen other engines served the same query normally.
 *
 * So an engine is now a row in one table, and each row states what is known about it rather than what is
 * hoped. `verified` is the honest field:
 *
 * - `live` — this code path was run against the real endpoint from this machine and returned results;
 * - `endpoint` — the endpoint answered with its own authentication or validation error, so the URL, the verb
 *   and the credential header are proven, and the result parsing is written from the provider's documented
 *   shape. **The success path has not been observed**, because that needs somebody's paid key.
 * - `operator` — reachable only at an address the operator supplies (a self-hosted SearXNG), so nothing here
 *   can claim it works until it is configured.
 *
 * Nothing is listed that could not be probed: SearchAPI.io and Kagi returned 404 for the documented paths,
 * Yandex's endpoint refused the connection, public SearXNG instances answer a JS challenge instead of JSON,
 * and dev.to's search path is gone. Those are absent on purpose — an engine that cannot be reached is not a
 * feature, it is a bug report waiting to happen.
 */

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export type SearchEngineKind = 'general' | 'academic' | 'news' | 'community' | 'packages' | 'media' | 'reference';

export interface SearchEngine {
  id: string;
  label: string;
  /** What the engine actually indexes. `general` is a web search; the rest are honest about being narrower. */
  kind: SearchEngineKind;
  /** Environment variables that must be present for this engine to be usable. Empty means keyless. */
  credentials: string[];
  /** Non-secret settings that also have to exist (an engine id, a self-hosted base URL). */
  settings: string[];
  verified: 'live' | 'endpoint' | 'operator';
  /** What the probe measured, or what the provider's own error said. Shown to the caller, never invented. */
  evidence: string;
  configured(): boolean;
  search(query: string, limit: number): Promise<WebSearchResult[]>;
}

/* ------------------------------------------------------------------ helpers */

const MAX_BYTES = 2_000_000;

/**
 * Search requests get their own budget: 25 s, not the 15 s page-fetch default.
 *
 * Measured on a loaded machine: `www.ebi.ac.uk` exceeded 15 s and the engine was reported broken, when what
 * had actually happened is that a public academic index answered slowly. Fetching a document and querying an
 * index are different work; sharing one timeout makes the slower one look like a failure.
 */
const SEARCH_TIMEOUT_MS = 25_000;

function fail(status: number, blocked?: string): Error {
  return new Error(`HTTP ${status}${blocked ? ' ' + blocked : ''}`);
}

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetchWithOptions(url, {
    headers: { accept: 'application/json', ...headers },
    maxBytes: MAX_BYTES,
    timeoutMs: SEARCH_TIMEOUT_MS,
    cache: false,
  });
  if (response.status >= 400) throw fail(response.status, response.blocked?.kind);
  return parseUpstreamJson<T>(response, url);
}

async function postJson<T>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetchWithOptions(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    maxBytes: MAX_BYTES,
    timeoutMs: SEARCH_TIMEOUT_MS,
    cache: false,
  });
  if (response.status >= 400) throw fail(response.status, response.blocked?.kind);
  return parseUpstreamJson<T>(response, url);
}

async function getHtml(url: string, headers: Record<string, string> = {}): Promise<ReturnType<typeof load>> {
  const response = await fetchWithOptions(url, {
    headers: { accept: 'text/html', ...headers },
    maxBytes: MAX_BYTES,
    timeoutMs: SEARCH_TIMEOUT_MS,
    cache: false,
  });
  if (response.status >= 400) throw fail(response.status, response.blocked?.kind);
  // 202 with a challenge page is DuckDuckGo's way of saying "not today". It is not an HTTP error, so the
  // status check above lets it through; an empty result list is the honest reading of it.
  return load(response.text);
}

/**
 * Feeds must be read in XML mode.
 *
 * In HTML parsing `<link>` is a **void element** — it cannot hold text — so `$('item').find('link').text()`
 * comes back empty for every item, and the filter that requires a URL dropped all of them. Measured: the
 * Google News feed parsed 50 items and the engine returned 0.
 */
async function getFeed(url: string): Promise<ReturnType<typeof load>> {
  const response = await fetchWithOptions(url, {
    headers: { accept: 'application/rss+xml, application/atom+xml, text/xml, application/xml' },
    maxBytes: MAX_BYTES,
    timeoutMs: SEARCH_TIMEOUT_MS,
    cache: false,
  });
  if (response.status >= 400) throw fail(response.status, response.blocked?.kind);
  return load(response.text, { xmlMode: true });
}

const clean = (value: string | undefined | null): string => (value ?? '').replace(/\s+/g, ' ').trim();

function host(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/* ----------------------------------------------------------- credentialed */

const serper: SearchEngine = {
  id: 'serper',
  label: 'Serper (Google)',
  kind: 'general',
  credentials: ['SERPER_API_KEY'],
  settings: [],
  verified: 'endpoint',
  evidence:
    'HTTP 403 "Unauthorized. Sign up for a free account." with no key; results were observed with a key earlier.',
  configured: () => Boolean(getCredential('SERPER_API_KEY')),
  async search(query, limit) {
    const payload = await postJson<{ organic?: Array<{ title?: string; link?: string; snippet?: string }> }>(
      'https://google.serper.dev/search',
      { q: query, num: limit },
      { 'x-api-key': getCredential('SERPER_API_KEY') ?? '' },
    );
    return (payload.organic ?? []).map((item) => ({
      title: clean(item.title),
      url: item.link ?? '',
      snippet: clean(item.snippet),
    }));
  },
};

const brave: SearchEngine = {
  id: 'brave',
  label: 'Brave Search',
  kind: 'general',
  credentials: ['SEARCH_API_KEY'],
  settings: [],
  verified: 'endpoint',
  evidence: 'HTTP 422 naming the missing x-subscription-token header — the header the code sends.',
  configured: () => Boolean(getCredential('SEARCH_API_KEY')),
  async search(query, limit) {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(limit));
    const payload = await getJson<{
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    }>(url.toString(), { 'x-subscription-token': getCredential('SEARCH_API_KEY') ?? '' });
    return (payload.web?.results ?? []).map((item) => ({
      title: clean(item.title),
      url: item.url ?? '',
      snippet: clean(item.description),
    }));
  },
};

const tavily: SearchEngine = {
  id: 'tavily',
  label: 'Tavily',
  kind: 'general',
  credentials: ['TAVILY_API_KEY'],
  settings: [],
  verified: 'endpoint',
  evidence: 'HTTP 401 "Unauthorized: missing or invalid API key" on both the body key and the bearer header.',
  configured: () => Boolean(getCredential('TAVILY_API_KEY')),
  async search(query, limit) {
    const payload = await postJson<{
      results?: Array<{ title?: string; url?: string; content?: string }>;
    }>(
      'https://api.tavily.com/search',
      { query, max_results: limit },
      { authorization: `Bearer ${getCredential('TAVILY_API_KEY') ?? ''}` },
    );
    return (payload.results ?? []).map((item) => ({
      title: clean(item.title),
      url: item.url ?? '',
      snippet: clean(item.content),
    }));
  },
};

const exa: SearchEngine = {
  id: 'exa',
  label: 'Exa',
  kind: 'general',
  credentials: ['EXA_API_KEY'],
  settings: [],
  verified: 'endpoint',
  evidence: 'HTTP 401 "Invalid API key. Provide a valid key using Authorization: Bearer or x-api-key".',
  configured: () => Boolean(getCredential('EXA_API_KEY')),
  async search(query, limit) {
    const payload = await postJson<{
      results?: Array<{ title?: string; url?: string; text?: string; publishedDate?: string }>;
    }>(
      'https://api.exa.ai/search',
      { query, numResults: limit, contents: { text: { maxCharacters: 400 } } },
      { 'x-api-key': getCredential('EXA_API_KEY') ?? '' },
    );
    return (payload.results ?? []).map((item) => ({
      title: clean(item.title) || host(item.url ?? ''),
      url: item.url ?? '',
      snippet: clean(item.text),
    }));
  },
};

const serpapi: SearchEngine = {
  id: 'serpapi',
  label: 'SerpAPI (Google)',
  kind: 'general',
  credentials: ['SERPAPI_API_KEY'],
  settings: [],
  verified: 'endpoint',
  evidence: 'HTTP 401 "Invalid API key" pointing at the key management page.',
  configured: () => Boolean(getCredential('SERPAPI_API_KEY')),
  async search(query, limit) {
    const url = new URL('https://serpapi.com/search.json');
    url.searchParams.set('engine', 'google');
    url.searchParams.set('q', query);
    url.searchParams.set('num', String(limit));
    url.searchParams.set('api_key', getCredential('SERPAPI_API_KEY') ?? '');
    const payload = await getJson<{
      organic_results?: Array<{ title?: string; link?: string; snippet?: string }>;
    }>(url.toString());
    return (payload.organic_results ?? []).map((item) => ({
      title: clean(item.title),
      url: item.link ?? '',
      snippet: clean(item.snippet),
    }));
  },
};

const linkup: SearchEngine = {
  id: 'linkup',
  label: 'Linkup',
  kind: 'general',
  credentials: ['LINKUP_API_KEY'],
  settings: [],
  verified: 'endpoint',
  evidence: 'HTTP 401 with an invalid bearer key; without the key it answers 402, and it names outputType as required.',
  configured: () => Boolean(getCredential('LINKUP_API_KEY')),
  async search(query, limit) {
    const payload = await postJson<{
      results?: Array<{ name?: string; title?: string; url?: string; snippet?: string; content?: string }>;
    }>(
      'https://api.linkup.so/v1/search',
      { q: query, depth: 'standard', outputType: 'searchResults' },
      { authorization: `Bearer ${getCredential('LINKUP_API_KEY') ?? ''}` },
    );
    return (payload.results ?? []).map((item) => ({
      title: clean(item.name ?? item.title),
      url: item.url ?? '',
      snippet: clean(item.snippet ?? item.content),
    }));
  },
};

const dataforseo: SearchEngine = {
  id: 'dataforseo',
  label: 'DataForSEO (Google SERP)',
  kind: 'general',
  credentials: ['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD'],
  settings: [],
  verified: 'endpoint',
  evidence: 'HTTP 401 with status_code 40100 "You are not Authorized to Access this Resource".',
  configured: () => Boolean(getCredential('DATAFORSEO_LOGIN') && getCredential('DATAFORSEO_PASSWORD')),
  async search(query, limit) {
    const token = Buffer.from(
      `${getCredential('DATAFORSEO_LOGIN') ?? ''}:${getCredential('DATAFORSEO_PASSWORD') ?? ''}`,
      'utf8',
    ).toString('base64');
    const payload = await postJson<{
      result?: Array<{ tasks?: Array<{ result?: Array<{ title?: string; link?: string; description?: string }> }> }>;
    }>(
      'https://api.dataforseo.com/v3/serp/google/organic/live/advanced',
      [{ keyword: query, location_code: 2840, language_code: 'en', depth: Math.min(limit, 100) }],
      { authorization: `Basic ${token}` },
    );
    const rows = payload.result?.[0]?.tasks?.[0]?.result ?? [];
    return rows.map((item) => ({
      title: clean(item.title),
      url: item.link ?? '',
      snippet: clean(item.description),
    }));
  },
};

const googleCse: SearchEngine = {
  id: 'google-cse',
  label: 'Google Custom Search',
  kind: 'general',
  credentials: ['GOOGLE_API_KEY'],
  settings: ['GOOGLE_CSE_ID'],
  verified: 'endpoint',
  evidence: 'HTTP 403 "Method doesn’t allow unregistered callers" — the endpoint is live and wants a key.',
  configured: () => Boolean(getCredential('GOOGLE_API_KEY') && getCredential('GOOGLE_CSE_ID')),
  async search(query, limit) {
    const url = new URL('https://www.googleapis.com/customsearch/v1');
    url.searchParams.set('key', getCredential('GOOGLE_API_KEY') ?? '');
    url.searchParams.set('cx', getCredential('GOOGLE_CSE_ID') ?? '');
    url.searchParams.set('q', query);
    url.searchParams.set('num', String(Math.min(limit, 10)));
    const payload = await getJson<{ items?: Array<{ title?: string; link?: string; snippet?: string }> }>(
      url.toString(),
    );
    return (payload.items ?? []).map((item) => ({
      title: clean(item.title),
      url: item.link ?? '',
      snippet: clean(item.snippet),
    }));
  },
};

const perplexity: SearchEngine = {
  id: 'perplexity',
  label: 'Perplexity (Sonar)',
  kind: 'general',
  credentials: ['PERPLEXITY_API_KEY'],
  settings: [],
  verified: 'endpoint',
  evidence: 'HTTP 401 {"type":"invalid_api_key"} on the chat-completions endpoint.',
  configured: () => Boolean(getCredential('PERPLEXITY_API_KEY')),
  async search(query, limit) {
    const payload = await postJson<{
      choices?: Array<{
        message?: {
          content?: string;
          citations?: string[];
          search_results?: Array<{ title?: string; url?: string; snippet?: string }>;
        };
      }>;
    }>(
      'https://api.perplexity.ai/chat/completions',
      { model: 'sonar', messages: [{ role: 'user', content: query }] },
      { authorization: `Bearer ${getCredential('PERPLEXITY_API_KEY') ?? ''}` },
    );
    const message = payload.choices?.[0]?.message;
    const direct = message?.search_results ?? [];
    if (direct.length > 0) {
      return direct.map((item) => ({ title: clean(item.title), url: item.url ?? '', snippet: clean(item.snippet) }));
    }
    // Sonar returns the links it read, not a ranked list. Titles are the host, and that is stated rather
    // than dressed up as a search result set.
    return (message?.citations ?? []).slice(0, limit).map((url) => ({
      title: host(url),
      url,
      snippet: 'cited by the model; Sonar returns sources, not snippets',
    }));
  },
};

/* ---------------------------------------------------------------- keyless */

const duckduckgo: SearchEngine = {
  id: 'duckduckgo',
  label: 'DuckDuckGo',
  kind: 'general',
  credentials: [],
  settings: [],
  verified: 'live',
  evidence:
    'HTML endpoint parsed by this code for months; on 2026-11-06 it answered 202 with zero results, which is why it is no longer the last resort alone.',
  configured: () => true,
  async search(query, limit) {
    const url = new URL('https://html.duckduckgo.com/html/');
    url.searchParams.set('q', query);
    const $ = await getHtml(url.toString());
    return $('.result')
      .toArray()
      .slice(0, limit)
      .map((node) => ({
        title: clean($(node).find('.result__a').first().text()),
        url: $(node).find('.result__a').first().attr('href') ?? '',
        snippet: clean($(node).find('.result__snippet').first().text()),
      }))
      .filter((item) => item.title && item.url);
  },
};

const marginalia: SearchEngine = {
  id: 'marginalia',
  label: 'Marginalia',
  kind: 'general',
  credentials: [],
  settings: [],
  verified: 'live',
  evidence:
    'Measured 2026-11-06: 2 external links with the product user-agent, 69 with a browser one. It is a user-agent filter, so it is only used when PRO_FETCH_HTTP_COMPAT_UA is on.',
  configured: () => compatUaEnabled(),
  async search(query, limit) {
    const url = new URL('https://search.marginalia.nu/search');
    url.searchParams.set('query', query);
    url.searchParams.set('profile', 'default');
    const $ = await getHtml(url.toString(), { 'user-agent': COMPAT_USER_AGENT });
    const seen = new Set<string>();
    const results: WebSearchResult[] = [];
    for (const node of $('a[href]').toArray()) {
      const href = $(node).attr('href') ?? '';
      if (!/^https?:\/\//.test(href) || href.includes('marginalia')) continue;
      const text = clean($(node).text());
      if (!text || text === href || seen.has(href)) continue;
      seen.add(href);
      results.push({ title: text, url: href, snippet: '' });
      if (results.length >= limit) break;
    }
    return results;
  },
};

const searxng: SearchEngine = {
  id: 'searxng',
  label: 'SearXNG',
  kind: 'general',
  credentials: [],
  settings: ['SEARXNG_URL'],
  verified: 'operator',
  evidence:
    'Only an operator-hosted instance is usable: searx.be and priv.au were probed and answered a JS challenge or 403 for format=json. Set SEARXNG_URL to your own instance.',
  configured: () => Boolean(process.env.SEARXNG_URL?.trim()),
  async search(query, limit) {
    const base = (process.env.SEARXNG_URL ?? '').trim().replace(/\/+$/, '');
    const url = new URL(`${base}/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    const payload = await getJson<{ results?: Array<{ title?: string; url?: string; content?: string }> }>(
      url.toString(),
    );
    return (payload.results ?? []).slice(0, limit).map((item) => ({
      title: clean(item.title),
      url: item.url ?? '',
      snippet: clean(item.content),
    }));
  },
};

const hackerNews: SearchEngine = {
  id: 'hackernews',
  label: 'Hacker News (Algolia)',
  kind: 'community',
  credentials: [],
  settings: [],
  verified: 'live',
  evidence: '5 hits for a technical query, HTTP 200 in 696 ms, no credential.',
  configured: () => true,
  async search(query, limit) {
    const url = new URL('https://hn.algolia.com/api/v1/search');
    url.searchParams.set('query', query);
    url.searchParams.set('hitsPerPage', String(limit));
    const payload = await getJson<{
      hits?: Array<{ title?: string; url?: string; objectID?: string; story_text?: string; comment_text?: string }>;
    }>(url.toString());
    return (payload.hits ?? [])
      .map((hit) => ({
        title: clean(hit.title) || 'Hacker News discussion',
        url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID ?? ''}`,
        snippet: clean(hit.story_text ?? hit.comment_text).slice(0, 300),
      }))
      .filter((item) => Boolean(item.url));
  },
};

const wikipedia: SearchEngine = {
  id: 'wikipedia',
  label: 'Wikipedia',
  kind: 'reference',
  credentials: [],
  settings: [],
  verified: 'live',
  evidence: 'HTTP 200 with a structured answer; it also returns a spelling suggestion when the query matches nothing.',
  configured: () => true,
  async search(query, limit) {
    const url = new URL('https://en.wikipedia.org/w/api.php');
    url.searchParams.set('action', 'query');
    url.searchParams.set('list', 'search');
    url.searchParams.set('srsearch', query);
    url.searchParams.set('srlimit', String(limit));
    url.searchParams.set('format', 'json');
    const payload = await getJson<{
      query?: { search?: Array<{ title?: string; snippet?: string }> };
    }>(url.toString());
    return (payload.query?.search ?? []).map((item) => ({
      title: clean(item.title),
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent((item.title ?? '').replace(/ /g, '_'))}`,
      snippet: clean(item.snippet).replace(/<[^>]+>/g, ''),
    }));
  },
};

const npm: SearchEngine = {
  id: 'npm',
  label: 'npm registry',
  kind: 'packages',
  credentials: [],
  settings: [],
  verified: 'live',
  evidence: '5 packages with download counts, HTTP 200 in 1.3 s, no credential.',
  configured: () => true,
  async search(query, limit) {
    const url = new URL('https://registry.npmjs.org/-/v1/search');
    url.searchParams.set('text', query);
    url.searchParams.set('size', String(limit));
    const payload = await getJson<{
      objects?: Array<{ package?: { name?: string; description?: string; links?: { npm?: string } } }>;
    }>(url.toString());
    return (payload.objects ?? []).map((item) => ({
      title: clean(item.package?.name),
      url: item.package?.links?.npm ?? '',
      snippet: clean(item.package?.description),
    }));
  },
};

const itunes: SearchEngine = {
  id: 'itunes',
  label: 'iTunes / Apple Podcasts',
  kind: 'media',
  credentials: [],
  settings: [],
  verified: 'live',
  evidence: '5 results with artwork and URLs, HTTP 200 in 783 ms, no credential.',
  configured: () => true,
  async search(query, limit) {
    const url = new URL('https://itunes.apple.com/search');
    url.searchParams.set('term', query);
    url.searchParams.set('media', 'podcast');
    url.searchParams.set('limit', String(limit));
    const payload = await getJson<{
      results?: Array<{
        trackName?: string;
        collectionName?: string;
        trackViewUrl?: string;
        collectionViewUrl?: string;
        shortDescription?: { text?: string };
      }>;
    }>(url.toString());
    return (payload.results ?? []).map((item) => ({
      title: clean(item.trackName ?? item.collectionName),
      url: item.trackViewUrl ?? item.collectionViewUrl ?? '',
      snippet: clean(item.shortDescription?.text),
    }));
  },
};

/* ------------------------------------------------------------- academic */

const openalex: SearchEngine = {
  id: 'openalex',
  label: 'OpenAlex',
  kind: 'academic',
  credentials: [],
  settings: [],
  verified: 'live',
  evidence: '5 works with DOIs, HTTP 200 in 2.0 s, no credential.',
  configured: () => true,
  async search(query, limit) {
    const url = new URL('https://api.openalex.org/works');
    url.searchParams.set('search', query);
    url.searchParams.set('per-page', String(limit));
    const payload = await getJson<{
      results?: Array<{
        title?: string | null;
        doi?: string | null;
        id?: string;
        primary_location?: { landing_page_url?: string | null };
        display_name?: string | null;
        abstract_inverted_index?: Record<string, unknown>;
      }>;
    }>(url.toString());
    return (payload.results ?? []).map((item) => ({
      title: clean(item.title ?? item.display_name),
      url: item.doi || item.primary_location?.landing_page_url || item.id || '',
      snippet: '',
    }));
  },
};

const crossref: SearchEngine = {
  id: 'crossref',
  label: 'Crossref',
  kind: 'academic',
  credentials: [],
  settings: [],
  verified: 'live',
  evidence: '5 items, HTTP 200 in 1.1 s, no credential.',
  configured: () => true,
  async search(query, limit) {
    const url = new URL('https://api.crossref.org/works');
    url.searchParams.set('query', query);
    url.searchParams.set('rows', String(limit));
    const payload = await getJson<{
      message?: { items?: Array<{ title?: string[]; URL?: string; abstract?: string; container_title?: string[] }> };
    }>(url.toString());
    return (payload.message?.items ?? []).map((item) => ({
      title: clean(item.title?.[0]),
      url: item.URL ?? '',
      snippet: clean(item.abstract)
        .replace(/<[^>]+>/g, '')
        .slice(0, 300),
    }));
  },
};

const arxiv: SearchEngine = {
  id: 'arxiv',
  label: 'arXiv',
  kind: 'academic',
  credentials: [],
  settings: [],
  verified: 'live',
  evidence: 'Atom feed, HTTP 200 in 804 ms, no credential.',
  configured: () => true,
  async search(query, limit) {
    const url = new URL('https://export.arxiv.org/api/query');
    url.searchParams.set('search_query', `all:"${query.replace(/"/g, '')}"`);
    url.searchParams.set('max_results', String(limit));
    const $ = await getFeed(url.toString());
    const items: WebSearchResult[] = [];
    $('entry').each((_, node) => {
      const title = clean($(node).find('title').first().text());
      const link = $(node).find('id').first().text().trim();
      if (!title || !link) return;
      items.push({ title, url: link, snippet: clean($(node).find('summary').first().text()).slice(0, 300) });
    });
    return items;
  },
};

const pubmed: SearchEngine = {
  id: 'pubmed',
  label: 'PubMed',
  kind: 'academic',
  credentials: [],
  settings: [],
  verified: 'live',
  evidence: 'esearch + esummary both HTTP 200 with JSON, no credential.',
  configured: () => true,
  async search(query, limit) {
    const search = new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi');
    search.searchParams.set('db', 'pubmed');
    search.searchParams.set('term', query);
    search.searchParams.set('retmode', 'json');
    search.searchParams.set('retmax', String(limit));
    const ids = await getJson<{ esearchresult?: { idlist?: string[] } }>(search.toString());
    const uids = ids.esearchresult?.idlist ?? [];
    if (uids.length === 0) return [];
    const summary = new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi');
    summary.searchParams.set('db', 'pubmed');
    summary.searchParams.set('id', uids.join(','));
    summary.searchParams.set('retmode', 'json');
    const docs = await getJson<{
      result?: Record<string, { title?: string; source?: string; pubdate?: string; authorstring?: string }>;
    }>(summary.toString());
    return uids
      .map((uid) => {
        const doc = docs.result?.[uid];
        if (!doc) return null;
        return {
          title: clean(doc.title),
          url: `https://pubmed.ncbi.nlm.nih.gov/${uid}/`,
          snippet: [clean(doc.authorstring), clean(doc.source), clean(doc.pubdate)].filter(Boolean).join(' · '),
        } satisfies WebSearchResult;
      })
      .filter((item): item is WebSearchResult => Boolean(item));
  },
};

const europePmc: SearchEngine = {
  id: 'europepmc',
  label: 'Europe PMC',
  kind: 'academic',
  credentials: [],
  settings: [],
  verified: 'live',
  evidence: 'hitCount 3 with results, HTTP 200 in 1.1 s, no credential.',
  configured: () => true,
  async search(query, limit) {
    const url = new URL('https://www.ebi.ac.uk/europepmc/webservices/rest/search');
    url.searchParams.set('query', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('pageSize', String(limit));
    const payload = await getJson<{
      resultList?: {
        result?: Array<{ title?: string; id?: string; source?: string; doi?: string; abstractText?: string }>;
      };
    }>(url.toString());
    return (payload.resultList?.result ?? []).map((item) => ({
      title: clean(item.title),
      url: item.doi
        ? `https://doi.org/${item.doi}`
        : `https://europepmc.org/article/${item.source ?? 'med'}/${item.id ?? ''}`,
      snippet: clean(item.abstractText).slice(0, 300),
    }));
  },
};

const doaj: SearchEngine = {
  id: 'doaj',
  label: 'DOAJ',
  kind: 'academic',
  credentials: [],
  settings: [],
  verified: 'live',
  evidence: 'HTTP 200 with a structured answer (0 hits for the probe query, which is an answer, not a failure).',
  configured: () => true,
  async search(query, limit) {
    const url = `https://doaj.org/api/search/articles/${encodeURIComponent(query)}?pageSize=${limit}`;
    const payload = await getJson<{
      results?: Array<{
        bibinfo?: { title?: string; doi?: string };
        link?: Array<{ url?: string }>;
        abstract?: string;
      }>;
    }>(url);
    return (payload.results ?? []).map((item) => ({
      title: clean(item.bibinfo?.title),
      url: item.link?.[0]?.url ?? (item.bibinfo?.doi ? `https://doi.org/${item.bibinfo.doi}` : ''),
      snippet: clean(item.abstract).slice(0, 300),
    }));
  },
};

/* ----------------------------------------------------------------- news */

const googleNews: SearchEngine = {
  id: 'google-news',
  label: 'Google News (RSS)',
  kind: 'news',
  credentials: [],
  settings: [],
  verified: 'live',
  evidence: 'RSS 2.0 feed, HTTP 200 in 754 ms, no credential.',
  configured: () => true,
  async search(query, limit) {
    const url = new URL('https://news.google.com/rss/search');
    url.searchParams.set('q', query);
    const $ = await getFeed(url.toString());
    const items: WebSearchResult[] = [];
    $('item')
      .slice(0, limit)
      .each((_, node) => {
        const title = clean($(node).find('title').first().text());
        const link = $(node).find('link').first().text().trim();
        const source = $(node).find('source').first().text().trim();
        const pub = clean($(node).find('pubDate').first().text());
        if (!title || !link) return;
        items.push({ title, url: link, snippet: [source, pub].filter(Boolean).join(' · ') });
      });
    return items;
  },
};

/**
 * The registry, in the order a fallback chain should try them: engines that index the whole web and need a
 * key first (they are the ones that answer like a search engine), then the keyless general engines, then the
 * narrower ones. A caller who asks for one engine by id gets exactly that, whatever this order says.
 */
export const SEARCH_ENGINES: SearchEngine[] = [
  serper,
  brave,
  tavily,
  exa,
  serpapi,
  linkup,
  dataforseo,
  googleCse,
  perplexity,
  duckduckgo,
  marginalia,
  searxng,
  hackerNews,
  wikipedia,
  npm,
  itunes,
  openalex,
  crossref,
  arxiv,
  pubmed,
  europePmc,
  doaj,
  googleNews,
];

export function engineById(id: string): SearchEngine | undefined {
  const needle = id.trim().toLowerCase();
  return SEARCH_ENGINES.find((engine) => engine.id === needle || engine.label.toLowerCase() === needle);
}

export function enginesFor(kind?: SearchEngineKind | 'general-first'): SearchEngine[] {
  if (kind === undefined || kind === 'general-first') return SEARCH_ENGINES;
  return SEARCH_ENGINES.filter((engine) => engine.kind === kind);
}

export interface EngineStatus {
  id: string;
  label: string;
  kind: SearchEngineKind;
  usable: boolean;
  needs: string[];
  verified: SearchEngine['verified'];
  evidence: string;
}

/** What can be used right now, and what is missing when it cannot. Never a key value, only its name. */
export function engineStatuses(kind?: SearchEngineKind): EngineStatus[] {
  return enginesFor(kind).map((engine) => ({
    id: engine.id,
    label: engine.label,
    kind: engine.kind,
    usable: engine.configured(),
    needs: [...engine.credentials, ...engine.settings],
    verified: engine.verified,
    evidence: engine.evidence,
  }));
}
