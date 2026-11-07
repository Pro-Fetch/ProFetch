import { describe, expect, it } from 'vitest';
import '../src/loader.js';
import { callTool } from '../src/router.js';
import { DEFAULT_WEIGHTS, duplicatesOf, parseDate, rankResults } from '../src/core/result-ranking.js';

/**
 * The ranking model, tested offline with a fixed clock.
 *
 * Every case here is a claim about *why* an order changed, because that is the only part of a ranker
 * anybody can audit. The weights are asserted as published numbers, not as tuned ones: there is no
 * labelled corpus in this repository, and pretending otherwise would be the costume, not the work.
 */

const NOW = Date.UTC(2026, 10, 6);
const DAY = 86_400_000;

function item(url: string, title: string, snippet: string, published_date?: string) {
  return { url, title, snippet, published_date };
}

describe('the three signals compute what the answer says they compute', () => {
  it('scores coverage as the share of query terms that appear', () => {
    const [best] = rankResults('sqlite wal checkpoint', [item('https://a.test/1', 'sqlite', 'wal checkpoint')], {
      nowMs: NOW,
    });
    // Three query terms, all three present: coverage 1.0, and the basis line says the count.
    expect(best.components.coverage).toBe(1);
    expect(best.basis.coverage).toBe('3/3 query term(s) appear in title+snippet+url');
  });

  it('makes freshness decay with a stated half-life, and stays neutral when no date exists', () => {
    const ranked = rankResults(
      'sqlite',
      [
        item('https://new.test/1', 'Write-ahead logging guide', 'x', new Date(NOW).toISOString()),
        item(
          'https://old.test/2',
          'Backup strategies for embedded databases',
          'y',
          new Date(NOW - 60 * DAY).toISOString(),
        ),
        item('https://nodate.test/3', 'Query planner internals explained', 'z'),
      ],
      { nowMs: NOW },
    );
    const byHost = Object.fromEntries(ranked.map((row) => [row.site, row.components.freshness]));
    expect(byHost['new.test']).toBe(1);
    expect(byHost['old.test']).toBeCloseTo(0.25, 2);
    expect(byHost['nodate.test']).toBe(0.5);
    expect(ranked.find((row) => row.site === 'nodate.test')?.basis.freshness).toMatch(/date unknown/);
  });

  it('does not fold two different pages that share a short title', () => {
    // The first version folded on title ratio alone, so two unrelated pages both titled "SQLite" — 100%
    // of their terms shared — collapsed into one and a real result disappeared. A ratio without substance
    // is not duplication; the test data above is what found it.
    const ranked = rankResults(
      'sqlite',
      [item('https://a.test/1', 'SQLite', 'x'), item('https://b.test/2', 'SQLite', 'y')],
      { nowMs: NOW },
    );
    expect(ranked.length).toBe(2);
  });

  it('keeps an empty crawl graph neutral instead of scoring every site zero as if judged', () => {
    const ranked = rankResults('sqlite', [item('https://a.test/1', 'sqlite', 'x')], {
      nowMs: NOW,
      authority: { byHost: {}, graph_empty: true },
    });
    expect(ranked[0].components.authority).toBe(0);
    expect(ranked[0].basis.authority).toMatch(/crawl graph is empty.*neutral/);
  });

  it('saturates authority at the stated cap so one hub cannot dominate everything', () => {
    const many = rankResults('sqlite', [item('https://hub.test/1', 'sqlite', 'x')], {
      nowMs: NOW,
      authority: { byHost: { 'hub.test': 5000 }, graph_empty: false },
    });
    expect(many[0].components.authority).toBe(1);
    expect(many[0].basis.authority).toMatch(/log-scaled, cap 50/);
  });

  it('applies the published weights, and the published weights are the ones in the answer', () => {
    expect(DEFAULT_WEIGHTS).toEqual({ coverage: 0.45, authority: 0.3, freshness: 0.25 });
    const sum = DEFAULT_WEIGHTS.coverage + DEFAULT_WEIGHTS.authority + DEFAULT_WEIGHTS.freshness;
    expect(sum).toBeCloseTo(1, 6);
  });
});

describe('near-duplicates are folded, and the folding is reported', () => {
  it('keeps one copy of a syndicated title and says which absorbed which', () => {
    const set = [
      item('https://a.test/wal', 'Write-Ahead Logging in SQLite', 'x'),
      item('https://mirror.test/wal', 'Write-Ahead Logging in SQLite', 'copy'),
      item('https://b.test/other', 'Vacuum and analyze', 'y'),
    ];
    const ranked = rankResults('sqlite wal', set, { nowMs: NOW });
    expect(ranked.length).toBe(2);
    expect(duplicatesOf(set)).toEqual({ 'https://a.test/wal': ['https://mirror.test/wal'] });
  });

  it('does not fold two different pages that share a common word', () => {
    const set = [
      item('https://a.test/1', 'SQLite WAL checkpointing', 'x'),
      item('https://b.test/2', 'SQLite query planner', 'y'),
    ];
    expect(rankResults('sqlite', set, { nowMs: NOW }).length).toBe(2);
  });
});

describe('dates are parsed or left unknown', () => {
  it.each([
    ['2026-11-01T00:00:00Z', Date.UTC(2026, 10, 1)],
    ['2026', Date.UTC(2026, 0, 1)],
    ['Thu, 06 Nov 2026 08:00:00 GMT', Date.UTC(2026, 10, 6, 8)],
  ])('%j -> a real timestamp', (text, expected) => {
    expect(parseDate(text)).toBe(expected);
  });

  it.each(['', 'some day', 'yesterday-ish'])('%j stays unknown', (text) => {
    expect(parseDate(text)).toBeUndefined();
  });
});

describe('the tool refuses to rank nothing', () => {
  it('asks for results or an engine instead of inventing an empty ranking', async () => {
    const result = await callTool('pro_fetch_rank_results', { query: 'sqlite' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/results bo‘sh va engine berilmagan/);
  });

  it('ranks a provided set and states its own limits in the answer', async () => {
    const result = await callTool('pro_fetch_rank_results', {
      query: 'sqlite wal checkpoint',
      results: [
        item('https://sqlite.org/wal', 'Write-Ahead Logging', 'wal checkpointing', new Date(NOW).toISOString()),
        item('https://x.test/1', 'Random page', 'nothing'),
      ],
      use_index: false,
    });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(/(\{[\s\S]*\})/.exec(textOf(result))![1]);
    expect(body.results[0].site).toBe('sqlite.org');
    expect(body.authority_basis).toMatch(/use_index: false/);
    expect(String(body.limits)).toMatch(/spam klassifikatori yo‘q/);
    expect(String(body.weights_note)).toMatch(/sozlangan emas/);
  });
});

function textOf(result: { content?: Array<{ type?: string; text?: string }> }): string {
  return (result.content ?? [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text ?? '')
    .join('\n');
}
