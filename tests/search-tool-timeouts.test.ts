import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { SEARCH_TOOL_TIMEOUT_MS } from '../src/core/search-engines.js';

// Measured, not guessed: `pro_fetch_news_search` took 14 118 ms to return four articles that had nothing to
// do with the query, because it called `fetchWithOptions` without a timeout and sat inside that helper's
// 30 s default. Auditing the folder found sixteen tools doing the same. A test that only checks the constant
// would not have caught any of them, so this one reads the source files.

const dir = new URL('../src/tools/search/', import.meta.url);

describe('search tools must bound their own request', () => {
  it('passes a timeout everywhere a search tool calls fetchWithOptions', () => {
    const offenders: string[] = [];
    const covered: string[] = [];
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts'))) {
      const source = readFileSync(new URL(file, dir), 'utf8');
      if (!source.includes('fetchWithOptions(')) continue;
      const calls = source.split('fetchWithOptions(').length - 1;
      const bounded = source.split('timeoutMs: SEARCH_TOOL_TIMEOUT_MS').length - 1;
      if (bounded < calls) offenders.push(`${file}: ${calls} chaqiruv, ${bounded} ta timeout`);
      else covered.push(file);
    }
    expect(offenders).toEqual([]);
    // Sixteen files had to be fixed; a guard that passes on an empty set guards nothing.
    expect(covered.length).toBeGreaterThanOrEqual(16);
  });

  it('imports the constant it uses, so the cap lives in one place', () => {
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts'))) {
      const source = readFileSync(new URL(file, dir), 'utf8');
      if (!source.includes('timeoutMs: SEARCH_TOOL_TIMEOUT_MS')) continue;
      expect(source, `${file} uses the constant without importing it`).toMatch(
        /import \{[^}]*SEARCH_TOOL_TIMEOUT_MS[^}]*\} from '\.\.\/\.\.\/core\/search-engines\.js';/,
      );
    }
  });

  it('keeps the cap far below the default it replaced, but above a slow healthy index', () => {
    // The 30 s default is what these calls were inheriting; 2 s would start failing OpenAlex (measured
    // 2.0 s) for being slightly busy. The window is the measurement, not a preference.
    expect(SEARCH_TOOL_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
    expect(SEARCH_TOOL_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
  });
});
