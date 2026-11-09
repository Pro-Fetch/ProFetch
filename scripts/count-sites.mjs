// Where the test counts are written down, and how to check them.
//
// This lives in its own module for the same reason `vitest-summary.mjs` does: `scripts/run-tests.mjs`
// cannot be imported by a test, because importing it starts a nested suite run and calls `process.exit`
// inside the worker. The decision logic therefore has to sit somewhere a unit test can reach — otherwise
// "the runner catches drift" is a claim with no test behind it, which is exactly the kind of claim this
// repository keeps having to retract.
//
// Everything here is pure: the caller supplies a `readFile(path)` function. No filesystem, no writes.

/**
 * Every place a test count is written down, with the pattern that finds it.
 *
 * One definition, used both to write (in `run-tests.mjs`) and to check (here). That is the point: if the
 * checker carried its own copy of these regexes, a pattern could stop matching in one of them and the two
 * would disagree about reality — the run would verify a number nothing was reading. That is not
 * hypothetical: the README moved to a centred `<img>` layout, the badge pattern then matched zero times,
 * and the manifest reached 758 while the README stayed at 741.
 */
export const COUNT_SITES = [
  {
    file: 'README.md',
    // `tests-<n>%20passing` inside a shields.io badge URL. Two shapes are accepted: the markdown image
    // form, and the HTML <img> form a centred header uses.
    pattern: /((?:\[\!\[tests\]\(|src=\")https:\/\/img\.shields\.io\/badge\/tests-)(\d+)(\s*%20passing)/,
    replacement: (m, count) => m[1] + count + m[3],
    group: 2,
    what: 'badge',
  },
  {
    file: 'README.md',
    // A table cell: `**741 tests** across 39 files`.
    pattern: /(\*\*\s*)(\d+)(\s+tests\*\*\s+across\s+)(\d+)(\s+files)/,
    replacement: (m, count, files) => m[1] + count + m[3] + files + m[5],
    group: 2,
    fileGroup: 4,
    what: 'jadval',
  },
  {
    file: 'docs/ARCHITECTURE.md',
    // The pipeline line: ``test` (999)`.
    pattern: /(`test` \()(\d+)(\))/,
    replacement: (m, count) => m[1] + count + m[3],
    group: 2,
    what: 'arkitektura',
  },
];

/**
 * Read the counts the repository currently claims.
 *
 * @param {(file: string) => string} readFile — resolves a repository-relative path to its text.
 * @returns {{found: Array<{what: string, file: string, tests: number, files: number|null}>,
 *            missing: string[]}}
 */
export function readCommittedCounts(readFile) {
  const found = [];
  const missing = [];
  const cache = new Map();
  for (const site of COUNT_SITES) {
    if (!cache.has(site.file)) cache.set(site.file, readFile(site.file));
    const m = cache.get(site.file).match(site.pattern);
    if (!m) {
      missing.push(`${site.file} — ${site.what}: hech qanday moslik topilmadi (pattern eskirgan)`);
      continue;
    }
    found.push({
      what: site.what,
      file: site.file,
      tests: Number(m[site.group]),
      files: site.fileGroup === undefined ? null : Number(m[site.fileGroup]),
    });
  }
  return { found, missing };
}

/**
 * Write the measured numbers into every site. Pure: the caller supplies readFile and writeFile.
 *
 * `String.prototype.replace` hands its callback `(whole, ...groups, offset, string)`, while the
 * replacement contract above takes the match ARRAY (`m[1]` is group 1, exactly as `text.match()`
 * returns it). Passing the whole-match string instead produced `t1988s` where `` `test` (1988) ``
 * belonged: the number landed, and the characters around it were sliced out of the match. A writer and
 * a checker in one file, disagreeing about what `m` means, is why `syncCountSites` and `checkCounts`
 * are covered by a round trip (write, then check) rather than only by separate tests of each.
 *
 * @param {{readFile: (f: string) => string, writeFile: (f: string, text: string) => void,
 *          reportedFiles: number, reportedTests: number}} input
 * @returns {{refused: string[], written: string[]}}
 */
export function syncCountSites({ readFile, writeFile, reportedFiles, reportedTests }) {
  const byFile = new Map();
  const refused = [];
  for (const site of COUNT_SITES) {
    const entry = byFile.get(site.file) ?? { text: null, applied: 0, refused: [] };
    if (entry.text === null) entry.text = readFile(site.file);
    const matches = entry.text.match(new RegExp(site.pattern.source, 'g')) ?? [];
    if (matches.length !== 1) {
      entry.refused.push(`${site.what}: ${matches.length} ta moslik (aniq 1 ta bo'lishi kerak edi)`);
      refused.push(`${site.file} — ${site.what}: ${matches.length} ta moslik, aniq 1 ta kerak edi`);
    } else {
      entry.text = entry.text.replace(site.pattern, (...args) => site.replacement(args, reportedTests, reportedFiles));
      entry.applied += 1;
    }
    byFile.set(site.file, entry);
  }

  const written = [];
  for (const [file, entry] of byFile) {
    if (entry.applied > 0) {
      writeFile(file, entry.text);
      written.push(`${file}: ${entry.applied} ta joy yangilandi`);
    }
    if (entry.refused.length > 0) written.push(`${file}: qo'lda — ${entry.refused.join('; ')}`);
  }
  return { refused, written };
}

/**
 * Compare what a run measured with what is committed. Writes nothing.
 *
 * @param {{readFile: (f: string) => string, manifestTestFiles: number, manifestTestCount: number,
 *          reportedFiles: number, reportedTests: number}} input
 * @returns {string[]} one line per disagreement; empty means the repository is honest as it stands.
 */
export function checkCounts({ readFile, manifestTestFiles, manifestTestCount, reportedFiles, reportedTests }) {
  const problems = [];
  if (manifestTestFiles !== reportedFiles) {
    problems.push(`scripts/tool-counts.json testFiles: yozilgan ${manifestTestFiles}, o‘lchangan ${reportedFiles}`);
  }
  if (manifestTestCount !== reportedTests) {
    problems.push(`scripts/tool-counts.json testCount: yozilgan ${manifestTestCount}, o‘lchangan ${reportedTests}`);
  }
  const { found, missing } = readCommittedCounts(readFile);
  for (const m of missing) problems.push(m);
  for (const site of found) {
    if (site.tests !== reportedTests) {
      problems.push(`${site.file} — ${site.what}: yozilgan ${site.tests}, o‘lchangan ${reportedTests}`);
    }
    if (site.files !== null && site.files !== reportedFiles) {
      problems.push(`${site.file} — ${site.what}: fayl soni yozilgan ${site.files}, o‘lchangan ${reportedFiles}`);
    }
  }
  return problems;
}
