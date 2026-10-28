import { fetchWithOptions } from '../../core/http-client.js';
import { jsonBlock, fail } from '../../core/format.js';

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
 * block page or a 503 body often enough that `JSON.parse(r.text)` threw at the caller — an ops persona
 * reported "CDX HTML qaytardi" and could not tell a missing snapshot from a broken request. Those are
 * different answers and the tool must say which one it got.
 */
export function interpretWayback(
  queried: string,
  status: number,
  contentType: string,
  text: string,
): { ok: boolean; message?: string; payload?: Record<string, unknown> } {
  const trimmed = (text ?? '').trim();
  if (status >= 400) {
    return {
      ok: false,
      message: `Wayback API ${status} qaytardi (${contentType || 'content-type yo‘q'})`,
    };
  }
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return {
      ok: false,
      message:
        `Wayback API JSON emas javob qaytardi (HTTP ${status}, content-type: ${contentType || 'noma’lum'}). ` +
        `Bu odatda archive.org throttling yoki blok sahifasidir — nusxa yo‘q degani emas. Boshlap: ${trimmed.slice(0, 120)}`,
    };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch (error) {
    return { ok: false, message: `Wayback javobi JSON sifatida o'qilmadi: ${(error as Error).message}` };
  }
  const snapshots = (parsed.archived_snapshots ?? {}) as Record<string, unknown>;
  const closest = snapshots.closest as Record<string, unknown> | undefined;
  if (!closest) {
    return {
      ok: true,
      payload: { url: queried, available: false, note: 'bu URL uchun nusxa topilmadi (hech qanday snapshot yo‘q)' },
    };
  }
  return {
    ok: true,
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
    const interpreted = interpretWayback(queried, r.status, String(r.headers?.['content-type'] ?? ''), r.text ?? '');
    if (!interpreted.ok) return fail(interpreted.message ?? 'Wayback javobi o‘qilmadi.');
    return jsonBlock('# Wayback: ' + queried, interpreted.payload ?? {});
  },
});
