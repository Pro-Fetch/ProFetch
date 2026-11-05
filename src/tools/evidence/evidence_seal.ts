import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { num, strOrEmpty, view } from '../../core/input.js';
import { fetchUrl } from '../../core/fetcher.js';
import { sealReceipt } from '../../core/evidence-store.js';

/**
 * pro_evidence_seal — commit to what a source said at a moment.
 *
 * Either pass the material (`content`, e.g. text you already hold) or let the server fetch it. The
 * digest is taken over the canonicalised bytes, so the receipt is about the document, not about how this
 * machine happened to receive it.
 */
export default defineTool({
  name: 'pro_evidence_seal',
  description:
    'Seal a receipt for what a source contained right now: SHA-256 of the canonical text, byte, line and ' +
    'word counts, the address and the timestamp. Pass content to seal material you already hold.',
  category: 'evidence',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Manzil — receiptga yoziladi va content bo‘lmasa shu yerdan olinadi' },
      content: { type: 'string', description: 'Qo‘lda berilgan matn (keshlangan hujjat, PDFdan olingan va h.k.)' },
      kind: { type: 'string', description: 'Material turi: web, pdf, text, data (default web)' },
      caption: { type: 'string', description: 'Inson o‘qiydigan nom — hisobot satrlari uchun' },
      ttl_ms: { type: 'number', description: 'Receipt necha ms saqlanadi (default 30 kun)' },
    },
    required: ['url'],
    additionalProperties: false,
  },
  async handler(input) {
    const p = view(input);
    const url = strOrEmpty(p, 'url');
    if (!url) return fail('url kerak — receipt kimga tegishli ekanini bilishimiz uchun.');
    const given = strOrEmpty(p, 'content');
    let content = given;
    let fetched = false;
    if (!content) {
      const doc = await fetchUrl(url);
      if (doc.blocked) {
        return fail(
          `Seal rad etildi: ${url} blok sahifasini qaytardi (HTTP ${doc.status}, ${doc.blocked.kind}). Blokni seal qilish — dalil emas.`,
        );
      }
      content = doc.markdown;
      fetched = true;
    }
    const ttlRaw = num(p, 'ttl_ms', 0);
    const receipt = sealReceipt({
      url,
      content,
      kind: strOrEmpty(p, 'kind'),
      label: strOrEmpty(p, 'caption'),
      ttlMs: ttlRaw > 0 ? ttlRaw : undefined,
    });
    const { text: storedText, ...fields } = receipt;
    return jsonBlock('# Sealindi', {
      ...fields,
      excerpt: storedText.slice(0, 300),
      source: fetched ? 'fetched' : 'provided',
      digest_of: 'canonical text',
    });
  },
});
