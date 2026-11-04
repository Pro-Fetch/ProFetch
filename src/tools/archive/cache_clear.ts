import { defineTool } from '../../core/tool.js';
import { jsonBlock } from '../../core/format.js';
import { cache } from '../../core/cache.js';

/**
 * pro_fetch_cache_clear — Clear the cache fully
 * Pack: archive (REAL ✅) (pro-fetch)
 *
 * The schema used to declare a required `url` that no line of code read, and an unused `view(input)` inside
 * the handler was what hid it from the schema audit: a statement that touches the whole input looks like a
 * read of every property. The tool clears everything, so it takes nothing — a "clear by URL" that could
 * only reach one of the two cache layers would be a claim this tool cannot keep.
 */
export default defineTool({
  name: 'pro_fetch_cache_clear',
  description:
    'Clear every entry in the response cache. Takes no arguments — the whole cache is emptied, and the number of entries it held is reported.',
  category: 'archive',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  async handler() {
    const before = cache.stats().size;
    cache.clear();
    return jsonBlock(`cache cleared (${before} entry(ies) removed)`, {
      ok: true,
      cleared: before,
      size_after: cache.stats().size,
    });
  },
});
