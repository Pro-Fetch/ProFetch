import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { strOrEmpty, view } from '../../core/input.js';
import { fetchUrl } from '../../core/fetcher.js';
import { digestOf, getReceipt, recordCheck, sealReceipt } from '../../core/evidence-store.js';

/**
 * pro_evidence_reseal — take a fresh commitment without erasing the old one.
 *
 * Receipt ids are content-addressed, so a document that changed cannot be "updated in place" without
 * lying about what the old id meant. Resealing writes a new receipt, links it to the previous one, and
 * records the drift as a check on the original. The history stays readable: this is what the source said
 * then, and this is what it says now.
 */
export default defineTool({
  name: 'pro_evidence_reseal',
  description:
    'Fetch the receipt source again and seal a new receipt for the current material, linked to the old ' +
    'one. Pass content to reseal from material you already hold.',
  category: 'evidence',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Asos receipt id' },
      content: { type: 'string', description: 'Yangi material — berilsa tarmoqqa chiqilmaydi' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  async handler(input) {
    const p = view(input);
    const id = strOrEmpty(p, 'id');
    const previous = getReceipt(id);
    if (!previous) return fail(`Receipt topilmadi: ${id}`);
    let content = strOrEmpty(p, 'content');
    if (!content) {
      const doc = await fetchUrl(previous.url, { useCache: false });
      if (doc.blocked) {
        return fail(
          `Reseal rad etildi: ${previous.url} blok sahifasida (${doc.blocked.kind}) — blokni dalil qilib bo‘lmaydi.`,
        );
      }
      content = doc.markdown;
    }
    const digest = digestOf(content);
    const same = digest.sha256 === previous.sha256;
    recordCheck(previous, {
      at: new Date().toISOString(),
      verdict: same ? 'unchanged' : 'changed',
      sha256: digest.sha256,
      ms: 0,
    });
    if (same) {
      return jsonBlock('# Hech narsa o‘zgarmagan', {
        id,
        verdict: 'unchanged',
        note: 'Yangi receipt yozilmadi — id kontentga bog‘liq.',
      });
    }
    const next = sealReceipt({ url: previous.url, content, kind: previous.kind, label: previous.label });
    return jsonBlock('# Qayta sealandi', {
      previous_id: id,
      previous_sha256: previous.sha256,
      new_id: next.id,
      new_sha256: next.sha256,
      sealed_at: next.sealed_at,
      words: { before: previous.words, now: next.words },
    });
  },
});
