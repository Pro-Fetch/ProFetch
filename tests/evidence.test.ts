import { describe, expect, it, beforeAll } from 'vitest';
import '../src/loader.js';
import { dispatch } from '../src/core/tool.js';
import { getReceipt } from '../src/core/evidence-store.js';
import { exposedTools } from '../src/http/exposure.js';
import { hostReachable, skipIfUnreachable } from './helpers/liveGate.js';
import type { ToolResult } from '../src/core/types.js';

/**
 * Evidence: a receipt for what a source said, and an honest answer when it stops saying it.
 *
 * The offline cases pass material directly, so a slow network cannot change a verdict. The one case that
 * fetches is guarded by reachability and declares its skip, because a receipt test that fails on a cable
 * is not measuring the receipt.
 */

const textOf = (r: ToolResult): string => (r.content ?? []).map((c) => c.text ?? '').join('\n');
const payload = (r: ToolResult): Record<string, any> => {
  const m = /```json\n([\s\S]*?)\n```/.exec(textOf(r));
  return m ? JSON.parse(m[1]) : {};
};

const DOC =
  'HaluMem: Evaluating Hallucinations in Memory Systems of Agents\nMemory systems enable long-term learning.\nEvaluations remain end-to-end question.';
const URL = 'https://arxiv.org/abs/2511.03506';

beforeAll(() => {
  process.env.PRO_FETCH_PROFILE = 'full';
});

describe('the digest commits to the document, not to how it was carried', () => {
  it('seals a receipt with counts and a content-addressed id', async () => {
    const receipt = payload(
      await dispatch('pro_evidence_seal', { url: URL, content: DOC, kind: 'text', caption: 'abstract' }),
    );
    expect(receipt.id).toBe('arxiv.org-' + receipt.sha256.slice(0, 12));
    expect(receipt.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.words).toBeGreaterThan(10);
    expect(receipt.stored).toBe(true);
    expect(receipt.source).toBe('provided');
  });

  it('gives the same digest for CRLF and trailing-space variants of one document', async () => {
    const a = payload(
      await dispatch('pro_evidence_seal', { url: 'https://a.example/x', content: 'bir\nikki   \nuch\n' }),
    );
    const b = payload(
      await dispatch('pro_evidence_seal', { url: 'https://a.example/x', content: 'bir\r\nikki\r\nuch' }),
    );
    expect(b.sha256).toBe(a.sha256);
    expect(b.id).toBe(a.id);
  });

  it('refuses to seal a block page as if it were the source', async () => {
    const reachable = await hostReachable('https://www.researchgate.net/');
    if (!reachable) return;
    const result = await dispatch('pro_evidence_seal', { url: 'https://www.researchgate.net/' });
    if (skipIfUnreachable(undefined, textOf(result), 'researchgate.net unreachable')) return;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('blok sahifasi');
  }, 30_000);
});

describe('a check reports drift, or reports that it could not look', () => {
  it('says unchanged when the material still matches', async () => {
    const sealed = payload(await dispatch('pro_evidence_seal', { url: 'https://b.example/y', content: DOC }));
    const check = payload(await dispatch('pro_evidence_check', { id: sealed.id, content: DOC }));
    expect(check.verdict).toBe('unchanged');
    expect(check.now_sha256).toBe(sealed.sha256);
    expect(getReceipt(sealed.id)?.checks.length).toBe(1);
  });

  it('says changed with both digests when the source moved', async () => {
    const sealed = payload(await dispatch('pro_evidence_seal', { url: 'https://c.example/z', content: DOC }));
    const check = payload(
      await dispatch('pro_evidence_check', {
        id: sealed.id,
        content: DOC.replace('end-to-end question.', 'retrieval-focused.'),
      }),
    );
    expect(check.verdict).toBe('changed');
    expect(check.now_sha256).not.toBe(check.sealed_sha256);
  });

  it('refuses to claim a change it did not see', async () => {
    const sealed = payload(await dispatch('pro_evidence_seal', { url: 'https://d.example/w', content: DOC }));
    const missing = await dispatch('pro_evidence_check', { id: 'yoq-bunday-id' });
    expect(missing.isError).toBe(true);
    const unreachable = payload(
      await dispatch('pro_evidence_check', { id: sealed.id, url: 'http://169.254.169.254/' }),
    );
    expect(unreachable.verdict).toContain('refused');
    expect(unreachable.note).toContain('ko‘rmadik');
  });
});

