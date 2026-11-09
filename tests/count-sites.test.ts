import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { COUNT_SITES, checkCounts, readCommittedCounts, syncCountSites } from '../scripts/count-sites.mjs';

// The runner refuses to write these numbers in its default mode; it only compares. That comparison is the
// thing standing between "the suite is green" and "the repository is honest about how green", so it is
// tested here rather than trusted. `scripts/run-tests.mjs` itself cannot be imported by a test — it would
// start a nested suite run and call process.exit inside the worker — which is why the logic lives in
// scripts/count-sites.mjs.

const FILES = 117;
const TESTS = 1980;

function fakeFiles(overrides: Record<string, string> = {}) {
  const base: Record<string, string> = {
    'README.md':
      `[![tests](https://img.shields.io/badge/tests-${TESTS}%20passing-green)](x)\n` +
      `| \`test\` | **${TESTS} tests** across ${FILES} files | … |\n`,
    'docs/ARCHITECTURE.md': `pipeline: \`build\` → \`test\` (${TESTS}) → \`verify\`\n`,
  };
  const merged = { ...base, ...overrides };
  return (file: string) => {
    if (!(file in merged)) throw new Error(`test did not provide ${file}`);
    return merged[file];
  };
}

function check(readFile: (f: string) => string, reportedFiles = FILES, reportedTests = TESTS) {
  return checkCounts({
    readFile,
    manifestTestFiles: FILES,
    manifestTestCount: TESTS,
    reportedFiles,
    reportedTests,
  });
}

describe('count-sites: the drift check the default `npm test` now runs', () => {
  it('says nothing when every written number agrees with the run', () => {
    expect(check(fakeFiles())).toEqual([]);
  });

  it('names a manifest that disagrees with the measured run', () => {
    const problems = check(fakeFiles(), FILES, TESTS + 12);
    expect(problems.some((p) => p.includes('tool-counts.json testCount') && p.includes('1980'))).toBe(true);
    expect(problems.some((p) => p.includes('1992'))).toBe(true);
  });

  it('names the README badge that still carries the old number', () => {
    const problems = check(
      fakeFiles({
        'README.md':
          `[![tests](https://img.shields.io/badge/tests-1569%20passing-green)](x)\n` +
          `| \`test\` | **${TESTS} tests** across ${FILES} files | … |\n`,
      }),
    );
    expect(problems.filter((p) => p.includes('badge')).length).toBe(1);
    expect(problems.find((p) => p.includes('badge'))).toContain('1569');
  });

  it('catches a stale file count in the README table, not only a stale test count', () => {
    const problems = check(
      fakeFiles({
        'README.md':
          `[![tests](https://img.shields.io/badge/tests-${TESTS}%20passing-green)](x)\n` +
          `| \`test\` | **${TESTS} tests** across 39 files | … |\n`,
      }),
    );
    expect(problems.some((p) => p.includes('fayl soni yozilgan 39'))).toBe(true);
  });

  it('reports a pattern that stopped matching instead of passing quietly', () => {
    // The failure this exists to prevent: the README layout changed, the badge regex matched zero times,
    // the writer left the number alone, and the drift only surfaced in the next person's `verify:static`.
    const problems = check(fakeFiles({ 'README.md': `| \`test\` | **${TESTS} tests** across ${FILES} files |\n` }));
    expect(problems.some((p) => p.includes('badge') && p.includes('moslik topilmadi'))).toBe(true);
  });

  it('reads every site it claims to read', () => {
    const { found, missing } = readCommittedCounts(fakeFiles());
    expect(found.map((f) => f.what)).toEqual(COUNT_SITES.map((s) => s.what));
    expect(missing).toEqual([]);
    expect(found.find((f) => f.what === 'jadval')?.files).toBe(FILES);
  });

  it('rewrites only the number, leaving the surrounding shape intact', () => {
    const badge = COUNT_SITES.find((s) => s.what === 'badge')!;
    const m = fakeFiles()('README.md').match(badge.pattern)!;
    expect(badge.replacement(m, 2000, 120)).toBe('[![tests](https://img.shields.io/badge/tests-2000%20passing');
    const table = COUNT_SITES.find((s) => s.what === 'jadval')!;
    const t = fakeFiles()('README.md').match(table.pattern)!;
    expect(table.replacement(t, 2000, 120)).toBe('**2000 tests** across 120 files');
    const arch = COUNT_SITES.find((s) => s.what === 'arkitektura')!;
    const a = fakeFiles()('docs/ARCHITECTURE.md').match(arch.pattern)!;
    expect(arch.replacement(a, 2000, 120)).toBe('`test` (2000)');
  });
});

