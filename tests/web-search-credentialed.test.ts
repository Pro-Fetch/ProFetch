import { afterEach, describe, expect, it } from 'vitest';

import { SEARCH_ENGINES, engineById, enginesFor, generalWebEngines } from '../src/core/search-engines.js';
import { searchAcross, searchWeb } from '../src/core/search-providers.js';

// A plain web search is now a credentialed operation. The reason is measured, not stylistic: the old chain
// walked past the keyless general rows (DuckDuckGo answers HTTP 202 with an empty page) and into academic
// metadata, so a query about hosting came back as Crossref DOIs after 10 145 ms — a confident-looking wrong
// answer. These tests pin both halves of the fix: the composition of the chain, and the fact that a vertical
// request still reaches the free engines.

const GENERAL_KEYS = [
  'SERPER_API_KEY',
  'SEARCH_API_KEY',
  'TAVILY_API_KEY',
  'EXA_API_KEY',
  'SERPAPI_API_KEY',
  'LINKUP_API_KEY',
  'DATAFORSEO_LOGIN',
  'DATAFORSEO_PASSWORD',
  'GOOGLE_API_KEY',
  'GOOGLE_CSE_ID',
  'PERPLEXITY_API_KEY',
];

const saved = new Map<string, string | undefined>();
function withoutGeneralKeys(): void {
  for (const key of GENERAL_KEYS) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    delete process.env[key];
    delete process.env[`${key}_FILE`];
  }
}
function restoreKeys(): void {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
}
afterEach(restoreKeys);

describe('generalWebEngines: what may stand behind a plain web search', () => {
  it('is every credentialed general engine and nothing else', () => {
    const ids = generalWebEngines().map((engine) => engine.id);
    for (const expected of ['serper', 'brave', 'tavily', 'exa', 'serpapi', 'linkup', 'dataforseo', 'perplexity']) {
      expect(ids).toContain(expected);
    }
    expect(generalWebEngines().every((engine) => engine.kind === 'general')).toBe(true);
    expect(generalWebEngines().every((engine) => engine.credentials.length > 0)).toBe(true);
  });

  it('leaves the keyless general scrapers out of the chain, but still in the registry', () => {
    const ids = generalWebEngines().map((engine) => engine.id);
    for (const excluded of ['duckduckgo', 'marginalia', 'searxng']) {
      expect(ids).not.toContain(excluded);
      expect(SEARCH_ENGINES.map((engine) => engine.id)).toContain(excluded);
    }
    // Reachable on purpose, by name — the removal is from the silent fallback, not from the product.
    expect(engineById('duckduckgo')?.credentials).toEqual([]);
  });

  it('keeps the free verticals available when a kind is asked for', () => {
    const academic = enginesFor('academic').map((engine) => engine.id);
    expect(academic).toEqual(expect.arrayContaining(['openalex', 'crossref', 'arxiv', 'pubmed', 'doaj']));
    expect(academic.some((id) => (engineById(id)?.credentials.length ?? 1) === 0)).toBe(true);
  });
});

describe('searchWeb / searchAcross with no search key', () => {
  it('refuses a plain web search before any request, naming the keys and the free verticals', async () => {
    withoutGeneralKeys();
    await expect(searchWeb('web hosting pricing', 5)).rejects.toThrow(/kalit talab qiladi/);
    await expect(searchWeb('web hosting pricing', 5)).rejects.toThrow(/urinish ham qilinmadi/);
    await expect(searchWeb('web hosting pricing', 5)).rejects.toThrow(/kind='academic'/);
  });

  it('refuses a fan-out the same way instead of returning an empty merged answer', async () => {
    withoutGeneralKeys();
    await expect(searchAcross('web hosting pricing', 5, {})).rejects.toThrow(/sozlanmagan/);
  });

  it('does not refuse a vertical: an academic kind still runs keyless engines', async () => {
    withoutGeneralKeys();
    // Either it answers, or an engine refused for its own reason — what must NOT happen is the new
    // "no key configured" refusal, because a vertical was explicitly requested.
    try {
      const result = await searchWeb('graph neural network drug discovery', 3, { kind: 'academic' });
      expect(result.results.length).toBeGreaterThan(0);
    } catch (error) {
      expect(String(error)).not.toMatch(/kalit talab qiladi/);
    }
  });
});
