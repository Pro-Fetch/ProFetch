import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { strOrEmpty, view } from '../../core/input.js';
import { fetchUrl } from '../../core/fetcher.js';
import { digestOf, getReceipt, recordCheck } from '../../core/evidence-store.js';

/**
 * pro_evidence_check — is the claim still resting on the same ground?
 *
 * Three answers and they are not the same fact: `unchanged` (the digest matches), `changed` (the source
 * moved, with the line counts), and `unreachable` (we could not look — including the case where the host
 * now answers a challenge page, which is a source going dark, not a content edit). A tool that lumps
 * those together teaches people to distrust the verdict.
 */
export default defineTool({
  name: 'pro_evidence_check',
  description:
    'Re-check a sealed receipt: fetch the source again (or take the material you pass) and report ' +
    'unchanged, changed with line counts, or unreachable with the reason the look failed.',
  category: 'evidence',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'pro_evidence_seal qaytargan receipt id' },
      content: { type: 'string', description: 'Qayta tekshiriladigan matn — berilsa tarmoqqa chiqilmaydi' },
      url: { type: 'string', description: 'Boshqa manzildan tekshirish (default — receipt’dagi url)' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  async handler(input) {
    const p = view(input);
    const id = strOrEmpty(p, 'id');
    const receipt = getReceipt(id);
    if (!receipt) return fail(`Receipt topilmadi: ${id} — muddati o‘tgan yoki serverda bunday id bo‘lmagan.`);
    const url = strOrEmpty(p, 'url') || receipt.url;
    const given = strOrEmpty(p, 'content');
    const started = Date.now();
    let content = given;
    let unreachable = '';
    if (!content) {
      try {
        const doc = await fetchUrl(url, { useCache: false });
        if (doc.blocked) unreachable = `refused: ${doc.blocked.kind} (${doc.blocked.marker})`;
        else content = doc.markdown;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        unreachable = /SSRF|blok|ruxsat|taqiq/i.test(reason) ? `refused: ${reason}` : `error: ${reason}`;
      }
    }
    if (unreachable) {
      recordCheck(receipt, {
        at: new Date().toISOString(),
        verdict: unreachable,
        sha256: '',
        ms: Date.now() - started,
      });
      return jsonBlock('# Manbani ko‘rib bo‘lmadi', {
        id,
        url,
        verdict: unreachable,
        sealed_at: receipt.sealed_at,
        age_ms: Date.now() - Date.parse(receipt.sealed_at),
        note: 'Kontent o‘zgargani haqida hech narsa aytmaymiz — biz uni ko‘rmadik.',
      });
    }
    const digest = digestOf(content);
    const verdict = digest.sha256 === receipt.sha256 ? 'unchanged' : 'changed';
    recordCheck(receipt, {
      at: new Date().toISOString(),
      verdict,
      sha256: digest.sha256,
      ms: Date.now() - started,
    });
    return jsonBlock(verdict === 'unchanged' ? '# Dalil hali o‘zida' : '# Dalil siljigan', {
      id,
      url,
      verdict,
      sealed_at: receipt.sealed_at,
      sealed_sha256: receipt.sha256,
      now_sha256: digest.sha256,
      sealed_bytes: receipt.bytes,
      now_bytes: digest.bytes,
      sealed_words: receipt.words,
      now_words: digest.words,
      check_ms: Date.now() - started,
    });
  },
});
