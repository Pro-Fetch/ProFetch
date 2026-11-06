import { describe, expect, it } from 'vitest';
import '../src/loader.js';
import { callTool } from '../src/router.js';
import { SEARCH_ENGINES, engineById, engineStatuses, searchAcross, searchWeb } from '../src/core/search-providers.js';
import { getCredential } from '../src/core/credentials.js';
import { hostReachable } from './helpers/liveGate.js';
import { skipBlockWithout } from './helpers/env-guard.js';
import type { ToolResult } from '../src/core/types.js';

/**
 * The search engine registry.
 *
 * The server used to know three engines, and the answer therefore depended on the mood of one keyless
 * scraper. Measured on 2026-11-06 from this machine: `html.duckduckgo.com` answered **HTTP 202 with zero
 * results** — neither an error nor an answer — while 14 keyless engines served the same query normally. The
 * offline half of this file pins the registry's own invariants; the live half pins the behaviour that made
 * the change worth making.
 *
 * Credentialed engines are tested offline on purpose. `configured()` is what a caller can verify without
 * spending somebody's quota, and the evidence for each endpoint is recorded in the registry itself — the
 * provider's own refusal, quoted, from the probe that proved the URL, the verb and the header.
 */

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

const keyless = SEARCH_ENGINES.filter((engine) => engine.credentials.length === 0 && engine.settings.length === 0);
const reachable = await hostReachable('https://hn.algolia.com/api/v1/search?query=sqlite');
if (!reachable)
  skipBlockWithout('tests/search-engines.test.ts', 'network', 'hech bir qidiruv endpointiga chiqish yo‘q', false);

describe('the engine registry is a contract, not a list', () => {
  it('has one row per id, and every row says what it is', () => {
    const ids = SEARCH_ENGINES.map((engine) => engine.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const engine of SEARCH_ENGINES) {
      expect(engine.label, `${engine.id} has no label`).toBeTruthy();
      expect(engine.kind, `${engine.id} has no kind`).toBeTruthy();
      // An engine that claims to work without saying what proved it is a claim, not an integration.
      expect(engine.evidence.length, `${engine.id} records no evidence`).toBeGreaterThan(20);
    }
  });

  it('is reachable by id and by label, case-insensitively', () => {
    expect(engineById('Tavily')?.id).toBe('tavily');
    expect(engineById('  google-cse ')?.label).toBe('Google Custom Search');
    expect(engineById('nope')).toBeUndefined();
  });

  it('names every credential an engine waits for, and never its value', () => {
    const statuses = engineStatuses();
    expect(statuses.length).toBe(SEARCH_ENGINES.length);
    const serialized = JSON.stringify(statuses);
    for (const engine of SEARCH_ENGINES) {
      for (const variable of [...engine.credentials, ...engine.settings]) {
        expect(serialized).toContain(variable);
      }
    }
    // A key value must never appear in a listing, configured or not.
    for (const variable of ['SERPER_API_KEY', 'TAVILY_API_KEY', 'EXA_API_KEY', 'SEARCH_API_KEY']) {
      const value = getCredential(variable);
      if (value) expect(serialized).not.toContain(value);
    }
  });

  it('reports credentialed engines as unusable without a key, and usable with one', () => {
    const tavily = engineById('tavily')!;
    const previous = process.env.TAVILY_API_KEY;
    expect(tavily.configured()).toBe(Boolean(previous));
    process.env.TAVILY_API_KEY = 'test-value-not-a-real-key';
    try {
      expect(tavily.configured()).toBe(true);
      // Only the gate is asserted here. Firing nine bogus keys at other people's paid APIs on every CI
      // run would cost them traffic and prove nothing about this code.
    } finally {
      if (previous === undefined) delete process.env.TAVILY_API_KEY;
      else process.env.TAVILY_API_KEY = previous;
    }
  });

  it('treats an engine that needs an operator URL as unusable until it is set', () => {
    const searxng = engineById('searxng')!;
    const previous = process.env.SEARXNG_URL;
    delete process.env.SEARXNG_URL;
    try {
      expect(searxng.configured()).toBe(false);
      process.env.SEARXNG_URL = 'https://searx.example.org';
      expect(searxng.configured()).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.SEARXNG_URL;
      else process.env.SEARXNG_URL = previous;
    }
  });
});