describe('count-sites: the repository as it is committed right now', () => {
  it('has no drift between the manifest, the README and ARCHITECTURE.md', () => {
    // Not a fixture: this reads the real files. If a session adds tests and forgets `npm run test:sync`,
    // this is where it becomes visible — before CI does, and with the file names in the message.
    const manifest = JSON.parse(readFileSync(new URL('../scripts/tool-counts.json', import.meta.url), 'utf8'));
    const problems = checkCounts({
      readFile: (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'),
      manifestTestFiles: manifest.testFiles,
      manifestTestCount: manifest.testCount,
      reportedFiles: manifest.testFiles,
      reportedTests: manifest.testCount,
    });
    expect(problems).toEqual([]);
  });
});

describe('count-sites: writer and checker agree (round trip)', () => {
  // Why this test exists at all. The writer was first written against `String.replace`, whose callback
  // receives `(whole, ...groups, offset, string)`, while the replacement contract here takes the match
  // ARRAY. Passing the whole-match string instead sliced characters out of it and produced `t1988s`
  // where `` `test` (1988) `` belonged. The isolated test of `replacement()` passed, because the test
  // handed it an array and the call site handed it a string. Only writing and then reading back catches
  // that — so this file writes, then checks, and asserts the exact text.
  function roundTrip(files: Record<string, string>, reportedFiles: number, reportedTests: number) {
    const store = new Map(Object.entries(files));
    const { refused, written } = syncCountSites({
      readFile: (f) =>
        store.get(f) ??
        (() => {
          throw new Error(`no ${f}`);
        })(),
      writeFile: (f, text) => void store.set(f, text),
      reportedFiles,
      reportedTests,
    });
    return {
      refused,
      written,
      read: (f: string) => store.get(f)!,
      drift: checkCounts({
        readFile: (f) => store.get(f) ?? '',
        manifestTestFiles: reportedFiles,
        manifestTestCount: reportedTests,
        reportedFiles,
        reportedTests,
      }),
    };
  }

  it('writes text the checker then finds honest', () => {
    const r = roundTrip(
      {
        'README.md':
          '[![tests](https://img.shields.io/badge/tests-1980%20passing-green)](x)\n' +
          '| `test` | **1980 tests** across 117 files | … |\n',
        'docs/ARCHITECTURE.md': 'pipeline: `build` · `test` (1980) · `audit:schema`\n',
      },
      118,
      1988,
    );
    expect(r.refused).toEqual([]);
    expect(r.drift).toEqual([]);
    expect(r.read('README.md')).toContain('tests-1988%20passing');
    expect(r.read('README.md')).toContain('**1988 tests** across 118 files');
    expect(r.read('docs/ARCHITECTURE.md')).toContain('`test` (1988)');
    expect(r.read('docs/ARCHITECTURE.md')).not.toContain('t1988s');
  });

  it('leaves a file alone and reports when a pattern matches twice', () => {
    const ambiguous = '| `test` | **100 tests** across 1 files |\n| `test` | **200 tests** across 2 files |\n';
    const r = roundTrip({ 'README.md': ambiguous, 'docs/ARCHITECTURE.md': '`test` (100)\n' }, 118, 1988);
    expect(r.refused.some((line) => line.includes('jadval') && line.includes('2 ta moslik'))).toBe(true);
    expect(r.read('README.md')).toBe(ambiguous);
  });

  it('reports an outdated pattern instead of pretending the site does not exist', () => {
    const r = roundTrip({ 'README.md': 'no numbers here\n', 'docs/ARCHITECTURE.md': 'nor here\n' }, 1, 1);
    expect(r.refused.length).toBe(3);
    expect(r.drift.filter((line) => line.includes('moslik topilmadi')).length).toBe(3);
  });
});
