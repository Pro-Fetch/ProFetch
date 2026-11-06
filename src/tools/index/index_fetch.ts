import { defineTool } from '../../core/tool.js';
import { failJson, jsonBlock } from '../../core/format.js';
import { num, strOrEmpty, view } from '../../core/input.js';
import { fetchUrl } from '../../core/fetcher.js';
import { indexDocument } from '../../core/local-index.js';

/**
 * pro_index_fetch — read a page once and put it in the local index
 * Pack: index (pro-fetch)
 *
 * The bridge between fetching and having. Without this tool the index only fills when a caller hands over
 * body text, which in practice means it never fills; with it, one call makes a page searchable, gives it a
 * next-visit time, and records the links it points at, so the site graph grows as it is read.
 */
export default defineTool({
  name: 'pro_index_fetch',
  description:
    "Bir sahifani yuklab lokal indeksga qo'yadi: matn, sarlavha, havolalar va keyingi tashrif vaqti. " +
    'Keyin pro_index_search unga millisekundda javob beradi.',
  category: 'index',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Yuklanadigan manzil (http/https)' },
      kind: {
        type: 'string',
        description: 'Sahifa turi — yangilanish jadvalini shu belgilaydi: news, docs, page, reference',
      },
      max_tokens: { type: 'number', description: "O'qib indekslanadigan hajm chegarasi (token)" },
    },
    required: ['url'],
  },
  async handler(input) {
    const p = view(input);
    const url = strOrEmpty(p, 'url');
    if (!url) return failJson('Indeks', { error: 'url kerak' });
    const kind = strOrEmpty(p, 'kind') || 'page';

    let fetched;
    try {
      const maxTokens = num(p, 'max_tokens', 0);
      fetched = await fetchUrl(url, { useCache: false, ...(maxTokens > 0 ? { maxTokens } : {}) });
    } catch (error) {
      return failJson('Indeks', { url, error: (error as Error).message });
    }
    if (fetched.blocked) {
      // A refusal page is not a document. Indexing it would make the block searchable, and later rank
      // against the real page it was standing in for.
      return failJson('Indeks', {
        url,
        error: `sahifa rad javobi berdi: ${fetched.blocked.kind} (${fetched.blocked.marker})`,
        hint: fetched.blocked.hint,
      });
    }

    const stored = await indexDocument({
      url: fetched.url,
      site: '',
      title: titleOf(fetched.markdown),
      lang: 'und',
      kind,
      body: fetched.markdown,
      links: markdownLinks(fetched.markdown, fetched.url),
      fetchedAtMs: Date.now(),
    });

    return jsonBlock('Indekslendi', {
      ok: true,
      ...stored,
      status: fetched.status,
      compat_ua: fetched.compat_ua ?? false,
      note:
        "kind qayta o'qish jadvalini belgilaydi: news soatiga, docs kunduziga, page haftasiga, reference " +
        "oyiga. Uch ketma-ket o'zgargan sahifa avtomatik tezlashadi (1 soatgacha).",
    });
  },
});

/** The first markdown heading, or the first real line: what the page calls itself. */
function titleOf(markdown: string): string {
  const heading = /^#{1,3}\s+(.+)$/m.exec(markdown);
  if (heading) return heading[1].trim().slice(0, 200);
  const line = markdown
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 3);
  return (line ?? '').slice(0, 200);
}

/**
 * Absolute targets of the markdown links in a body, resolved against the page's own URL.
 *
 * Only `http(s)` targets are kept: a `#fragment`, `mailto:` or a relative image is not an edge in a site
 * graph, and counting one as a vote would inflate the authority of pages nobody linked to.
 */
export function markdownLinks(markdown: string, baseUrl: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let base: URL | undefined;
  try {
    base = new URL(baseUrl);
  } catch {
    base = undefined;
  }
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)\s]+)/g)) {
    const href = match[1];
    if (!href || href.startsWith('#') || (!/^[a-z]+:/i.test(href) && !base)) continue;
    try {
      const resolved = new URL(href, base);
      if (!/^https?:$/.test(resolved.protocol)) continue;
      const clean = resolved.toString();
      if (clean === baseUrl || seen.has(clean)) continue;
      seen.add(clean);
      out.push(clean);
    } catch {
      /* an unparseable href is not an edge */
    }
  }
  return out.slice(0, 200);
}
