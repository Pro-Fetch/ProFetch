import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { strOrEmpty, view } from '../../core/input.js';
import { fetchUrl } from '../../core/fetcher.js';
import { MAX_STORED_BYTES, diffLines, getReceipt } from '../../core/evidence-store.js';

/**
 * pro_evidence_diff — show what moved, not only that something did.
 *
 * `pro_evidence_check` raises the alarm; this is the investigation. The receipt keeps the canonical
 * material up to a bounded size, so a real line diff is possible — and when the document was larger than
 * that cap the answer says so instead of pretending a partial copy is the whole page.
 */
export default defineTool({
  name: 'pro_evidence_diff',
  description:
    'Line-by-line drift against a sealed receipt: added, removed and untouched counts plus the first ' +
    'changed lines. Without content the live source is fetched and compared with what was sealed.',
  category: 'evidence',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Receipt id' },
      content: { type: 'string', description: 'Sealangan matn bilan solishtiriladigan yangi matn' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  async handler(input) {
    const p = view(input);
    const id = strOrEmpty(p, 'id');
    const receipt = getReceipt(id);
    if (!receipt) return fail(`Receipt topilmadi: ${id}`);
    if (!receipt.text) {
      return fail(`Receipt ${id} matnni saqlamaydi (eski seal yoki bo‘sh hujjat) — diff uchun material kerak.`);
    }
    let content = strOrEmpty(p, 'content');
    let compared = 'provided';
    if (!content) {
      const doc = await fetchUrl(receipt.url, { useCache: false });
      if (doc.blocked) {
        return fail(`Diff olinmadi: ${receipt.url} hozir blok sahifasida (${doc.blocked.kind}).`);
      }
      content = doc.markdown;
      compared = 'fetched live';
    }
    const diff = diffLines(receipt.text, content);
    return jsonBlock(diff.changed ? '# Siljish bor' : '# Qatorlar bir xil', {
      id,
      url: receipt.url,
      sealed_at: receipt.sealed_at,
      compared_with: compared,
      sealed_copy_bytes: Buffer.byteLength(receipt.text, 'utf8'),
      copy_is_full: receipt.stored,
      added: diff.added,
      removed: diff.removed,
      unchanged: diff.unchanged,
      changed: diff.changed,
      sample: diff.sample,
      ...(receipt.stored
        ? {}
        : {
            note: `Seal ${MAX_STORED_BYTES} baytdan katta hujjatning boshini saqlagan: diff ko‘ringan qismda aniq, qolganini digest biladi.`,
          }),
    });
  },
});