describe('the diff shows what moved', () => {
  it('counts added, removed and untouched lines', async () => {
    const sealed = payload(await dispatch('pro_evidence_seal', { url: 'https://e.example/v', content: DOC }));
    const diff = payload(
      await dispatch('pro_evidence_diff', {
        id: sealed.id,
        content: DOC.replace('Memory systems enable long-term learning.', 'Memory systems enable continual learning.'),
      }),
    );
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.unchanged).toBe(2);
    expect(diff.sample.join('\n')).toMatch(/^[-+] /);
  });

  it('says when the stored copy is only part of the document', async () => {
    const big = 'qator '.repeat(20_000);
    const sealed = payload(await dispatch('pro_evidence_seal', { url: 'https://f.example/u', content: big }));
    expect(sealed.stored).toBe(false);
    expect(sealed.bytes).toBeGreaterThan(65_536);
    const diff = payload(await dispatch('pro_evidence_diff', { id: sealed.id, content: big + 'qo‘shiq' }));
    expect(diff.copy_is_full).toBe(false);
    expect(diff.note).toContain('digest');
  });
});

describe('reseal, bundle and the appendix', () => {
  it('links a new receipt instead of overwriting the old commitment', async () => {
    const sealed = payload(await dispatch('pro_evidence_seal', { url: 'https://g.example/t', content: DOC }));
    const next = payload(
      await dispatch('pro_evidence_reseal', { id: sealed.id, content: DOC.replace('Hallucinations', 'Hallucination') }),
    );
    expect(next.previous_id).toBe(sealed.id);
    expect(next.new_id).not.toBe(sealed.id);
    expect(getReceipt(sealed.id)?.checks.at(-1)?.verdict).toBe('changed');
  });

  it('does not write a second receipt when nothing changed', async () => {
    const sealed = payload(await dispatch('pro_evidence_seal', { url: 'https://h.example/s', content: DOC }));
    const again = payload(await dispatch('pro_evidence_reseal', { id: sealed.id, content: DOC }));
    expect(again.verdict).toBe('unchanged');
    expect(again.new_id).toBeUndefined();
  });

  it('counts every verdict in a bundle, live or remembered', async () => {
    const a = payload(await dispatch('pro_evidence_seal', { url: 'https://i.example/r', content: DOC }));
    const b = payload(await dispatch('pro_evidence_seal', { url: 'https://j.example/q', content: DOC + ' ' }));
    await dispatch('pro_evidence_check', { id: a.id, content: DOC });
    const bundle = payload(await dispatch('pro_evidence_bundle', { ids: [a.id, b.id, 'yoq-bor-yoq'], verify: false }));
    expect(bundle.items.length).toBe(3);
    expect(bundle.summary.unchanged).toBe(1);
    expect(bundle.summary.never_checked).toBe(1);
    expect(bundle.summary.missing).toBe(1);
  });

  it('exports a citation block that quotes the sealed material', async () => {
    const sealed = payload(
      await dispatch('pro_evidence_seal', { url: 'https://k.example/p', content: DOC, caption: 'HaluMem' }),
    );
    const exported = payload(await dispatch('pro_evidence_export', { id: sealed.id, format: 'markdown' }));
    expect(exported.markdown).toContain(sealed.sha256);
    expect(exported.markdown).toContain('HaluMem');
    expect(exported.markdown).toContain('Memory systems enable long-term learning');
  });

  it('lists and counts what the store holds', async () => {
    await dispatch('pro_evidence_seal', { url: 'https://l.example/o', content: DOC });
    const list = payload(await dispatch('pro_evidence_list', { limit: 50, contains: 'l.example' }));
    expect(list.count).toBe(1);
    const stats = payload(await dispatch('pro_evidence_stats', {}));
    expect(stats.receipts).toBeGreaterThan(0);
    expect(stats.last_verdicts).toBeTruthy();
    expect(stats.store).toContain('LRU');
  });
});

describe('the receipts are sellable over the public door', () => {
  it('keeps every evidence tool reachable in the default webdata tier', () => {
    const webdata = exposedTools('webdata', 'full', false).filter((t) => t.category === 'evidence');
    expect(webdata.length).toBe(8);
    expect(webdata.map((t) => t.name)).toContain('pro_evidence_seal');
  });

  it('does not let a receipt tool reach a mutation', async () => {
    const result = await dispatch('pro_evidence_bundle', { ids: [], verify: false });
    expect(result.isError).toBe(true);
  });
});
