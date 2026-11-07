import { fail, result } from '../../core/format.js';
import { cache } from '../../core/cache.js';
import { fetchCacheKeyUrl } from '../../core/fetcher.js';

/**
 * pro_fetch_offline_browse — Browse cached pages without network
 * Pack: archive (REAL ✅) (pro-fetch)
 */
import { defineTool } from '../../core/tool.js';

/** What the fetcher stores under one of its own keys. */
interface StoredReading {
  url?: string;
  status?: number;
  contentType?: string;
  markdown?: string;
  tokens?: number;
  truncated?: boolean;
  method?: string;
  escalation_reason?: string;
}

export default defineTool({
  name: 'pro_fetch_offline_browse',
  description: 'Browse cached pages without network',
  category: 'archive',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: "Cache'dan ochiladigan URL; bo‘sh bo‘lsa ro‘yxat chiqadi" },
      query: { type: 'string', description: 'Cache ichidagi matndan local qidiruv' },
      limit: { type: 'number', description: 'Ko‘rsatiladigan sahifalar soni (1-50)' },
    },
  },
  async handler(input) {
    const url = typeof input.url === 'string' ? input.url.trim() : '';
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    const limitValue = Number(input.limit ?? 20);
    const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(50, Math.floor(limitValue))) : 20;
    if (url) {
      let normalized: string;
      try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP(S) URLs are supported.');
        normalized = parsed.toString();
      } catch (error) {
        throw new Error('Yaroqsiz cached URL: ' + (error instanceof Error ? error.message : String(error)));
      }
      // One address has several keys — one per token budget and per reading stage — so this is a search
      // across a family, not a lookup of a guessed spelling. Measured before the change: a page fetched by
      // `pro_fetch_fetch_url` was stored under `fetch:t8000|e1|<url>` and this tool answered "yo‘q" to that
      // same URL, because it looked for `fetch:<url>`, which nothing ever writes.
      let best: { value: string; createdAt: number } | undefined;
      for (const key of cache.keys('fetch:')) {
        if (fetchCacheKeyUrl(key) !== normalized) continue;
        const hit = cache.get(key);
        if (hit && (!best || hit.createdAt > best.createdAt)) best = hit;
      }
      const hit = best;
      if (!hit) return fail('Bu URL offline cache’da yo‘q: ' + normalized);
      try {
        const page = JSON.parse(hit.value) as StoredReading;
        return result(
          JSON.stringify(
            {
              url: normalized,
              cached: true,
              cachedAt: new Date(hit.createdAt).toISOString(),
              status: page.status ?? null,
              contentType: page.contentType ?? '',
              tokens: page.tokens ?? null,
              truncated: Boolean(page.truncated),
              // Which artefact is being handed back: what the server sent, or what its scripts drew.
              method: page.method ?? 'http',
              ...(page.escalation_reason ? { escalation_reason: page.escalation_reason } : {}),
              content: page.markdown ?? hit.value,
            },
            null,
            2,
          ),
        );
      } catch {
        return result(
          JSON.stringify(
            { url: normalized, cached: true, cachedAt: new Date(hit.createdAt).toISOString(), content: hit.value },
            null,
            2,
          ),
        );
      }
    }
    const keys = cache.keys('fetch:');
    if (query) {
      const hits = cache
        .search(query)
        .filter((hit) => hit.key.startsWith('fetch:'))
        .slice(0, limit);
      return result(
        JSON.stringify(
          {
            offline: true,
            query,
            count: hits.length,
            pages: hits.map((hit) => ({
              url: fetchCacheKeyUrl(hit.key),
              excerpt: hit.value.slice(0, 1000),
            })),
          },
          null,
          2,
        ),
      );
    }
    return result(
      JSON.stringify(
        {
          offline: true,
          count: keys.length,
          pages: keys.slice(0, limit).map((key) => ({ url: fetchCacheKeyUrl(key) })),
          truncated: keys.length > limit,
        },
        null,
        2,
      ),
    );
  },
});
