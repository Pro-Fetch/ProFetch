import { describe, expect, it } from 'vitest';
import '../src/loader.js';
import { callTool } from '../src/router.js';
import {
  INTENT_MARKERS,
  classifyIntent,
  editDistance,
  nearestSuggestion,
  queryTerms,
} from '../src/core/query-understanding.js';
import { hostReachable } from './helpers/liveGate.js';
import { skipBlockWithout } from './helpers/env-guard.js';
import type { ToolResult } from '../src/core/types.js';

/**
 * Query understanding: the part of a search pipeline that happens before an index is asked.
 *
 * The classifier is a marker list, so the tests read the list itself rather than a hoped-for score: a
 * misclassification must be arguable by looking at the words, not by trusting a number. The spelling and
 * expansion halves come from a live endpoint, so they are gated and, when the endpoint answers with
 * nothing, the test checks that the answer *says* nothing was evaluated — a correction silently skipped
 * is the failure this file exists to catch.
 */

const FILE = 'tests/query-understanding.test.ts';
const online = await hostReachable('https://suggestqueries.google.com/complete/search?client=firefox&q=test');
if (!online) skipBlockWithout(FILE, 'network', 'Google autocomplete endpointiga chiqish yo‘q', false);

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

describe('intent is decided by a list anyone can read', () => {
  it.each([
    ['buy cheap sqlite book', 'buy'],
    ['breaking news about the reservoir', 'news'],
    ['TypeError: cannot read property of undefined', 'code'],
    ['what is write-ahead logging', 'definition'],
    ['how to checkpoint a wal file', 'howto'],
    ['sqlite wal checkpoint', 'informational'],
    ['qanday sqlite wal checkpoint qilish', 'howto'],
    ["'nima bu'", 'definition'],
  ])('%j -> %j', (query, intent) => {
    const result = classifyIntent(query);
    expect(result.intent).toBe(intent);
    if (intent === 'informational') expect(result.marker).toBe('');
    else expect(String(INTENT_MARKERS[intent as keyof typeof INTENT_MARKERS]).toLowerCase()).toContain(result.marker);
  });

  it('names the marker it matched, so a wrong call can be argued with', () => {
    const result = classifyIntent('price of a notebook');
    expect(result.intent).toBe('buy');
    expect(result.marker).toBe('price');
    expect(result.basis).toContain('price');
  });

  it('prefers money over instructions when both match, and says so', () => {
    // Documented in classifyIntent: a query that is both a purchase and a how-to is answered as a
    // purchase, because that is what changes which index gets asked.
    expect(classifyIntent('how to buy a cheap laptop').intent).toBe('buy');
  });
});

describe('terms and distance', () => {
  it('drops stopwords and keeps the words that carry the question', () => {
    expect(queryTerms('the best way to learn about sqlite')).toEqual(['best', 'way', 'learn', 'sqlite']);
    expect(queryTerms('nima uchun bu kerak')).toContain('kerak');
  });

  it('measures distance the way it says it does', () => {
    expect(editDistance('sqlite', 'sqllite')).toBe(1);
    expect(editDistance('', 'abc')).toBe(3);
  });

  it('refuses a suggestion that dropped a word of the query', () => {
    // Autocomplete returns continuations. "sqlite wal checkpoint" is not a correction of
    // "sqlite wal checkpont" in the sense that matters — it answers a longer question.
    const picked = nearestSuggestion('sqlite wal', ['sqlite wal checkpoint d3', 'sqlite wal']);
    expect(picked.suggested).toBe('sqlite wal');
    expect(picked.distance).toBe(0);
  });

  it('picks the closest real correction', () => {
    const picked = nearestSuggestion('sqllite wal', ['sqlite wal', 'sqllite wal tutorial']);
    expect(picked.suggested).toBe('sqlite wal');
    expect(picked.distance).toBe(1);
  });
});

describe.skipIf(!online)('live: the answer says how much it actually checked', () => {
  it('reports the language basis as the detector left it, not as a guess', async () => {
    const body = payload(await callTool('pro_query_understand', { query: 'how to checkpoint a wal file' }));
    expect(body.ok).toBe(true);
    expect(body.language.code).toBeTruthy();
    expect(body.language.basis).toContain('pro_fetch_language_detect');
    // The detector answers with scripts and likely_languages; a query of a few words often does not
    // reach a language. That must appear as `und` with the reason, not as a confident guess.
    if (body.language.code === 'und') expect(body.language.basis).toMatch(/bo‘sh|refused/);
    expect(Array.isArray(body.language.scripts) || body.language.code !== 'und').toBe(true);
  });

  it('with network:false says the spelling check was not done', async () => {
    const body = payload(await callTool('pro_query_understand', { query: 'sqllite wal', network: false }));
    expect(body.spelling.suggested).toBe('sqllite wal');
    expect(body.spelling.changed).toBe(false);
    expect(body.spelling.source).toMatch(/network: false/);
    expect(body.expansion).toEqual([]);
    expect(body.took_ms).toBeLessThan(200);
  });

  it('with network on, states whether any suggestion was evaluated at all', async () => {
    const body = payload(await callTool('pro_query_understand', { query: 'sqllite wal checkpont' }));
    expect(typeof body.spelling.suggested).toBe('string');
    expect(body.spelling.source).toMatch(/taklifdan eng yaqini|taklif qaytmadi|tarmoq javob bermadi/);
    if (/taklif qaytmadi/.test(body.spelling.source)) expect(body.spelling.changed).toBe(false);
  });

  it('tells the caller what to do with the classification', async () => {
    const body = payload(await callTool('pro_query_understand', { query: 'breaking news sqlite' }));
    expect(body.intent.class).toBe('news');
    expect(String(body.how_to_use)).toContain('pro_fetch_news_search');
  });
});
