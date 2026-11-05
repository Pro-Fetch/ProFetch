import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { strOrEmpty, view } from '../../core/input.js';
import { MAX_STORED_BYTES, getReceipt, listReceipts } from '../../core/evidence-store.js';

/**
 * pro_evidence_export — the appendix, ready to paste.
 *
 * Markdown for a report or a README, JSON for a machine that will verify it later. The quote is the
 * material the receipt actually holds, and when the document was larger than the store cap the export
 * says so rather than presenting a truncated passage as the whole source.
 */
export default defineTool({
  name: 'pro_evidence_export',
  description:
    'Render one receipt, or the whole held set, as a citation block: address, seal time, SHA-256, counts, ' +
    'check history and the stored excerpt. format: markdown or json.',
  category: 'evidence',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Bitta receipt id' },
      format: { type: 'string', description: 'markdown (default) yoki json' },
    },
    required: [],
    additionalProperties: false,
  },
  async handler(input) {
    const p = view(input);
    const id = strOrEmpty(p, 'id');
    const format = strOrEmpty(p, 'format') || 'markdown';
    const receipts = id ? [getReceipt(id)].filter((r): r is NonNullable<typeof r> => Boolean(r)) : listReceipts(50);
    if (receipts.length === 0) return fail(id ? `Receipt topilmadi: ${id}` : 'Saqlangan receipt yo‘q.');
    if (format === 'json') return jsonBlock('# Receipt eksport', { format, receipts });

    const blocks = receipts.map((receipt) => {
      const quote = receipt.text ? receipt.text.slice(0, 1200) : '';
      return [
        `### ${receipt.label || receipt.url}`,
        '',
        `- manba: ${receipt.url}`,
        `- seal: ${receipt.sealed_at}`,
        `- sha256: \`${receipt.sha256}\``,
        `- hajm: ${receipt.bytes} bayt · ${receipt.lines} qator · ${receipt.words} so‘z`,
        `- tekshiruvlar: ${receipt.checks.length}${
          receipt.checks.length ? ` · oxirgisi ${receipt.checks[receipt.checks.length - 1].verdict}` : ''
        }`,
        quote
          ? `\n> ${quote.replace(/\n/g, '\n> ')}${receipt.stored ? '' : `\n\n_(nusxa ${MAX_STORED_BYTES} bayt bilan cheklangan)_`}`
          : '',
      ]
        .filter(Boolean)
        .join('\n');
    });
    return jsonBlock('# Dalil ilovasi', { format, count: receipts.length, markdown: blocks.join('\n\n---\n\n') });
  },
});