describe.skipIf(!reachable)('live: an empty engine is not an empty web', () => {
  it('carries on past an engine that answered with nothing', async () => {
    // The exact failure the registry exists for: HTTP 202 and no results is not an error, so a chain that
    // stops at the first non-throwing engine reports "no results" from one scraper's mood.
    const answer = await searchWeb('paperless note taking app 2026', 6);
    expect(answer.results.length).toBeGreaterThan(0);
    const empties = answer.failedProviders.filter((item) => item.reason === 'empty_answer');
    if (empties.length > 0) expect(answer.provider).toContain('fallback');
    expect(answer.configured.length).toBeGreaterThan(5);
  });

  it('asks every usable engine in parallel and merges what comes back', async () => {
    const merged = await searchAcross('sqlite wal checkpoint', 6);
    expect(merged.results.length).toBeGreaterThan(0);
    // Every engine in the registry is accounted for exactly once: it either ran and reported an outcome, or
    // it was skipped with the reason. That is what a caller needs to tell "the web has nothing" apart from
    // "this server has no keys" — the assertion above compared the ran-count with itself plus the skipped
    // count, which could only fail, and it was the test that caught the mistake.
    expect(merged.perEngine.length + merged.enginesSkipped.length).toBe(SEARCH_ENGINES.length);
    expect(merged.enginesUsed.length).toBeGreaterThan(1);
    // Deduplication is the point of merging: the same page found by two engines must not fill the list.
    const urls = merged.results.map((item) => item.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it.each([
    ['hackernews', 'sqlite wal checkpoint'],
    ['wikipedia', 'DuckDB'],
    ['npm', 'sqlite'],
    ['openalex', 'sqlite write ahead log'],
    ['crossref', 'write ahead logging'],
    ['arxiv', 'write ahead logging'],
    ['pubmed', 'mRNA vaccine'],
    ['europepmc', 'mRNA vaccine'],
    ['google-news', 'sqlite'],
  ])('%s answers %j on its own', async (id, query) => {
    const engine = engineById(id as string)!;
    const results = await engine.search(query as string, 3);
    expect(results.length, `${id} answered nothing`).toBeGreaterThan(0);
    expect(results[0].url).toMatch(/^https?:\/\//);
  });

  it('refuses an engine that does not exist, by naming the ones that do', async () => {
    const result = await callTool('pro_fetch_web_search', { query: 'anything', engine: 'google' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('noma’lum qidiruv engine');
    for (const id of ['serper', 'tavily', 'exa', 'duckduckgo']) expect(textOf(result)).toContain(id);
  });

  it('lists what this server can search with, without being asked a query', async () => {
    const result = await callTool('pro_fetch_search_engines', {});
    expect(result.isError).toBeUndefined();
    const body = payload(result);
    expect(body.total).toBe(SEARCH_ENGINES.length);
    expect(body.usable).toBeGreaterThanOrEqual(keyless.length - 2);
    expect(body.engines.find((engine: any) => engine.id === 'serper').needs).toContain('SERPER_API_KEY');
  });

  it('restricts the listing to one kind when asked', async () => {
    const body = payload(await callTool('pro_fetch_search_engines', { kind: 'academic', usable_only: true }));
    expect(body.engines.length).toBeGreaterThan(3);
    expect(body.engines.every((engine: any) => engine.kind === 'academic')).toBe(true);
  });

  it('names a single engine in the answer when one was forced', async () => {
    const body = payload(await callTool('pro_fetch_web_search', { query: 'sqlite', engine: 'hackernews', limit: 3 }));
    expect(body.mode).toBe('single');
    expect(body.provider).toContain('Hacker News');
    expect(body.count).toBeGreaterThan(0);
  });
});
