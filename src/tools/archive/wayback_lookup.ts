import { fetchWithOptions } from '../../core/http-client.js';
import { jsonBlock, fail } from '../../core/format.js';
import { parseUpstreamJson } from '../../core/json-response.js';

/**
 * pro_fetch_wayback_lookup — List Wayback Machine snapshots availability of a URL
 * Pack: archive (REAL ✅) (pro-fetch)
 */
import { defineTool } from '../../core/tool.js';
import { strOrEmpty, view } from '../../core/input.js';

/**
 * What the availability endpoint's answer means.
 *
 * Kept as a pure function because the endpoint is not the interesting part: it answers with an HTML
 * block page or a 503 body often enough that a direct parse of the response body threw at the caller —
 * an ops persona
 * reported "CDX HTML qaytardi" and could not tell a missing snapshot from a broken request. Those are
 * different answers and the tool must say which one it got.
 */
export function interpretWayback(
  queried: string,
  parsed: Record<string, unknown>,
): { payload: Record<string, unknown> } {
  const snapshots = (parsed.archived_snapshots ?? {}) as Record<string, unknown>;
  const closest = snapshots.closest as Record<string, unknown> | undefined;
  if (!closest) {
    return {
      payload: { url: queried, available: false, note: 'bu URL uchun nusxa topilmadi (hech qanday snapshot yo‘q)' },
    };
  }
  return {
    payload: {
      url: queried,
      available: true,
      snapshot_url: closest.url,
      timestamp: closest.timestamp,
      snapshot_status: closest.status,
      raw: parsed,
    },
  };
}

export default defineTool({
  name: 'pro_fetch_wayback_lookup',
  description: 'List Wayback Machine snapshots availability of a URL',
  category: 'archive',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Manzil' },
    },
    required: ['url'],
    additionalProperties: false,
  },
  async handler(input) {
    const p = view(input);
    const queried = strOrEmpty(p, 'url');
    if (!queried) return fail('url kerak.');
    const r = await fetchWithOptions('https://archive.org/wayback/available?url=' + encodeURIComponent(queried));
    if (r.status >= 400) return fail(`Wayback availability API ${r.status} qaytardi — bu nusxa yo‘q degani emas.`);
    let decoded: Record<string, unknown>;
    try {
      // The helper, not a bare parse with an empty-object default: a throttling page is HTML with a 200
      // a `{}` default turns that into a silent "no snapshot" claim. Measured by an ops host that read
      // the old behaviour as "eski nusxa yo'q".
      decoded = parseUpstreamJson<Record<string, unknown>>(r, 'Wayback availability API');
    } catch (error) {
      return fail((error as Error).message);
    }
    return jsonBlock('# Wayback: ' + queried, interpretWayback(queried, decoded).payload);
  },
});
