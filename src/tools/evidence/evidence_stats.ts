import { defineTool } from '../../core/tool.js';
import { jsonBlock } from '../../core/format.js';
import { listReceipts } from '../../core/evidence-store.js';

/**
 * pro_evidence_stats — how much of the archive still stands.
 *
 * Counts by last verdict, because the number a team acts on is "how many of my citations went stale",
 * not "how many rows are in the store". It also says plainly that the store is an in-memory LRU: a
 * receipt can be evicted, and an honest count is the difference between an archive and a cache.
 */
export default defineTool({
  name: 'pro_evidence_stats',
  description:
    'Summarise the evidence store: receipts held, bytes and words sealed, how many were re-checked, and ' +
    'the verdict counts of the last check (unchanged, changed, unreachable, never checked).',
  category: 'evidence',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  async handler() {
    const receipts = listReceipts(500);
    const verdicts: Record<string, number> = { never_checked: 0, unchanged: 0, changed: 0, unreachable: 0 };
    for (const receipt of receipts) {
      const last = receipt.checks[receipt.checks.length - 1];
      if (!last) {
        verdicts.never_checked++;
        continue;
      }
      if (last.verdict === 'unchanged') verdicts.unchanged++;
      else if (last.verdict === 'changed') verdicts.changed++;
      else verdicts.unreachable++;
    }
    const ages = receipts.map((r) => Date.now() - Date.parse(r.sealed_at));
    return jsonBlock('# Dalil xazinasi', {
      receipts: receipts.length,
      bytes_sealed: receipts.reduce((sum, r) => sum + r.bytes, 0),
      words_sealed: receipts.reduce((sum, r) => sum + r.words, 0),
      copies_held: receipts.filter((r) => r.stored).length,
      checks_recorded: receipts.reduce((sum, r) => sum + r.checks.length, 0),
      last_verdicts: verdicts,
      oldest_ms: ages.length ? Math.max(...ages) : 0,
      newest_ms: ages.length ? Math.min(...ages) : 0,
      store: 'cache LRU — muddati o‘tgan yoki siqib chiqarilgan receipt yo‘qoladi; bu arxiv emas',
    });
  },
});
