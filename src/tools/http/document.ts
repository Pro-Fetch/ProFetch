import { defineTool } from '../../core/tool.js';
import { view } from '../../core/input.js';
import { fetchUrl } from '../../core/fetcher.js';
import { buildDocument } from '../../core/document.js';
import { jsonBlock, fail } from '../../core/format.js';

/**
 * pro_fetch_document — Fetch a URL as a stable document envelope with an id, a revision and provenance
 * Pack: http (REAL ✅) (pro-fetch)
 */
export default defineTool({
  name: 'pro_fetch_document',
  description:
    'Fetch a URL as a document envelope: content id, revision checksum, title, headings, counts and provenance',
  category: 'http',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Manzil (URL)' },
      max_tokens: { type: 'number', description: 'Matn uzunligi limiti, token' },
      escalate: { type: 'boolean', description: 'HTML shell bo‘lsa brauzerda qayta o‘qish (default true)' },
      // The envelope is the point; the body is often already wanted elsewhere. Without this a caller that
      // only needs the id and the outline pays for the whole text twice.
      include_body: { type: 'boolean', description: 'Javobda markdown matni ham qaytarilsin (default true)' },
    },
    required: ['url'],
  },
  async handler(input) {
    const p = view(input);
    const escalate = typeof input.escalate === 'boolean' ? input.escalate : undefined;
    const includeBody = typeof input.include_body === 'boolean' ? input.include_body : true;
    const result = await fetchUrl(String(p.url), { maxTokens: Number(p.max_tokens ?? 8000), escalate });
    if (result.blocked) {
      const excerpt = result.markdown.replace(/\s+/g, ' ').slice(0, 220);
      return fail(
        `Blok sahifasi (HTTP ${result.status}, ${result.blocked.kind}: ${result.blocked.marker}). Hujjat o‘rni rad javob qaytdi.\n` +
          `Nima qilish kerak: ${result.blocked.hint}\n` +
          `Host aytgani: ${excerpt}`,
      );
    }
    const document = buildDocument(result);
    // The envelope is coordinates and provenance; the body is attached only when asked for, so a caller
    // routing on ids and headings does not pay for the text twice.
    return jsonBlock(
      'Hujjat: ' + document.document_id,
      includeBody ? { ...document, markdown: result.markdown } : document,
    );
  },
});
