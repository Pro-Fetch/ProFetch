import { defineTool } from '../../core/tool.js';
import { jsonBlock } from '../../core/format.js';
import { cache } from '../../core/cache.js';

/**
 * pro_fetch_cache_stats — Show cache size hits and misses
 * Pack: archive (REAL ✅) (pro-fetch)
 *
 * The schema used to require a `url` that nothing read, behind an unused `view(input)` — the same shape
 * `cache_clear` had, and the reason the schema audit could not see it: a statement touching the whole
 * input looks like a read of every property.
 */
export default defineTool({
  name: 'pro_fetch_cache_stats',
  description: 'Show the response cache: how many entries it holds, and the hits and misses since boot.',
  category: 'archive',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  async handler() {
    return jsonBlock('# Cache statistikasi', cache.stats());
  },
});
