import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { bool, view } from '../../core/input.js';
import { fetchUrl } from '../../core/fetcher.js';
import { digestOf, getReceipt, recordCheck } from '../../core/evidence-store.js';

/**
 * pro_evidence_bundle — one report over many receipts.
 *
 * A citation appendix is not one link, it is forty, and nobody re-checks forty by hand. This walks the
 * list, re-fetches each address when asked, and returns a per-item verdict with a summary — the shape a
 * reviewer reads first. Sequential on purpose: a bundle hammering forty hosts at once is how a small
 * server gets itself rate-limited everywhere at the same moment.
 */
export default defineTool({
  name: 'pro_evidence_bundle',
  description:
    'Check many receipts in one call and produce a report: per-item verdict (unchanged, changed, ' +
    'unreachable, missing), measured time each took, and summary counts.',
  category: 'evidence',
  inputSchema: {
    type: 'object',
    properties: {
      ids: {
        type: 'array',
        description: 'Receipt id ro‘yxati (eng ko‘p 20 ta)',
        items: { type: 'string' },
      },
      verify: { type: 'boolean', description: 'true — har birini jonli qayta tekshir; false — faqat saqlangan holat' },
    },
    required: ['ids'],
    additionalProperties: false,
  },
  async handler(input) {
    const p = view(input);
    const rawIds = input.ids;
    if (!Array.isArray(rawIds) || rawIds.length === 0) return fail('ids kerak — massiv ko‘rinishida, kamida bitta id.');
    const list = rawIds.slice(0, 20).map((value) => String(value));
    const verify = bool(p, 'verify', true);
    const items: Array<Record<string, unknown>> = [];
    const summary: Record<string, number> = { unchanged: 0, changed: 0, unreachable: 0, missing: 0 };

    for (const id of list) {
      const receipt = getReceipt(id);
      if (!receipt) {
        summary.missing++;
        items.push({ id, verdict: 'missing', note: 'receipt yo‘q — muddati o‘tgan yoki id xato' });
        continue;
      }
      if (!verify) {
        const last = receipt.checks[receipt.checks.length - 1];
        const verdict = last ? last.verdict : 'never_checked';
        summary[verdict] = (summary[verdict] ?? 0) + 1;
        items.push({ id, url: receipt.url, label: receipt.label, sealed_at: receipt.sealed_at, verdict });
        continue;
      }
      const started = Date.now();
      try {
        const doc = await fetchUrl(receipt.url, { useCache: false });
        if (doc.blocked) {
          summary.unreachable++;
          recordCheck(receipt, {
            at: new Date().toISOString(),
            verdict: `refused: ${doc.blocked.kind}`,
            sha256: '',
            ms: Date.now() - started,
          });
          items.push({
            id,
            url: receipt.url,
            verdict: 'unreachable',
            reason: doc.blocked.kind,
            ms: Date.now() - started,
          });
          continue;
        }
        const digest = digestOf(doc.markdown);
        const verdict = digest.sha256 === receipt.sha256 ? 'unchanged' : 'changed';
        summary[verdict]++;
        recordCheck(receipt, {
          at: new Date().toISOString(),
          verdict,
          sha256: digest.sha256,
          ms: Date.now() - started,
        });
        items.push({
          id,
          url: receipt.url,
          label: receipt.label,
          verdict,
          sealed_words: receipt.words,
          now_words: digest.words,
          ms: Date.now() - started,
        });
      } catch (error) {
        summary.unreachable++;
        const reason = error instanceof Error ? error.message : String(error);
        recordCheck(receipt, {
          at: new Date().toISOString(),
          verdict: `error: ${reason}`,
          sha256: '',
          ms: Date.now() - started,
        });
        items.push({ id, url: receipt.url, verdict: 'unreachable', reason, ms: Date.now() - started });
      }
    }
    return jsonBlock('# Dalil hisoboti', {
      requested: list.length,
      verified: verify,
      summary,
      items,
      ...(rawIds.length > 20 ? { note: '20 tadan ortiq idlar qisqartirildi' } : {}),
    });
  },
});
