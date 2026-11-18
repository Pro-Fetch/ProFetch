#!/usr/bin/env node
/**
 * The type-debt ratchet: tests and scripts are typechecked, and the recorded number must equal the
 * measured one.
 *
 * ## Why this exists at all
 *
 * `npm run lint` is `tsc --noEmit` over the main `tsconfig.json`, which includes `src` only. Tests and
 * scripts have therefore never been typechecked by anything — they run under Vitest, which strips types
 * without checking them. Turning the check on (`tsconfig.check.json`, which includes `src`, `tests`,
 * `scripts` and `vitest.config.ts`) measured 103 errors on the day it was first run.
 *
 * Twelve of those were real defects, not style: a JWT regression fixture that signed with SHA-512 while
 * its header claimed HS256, an upload test casting the parsed hand-off to `never[]` so its property checks
 * asserted nothing, four calls to a tool handler with an argument the handler stopped taking, a duplicate
 * name in one import list, and a fetch option (`maxChars`) that the option type does not have. Those are
 * fixed.
 *
 * ## Why a ratchet and not a clean gate
 *
 * The remaining errors are overwhelmingly `noImplicitAny` on callbacks and `JSON.parse` results indexed as
 * `{}` — type hygiene in 91 places across 30 files, most of them tests written long before this check
 * existed. Making the gate demand zero means either pretending the number is zero or landing one commit
 * that rewrites thirty test files, and neither is a claim I can defend in a review.
 *
 * So the gate demands the truth: the recorded count must equal the measured count. Adding a new type error
 * fails the build; fixing some and leaving the record behind also fails the build, which is what makes
 * `npm run lint:types:sync` part of the same change rather than a note in a commit message. The number in
 * `scripts/type-debt.json` is per file, so a regression names the file it grew in.
 *
 * Run: `npm run lint:types` (gate) · `npm run lint:types:sync` (record what was measured)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// `fileURLToPath`, not `URL.pathname`: this repository lives under a non-ASCII path, and the pathname of a
// file URL is percent-encoded — which writes the record next to a directory named `%D0%97...`.
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const recordPath = path.join(root, 'scripts', 'type-debt.json');
const SYNC = process.argv.includes('--sync');

/** One config, one command: the same invocation a person would run by hand. */
const COMMAND = 'tsc -p tsconfig.check.json --pretty false';

function measure() {
  const run = spawnSync('npx', COMMAND.split(' '), {
    cwd: root,
    encoding: 'utf8',
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = (run.stdout ?? '') + (run.stderr ?? '');
  const files = {};
  for (const line of out.split('\n')) {
    const match = /^(.+?)\((\d+),(\d+)\): error (TS\d+):/.exec(line.trim());
    if (!match) continue;
    if (match[1].includes('node_modules')) continue;
    const file = match[1].replace(/\\/g, '/');
    files[file] = (files[file] ?? 0) + 1;
  }
  return { files, total: Object.values(files).reduce((sum, n) => sum + n, 0) };
}

const measured = measure();
// `--sync` is allowed to create the record; the gate is not, because comparing against nothing would pass.
const recorded = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, 'utf8')) : { total: 0, files: {} };
if (!SYNC && !existsSync(recordPath)) {
  console.error('TYPE_DEBT_FAIL');
  console.error('- scripts/type-debt.json yo‘q — darvoza bo‘sh narsa bilan solishtirmaydi: `npm run lint:types:sync`.');
  process.exit(1);
}

if (SYNC) {
  const next = {
    command: COMMAND,
    note: 'O‘lchanadi, qo‘lda yozilmaydi. `npm run lint:types` shu son bilan o‘lchovni solishtiradi.',
    total: measured.total,
    files: Object.fromEntries(Object.entries(measured.files).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
  };
  writeFileSync(recordPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
  console.log(
    `type-debt: yozildi — total ${recorded.total} -> ${measured.total}, fayllar ${Object.keys(recorded.files).length} -> ${Object.keys(measured.files).length}`,
  );
  process.exit(0);
}

const problems = [];
if (measured.total !== recorded.total) {
  problems.push(`o‘lchangan total ${measured.total}, yozilgan ${recorded.total}`);
}
for (const [file, count] of Object.entries(measured.files)) {
  const before = recorded.files[file] ?? 0;
  if (count > before) problems.push(`${file}: yozilgan ${before}, o‘lchangan ${count} (yangi xato)`);
}
for (const file of Object.keys(recorded.files)) {
  if (!(file in measured.files))
    problems.push(`${file}: xatolar yo‘qoldi, yozuv esa ${recorded.files[file]} deb turibdi`);
}

if (problems.length) {
  console.error('TYPE_DEBT_FAIL');
  for (const line of problems) console.error('- ' + line);
  console.error('- Son o‘lchovdan chiqadi: `npm run lint:types:sync` bilan yozib qo‘ying (bir o‘zgarishda).');
  process.exit(1);
}
console.log(
  `TYPE_DEBT_PASS total=${measured.total}; fayllar=${Object.keys(measured.files).length} (o‘lchangan: ${COMMAND})`,
);
