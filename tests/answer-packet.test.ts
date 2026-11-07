import { describe, expect, it } from 'vitest';
import '../src/loader.js';
import { callTool } from '../src/router.js';
import { bestWindow } from '../src/tools/search/answer_packet.js';
import { digestOf } from '../src/core/evidence-store.js';
import { hostReachable } from './helpers/liveGate.js';
import { skipBlockWithout } from './helpers/env-guard.js';
import type { ToolResult } from '../src/core/types.js';

/**
 * The answer packet: fragments of page body text, each with the coordinates it came from.
 *
 * The windowing is tested offline against a body written here, because the property that matters — a
 * fragment is a passage somebody wrote, not a slice through a word — is visible in the string itself.
 * The live half checks that provenance is real: offsets that point back at the same text, a digest that
 * recomputes, and a failure that is named rather than dropped.
 */

const FILE = 'tests/answer-packet.test.ts';
const online = await hostReachable('https://sqlite.org/wal.html');
if (!online) skipBlockWithout(FILE, 'network', 'sqlite.org sahifasiga chiqish yo‘q', false);

const BODY = [
  'Introduction to the library and its history.',
  '',
  'The checkpoint operation moves frames from the write-ahead log back into the database file. It runs automatically when the log reaches a threshold, and can be requested with PRAGMA wal_checkpoint.',
  '',
  'Modes are truncate and restart. Truncate returns the log file to zero bytes; restart keeps the file but resets the index.',
  '',
  'Appendix: unrelated notes about packaging and releases.',
].join('\n');

function textOf(result: ToolResult): string {
  return (result.content ?? [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text ?? '')
    .join('\n');
}
function payload(result: ToolResult): Record<string, any> {
  const match = /(\{[\s\S]*\})/.exec(textOf(result));
  return match ? JSON.parse(match[1]) : {};
}

describe('a fragment is a passage, not a slice', () => {
  it('finds the paragraph that carries the terms', () => {
    const window = bestWindow(BODY, 'wal checkpoint modes', 300);
    expect(window).toBeTruthy();
    expect(window!.text).toMatch(/checkpoint/i);
    expect(window!.text.startsWith('Introduction')).toBe(false);
  });

  it('reports offsets that point back at the same text', () => {
    const window = bestWindow(BODY, 'truncate the log file', 240)!;
    expect(BODY.slice(window.start, window.end).trim().startsWith(window.text.slice(0, 24))).toBe(true);
  });

  it('never cuts through a word when a boundary is out of reach', () => {
    const long = ['alpha '.repeat(400), 'beta wal checkpoint gamma'].join('');
    const window = bestWindow(long, 'wal checkpoint', 120)!;
    expect(window.text).not.toMatch(/^\w{1,3}\b\S*$/);
    expect(window.text.trim().split(/\s+/).length).toBeGreaterThan(3);
    expect(window.text.slice(-1)).not.toBe(' ');
  });

  it('returns nothing rather than a fragment with no term in it', () => {
    expect(bestWindow(BODY, 'quantum tunnelling', 200)).toBeUndefined();
    expect(bestWindow('', 'checkpoint', 200)).toBeUndefined();
    expect(bestWindow(BODY, '   ', 200)).toBeUndefined();
  });
});

describe.skipIf(!online)('live: the packet carries provenance that checks out', () => {
  it('returns a fragment whose digest and offsets recompute from its own source', async () => {
    const result = await callTool('pro_fetch_answer_packet', {
      query: 'sqlite wal checkpoint modes',
      engine: 'hackernews',
      sources: 1,
      max_fragment_chars: 500,
    });
    expect(result.isError, textOf(result)).toBeFalsy();
    const body = payload(result);
    expect(body.schema).toBe('pro-fetch.answer/1');
    expect(body.sources_requested).toBe(1);
    if (body.count === 0) {
      // Nothing readable is a legitimate outcome, and it must arrive named — never as an empty list
      // that looks like "the web has nothing".
      expect(body.empty).toBe(true);
      expect(body.failures.length).toBeGreaterThan(0);
      return;
    }
    const fragment = body.fragments[0];
    expect(fragment.source.url).toMatch(/^https?:\/\//);
    expect(fragment.source.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(digestOf(fragment.text).sha256).toBe(fragment.source.sha256);
    expect(fragment.source.offset_chars[1]).toBeGreaterThan(fragment.source.offset_chars[0]);
    expect(fragment.source.read_at_ms).toBeGreaterThan(0);
    expect(typeof fragment.source.cached).toBe('boolean');
    expect(String(body.limits)).toMatch(/qisqartirilmagan/);
  });

  it('names a source it could not read instead of silently dropping it', async () => {
    const body = payload(
      await callTool('pro_fetch_answer_packet', {
        query: 'researchgate paper full text',
        engine: 'hackernews',
        sources: 1,
      }),
    );
    // Whatever happened, the accounting must close: considered = fragments + failures for the hosts tried.
    expect(body.count + body.failures.length).toBeLessThanOrEqual(body.sources_considered);
    for (const failure of body.failures) expect(String(failure.reason).length).toBeGreaterThan(8);
  });

  it('refuses a query with nothing in it', async () => {
    const result = await callTool('pro_fetch_answer_packet', { query: '  ' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/majburiy argumentlar|query kerak/);
  });
});
