import { defineTool } from '../../core/tool.js';
import { jsonBlock } from '../../core/format.js';
import { num, strOrEmpty, view } from '../../core/input.js';
import { listReceipts } from '../../core/evidence-store.js';

/**
 * pro_evidence_list — what this server has committed to.
 *
 * Newest first, optionally narrowed by a substring of the address or label. Counts only, no bodies: the
 * material is read through `pro_evidence_export`.
 */
export default defineTool({
  name: 'pro_evidence_list',
  description: 'List the sealed receipts this server currently holds: id, address, kind, seal time, size, checks.',
  category: 'evidence',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Nechta receipt (default 50, eng ko‘p 500)' },
      contains: { type: 'string', description: 'Manzil yoki nomda bu satr bo‘lganlari' },
    },
    required: [],
    additionalProperties: false,
  },
  async handler(input) {
    const p = view(input);
    const limit = num(p, 'limit', 50);
    const contains = strOrEmpty(p, 'contains');
    const receipts = listReceipts(limit, contains);
    return jsonBlock('# Receiptlar', {
      count: receipts.length,
      held_in: 'cache (LRU — muddati o‘tgan yoki siqib chiqarilgan receipt yo‘qoladi)',
      receipts: receipts.map((r) => ({
        id: r.id,
        url: r.url,
        kind: r.kind,
        label: r.label,
        sealed_at: r.sealed_at,
        bytes: r.bytes,
        words: r.words,
        checks: r.checks.length,
        last_verdict: r.checks.length ? r.checks[r.checks.length - 1].verdict : '',
      })),
    });
  },
});
