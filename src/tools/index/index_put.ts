import { defineTool } from '../../core/tool.js';
import { failJson, jsonBlock } from '../../core/format.js';
import { num, strOrEmpty, view } from '../../core/input.js';
import { indexDocument } from '../../core/local-index.js';

/**
 * pro_index_put — index text the caller already holds
 * Pack: index (pro-fetch)
 *
 * `pro_index_fetch` goes to the network; this one does not, and that difference is the point. A research
 * run that has already read a page, converted a PDF or cleaned a feed can put the result into the index
 * without fetching it twice. The caller states the language here, because when the body did not come from
 * a live page the server has no header or `<html lang>` to read it from.
 */
export default defineTool({
  name: 'pro_index_put',
  description:
    "Tayyor matnni lokal indeksga qo'yadi (tarmoqqa chiqmaydi). Sarlavha, til, tur va havolalarni birga " +
    'berish mumkin.',
  category: 'index',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Hujjat manzili (indeks kaliti)' },
      title: { type: 'string', description: 'Sarlavha' },
      content: { type: 'string', description: 'Indekslanadigan matn' },
      lang: { type: 'string', description: "Til kodi (masalan 'en', 'uz'); berilmasa 'und'" },
      kind: { type: 'string', description: 'news | docs | page | reference' },
      site: { type: 'string', description: "Host; berilmasa url'dan olinadi" },
      links: {
        type: 'array',
        items: { type: 'string' },
        description: 'Sahifadan chiquvchi havolalar — sayt grafigi shundan hisoblanadi',
      },
      fetched_at_ms: { type: 'number', description: "O'qilgan vaqt (epoch ms); berilmasa hozir" },
    },
    required: ['url', 'content'],
  },
  async handler(input) {
    const p = view(input);
    const url = strOrEmpty(p, 'url');
    const content = typeof p.content === 'string' ? p.content : '';
    if (!url) return failJson('Indeks', { error: 'url kerak' });
    if (!content.trim()) return failJson('Indeks', { error: 'content bo‘sh — indekslanadigan matn yo‘q' });

    const stored = await indexDocument({
      url,
      site: strOrEmpty(p, 'site'),
      title: strOrEmpty(p, 'title'),
      lang: strOrEmpty(p, 'lang') || 'und',
      kind: strOrEmpty(p, 'kind') || 'page',
      body: content,
      links: Array.isArray(p.links) ? p.links.filter((item): item is string => typeof item === 'string') : [],
      fetchedAtMs: num(p, 'fetched_at_ms', 0) > 0 ? num(p, 'fetched_at_ms', 0) : Date.now(),
    });
    return jsonBlock('Indekslendi', { ok: true, source: 'provided', ...stored });
  },
});
