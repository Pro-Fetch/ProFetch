// Test runner that refuses to report a truncated run as a pass.
//
// Why this exists: on Node 24.21.0 with vitest 2.1.9's `forks` pool, a native N-API module that
// registers an environment cleanup hook can abort inside `node::MultiIsolatePlatform::DisposeIsolate`
// (`RemoveEnvironmentCleanupHook`, `Assertion failed: (env) != nullptr`). When that happens the fork
// dies mid-run and vitest prints a summary for only the files that had already finished — often
// "Tests 29 passed (78)". The process then exits 0, so a build that stopped after 22% of its
// assertions looks identical to a clean build.
//
// `dangerouslyIgnoreUnhandledErrors` in vitest.config.ts used to hide that: it suppressed the
// non-zero exit and left a truncated run standing as a green result. It was removed for that reason,
// and this runner now enforces the property the flag used to assert without checking.
//
// The contract here is deliberately strict: a run passes only when every expected test file
// completed and no test failed. Anything else — a real assertion failure, a crashed fork, or a
// silently dropped file — exits non-zero with a message naming the actual numbers.
//
// Two modes, because "run the tests" and "re-record the counts" are different jobs:
//
//   default (`npm test`)        — verify. Nothing is written. The measured numbers are compared with
//                                 the ones already committed in `scripts/tool-counts.json`, `README.md`
//                                 and `docs/ARCHITECTURE.md`, and a disagreement fails the run with the
//                                 remedy named. A test run that silently rewrites three tracked files is
//                                 the thing an external audit called out: it makes `git status` a
//                                 side effect of checking your work, and on a clean clone the first
//                                 `npm test` already shows a dirty tree.
//   `--sync` (`npm run test:sync`) — write. This is the only mode that updates those files, and it is
//                                 run deliberately, right after adding or removing tests, with the
//                                 result committed alongside them.
//
// The cost is stated rather than hidden: adding a test now means one extra suite run to re-record.
// That is the same discipline the rest of the repository already enforces — `verify:static` and
// `verify:registry` compare committed numbers against the manifest, so the numbers had to be committed
// honestly either way.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { readFileSync, writeFileSync } from 'node:fs';
import { checkCounts, syncCountSites } from './count-sites.mjs';

const require = createRequire(import.meta.url);
const root = process.cwd();

// Single source of truth for the expectation, so this cannot drift from the suite it guards.
const manifest = require(path.join(root, 'scripts', 'tool-counts.json'));
const expectedTestFiles = manifest.testFiles;
const expectedTests = manifest.testCount;

if (typeof expectedTestFiles !== 'number' || typeof expectedTests !== 'number') {
  console.error('TEST_RUN_FAIL');
  console.error('- scripts/tool-counts.json is missing the testFiles/testCount expectations');
  console.error('  This runner cannot prove a run was complete without a stated expected total.');
  process.exit(1);
}

const argv = process.argv.slice(2);
// `--sync` belongs to this runner, not to vitest: forwarding it would make vitest fail on an unknown
// option, and the failure would look like a broken suite rather than a mistyped flag.
const SYNC_MODE = argv.includes('--sync');
const extraArgs = argv.filter((a) => a !== '--sync');
const vitestArgs = ['vitest', 'run', ...extraArgs];

// The abort is an environment fault, not a property of the code under test, and it is
// intermittent. Retrying is only safe when nothing actually failed: if an assertion failed, that
// verdict is real and must be reported, so no retry happens. This keeps the retry from becoming a
// way to turn a red suite green by trying until it feels like passing.
const MAX_ATTEMPTS = 3;
const NATIVE_ABORT = 'Assertion failed: (env) != nullptr';

function runVitest(attempt) {
  return new Promise((resolve) => {
    const child = spawn('npx', vitestArgs, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    });

    let output = '';
    const collect = (chunk) => {
      output += chunk.toString();
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('close', (code) => resolve({ code, output }));
  });
}

// The decision lives in its own module because a unit test cannot import this file to reach it:
// importing here would spawn a nested suite run and, on failure, call process.exit inside the test
// worker. Measured - "Error: process.exit unexpectedly called with 1" against a file with 0 tests.
// See scripts/vitest-summary.mjs, and tests/operator-policy-regressions.test.ts for the parsing cases.
const { evaluateSummary } = await import(new URL('./vitest-summary.mjs', import.meta.url));

function evaluate(output) {
  return evaluateSummary(output, { expectedTestFiles, expectedTests });
}

// The count sites, the reader and the drift check live in scripts/count-sites.mjs, imported above. One
// definition writes them (syncReadmeBadges) and checks them (checkCounts), so a pattern that stops
// matching cannot be missed by one copy and caught by the other.

/**
 * Record the counts the runner just measured.
 *
 * Writing them here is what makes the manifest stop being a hand-maintained number. The README badges
 * are updated alongside it, from the same two measured numbers - see `syncReadmeBadges` for why that is
 * guarded rather than done with a loose substitution.
 */
function syncManifestCounts(reportedFiles, reportedTests) {
  const file = path.join(root, 'scripts', 'tool-counts.json');
  const current = JSON.parse(readFileSync(file, 'utf8'));
  if (current.testFiles === reportedFiles && current.testCount === reportedTests) return false;
  current.testFiles = reportedFiles;
  current.testCount = reportedTests;
  writeFileSync(file, JSON.stringify(current, null, 2) + '\n', 'utf8');
  console.warn(
    `note: scripts/tool-counts.json testFiles ${expectedTestFiles} -> ${reportedFiles}, ` +
      `testCount ${expectedTests} -> ${reportedTests}.`,
  );
  return true;
}

/**
 * Updates the test badge in the README, with a guard that refuses rather than guesses.
 *
 * `verify:registry` compares the prose against the manifest and fails when they disagree, so a stale
 * badge breaks `npm run check` on the run *after* the one that measured the new number. That ordering
 * made this a manual step after every session in which tests were added, and it was done by hand each
 * time.
 *
 * Scripted, but deliberately narrowly: only the two badge shapes are touched, each pattern must match
 * exactly once, and if it does not, the file is left untouched and the reason is printed. Prose editing
 * by loose regex damaged this README five times before; a delimited badge with an exact-match
 * requirement is a different operation, and the guard is what makes it one.
 *
 * The implementation is `syncCountSites` in scripts/count-sites.mjs — the same module that checks the
 * numbers, so the writer and the checker cannot drift apart. An external audit found the repository
 * committed as `manifest testCount 1571, README 1569`: a green run had updated the manifest and printed
 * `qo'lda` about the badge as a note, and the two drift guards then failed on a fresh clone with no code
 * change. A number the guards compare cannot be left to a note.
 */
function syncReadmeBadges(reportedFiles, reportedTests) {
  const { refused, written } = syncCountSites({
    readFile: (f) => readFileSync(path.join(root, f), 'utf8'),
    writeFile: (f, text) => writeFileSync(path.join(root, f), text, 'utf8'),
    reportedFiles,
    reportedTests,
  });
  for (const line of written) console.warn(`note: ${line}`);
  return refused;
}

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  const { code, output } = await runVitest(attempt);
  process.stdout.write(output);

  const result = evaluate(output);

  if (!result.failures.length) {
    if (result.reportedFiles !== null && result.reportedTests !== null) {
      if (!SYNC_MODE) {
        // Default mode: measure, compare, write nothing. A green `npm test` has to leave the working tree
        // exactly as it found it — that is the difference between checking the code and editing it. The
        // suite is green and complete here, so this is the moment its numbers are worth trusting.
        const drift = checkCounts({
          readFile: (f) => readFileSync(path.join(root, f), 'utf8'),
          manifestTestFiles: expectedTestFiles,
          manifestTestCount: expectedTests,
          reportedFiles: result.reportedFiles,
          reportedTests: result.reportedTests,
        });
        if (drift.length > 0) {
          console.error('TEST_RUN_FAIL');
          console.error(
            `- barcha test o‘tdi (${result.reportedTests} ta, ${result.reportedFiles} fayl), lekin ` +
              `yozib qo‘yilgan sonlar buni aytmayapti:`,
          );
          for (const line of drift) console.error('  - ' + line);
          console.error(
            '- Bu rejim hech narsa yozmaydi. Yangilash uchun `npm run test:sync`, so‘ng natijani commit qiling.',
          );
          process.exit(1);
        }
        console.log(
          'note: hisoblar tekshirildi (scripts/tool-counts.json, README.md, docs/ARCHITECTURE.md) — ' +
            'hech narsa yozilmadi.',
        );
      } else {
        // Reconciled on every green run, not only when the manifest moved.
        //
        // It started inside `syncManifestCounts`, behind its early return, so the badge was only fixed in
        // the run where the count changed - and not in the next one, which is exactly the run that failed.
        // Measured: the manifest reached 758, the README stayed at 741, and `verify:registry` kept
        // reporting the disagreement across repeated runs because the code that would have fixed it had
        // already returned.
        syncManifestCounts(result.reportedFiles, result.reportedTests);
        const refused = syncReadmeBadges(result.reportedFiles, result.reportedTests);
        if (refused.length > 0) {
          // The suite is green and the numbers are not. Printing a note and exiting 0 is how a repository
          // ends up committed as `manifest 1571, README 1569`: the run that measured it looked successful,
          // and the two drift guards failed the next person to clone it.
          console.error('TEST_RUN_FAIL');
          console.error(`- barcha test o‘tdi (${result.reportedTests}), lekin hisoblar quyidagi joylarga yozilmadi:`);
          for (const line of refused) console.error('  - ' + line);
          console.error(
            '- Bu fayllardagi sonlar manifest bilan solishtiriladi; qo‘lda to‘g‘rilang yoki patternni yangilang.',
          );
          process.exit(1);
        }
      }
    }
    if (result.nativeAbort) {
      console.warn('note: a native teardown abort occurred after every test had already passed.');
    }
    // The verdict must match the exit code. This used to print `TEST_RUN_PASS` and then exit 1
    // whenever vitest reported a non-zero status, so a transcript read "every check passed" while the
    // shell said failure - the same disagreement this project keeps fixing in the tools, and worse here
    // because the person reading the log is the person who has to decide what to do next.
    //
    // A worker that dies during teardown after every test has passed is an environment fault, not a
    // failing test, and vitest signals it with a non-zero code. It is retried rather than reported,
    // because it reproduces intermittently and the retry is known to clear it.
    if (code === 0) {
      const declared = result.envSkips ?? [];
      if (declared.length > 0) {
        console.log(
          `TEST_RUN_PASS_WITH_SKIPS files=${result.reportedFiles} tests=${result.reportedTests} ` +
            `skipped=${result.skippedTests}`,
        );
        for (const skip of declared) {
          console.log(`  ENV_SKIP ${skip.file} · ${skip.capability} · ${skip.reason}`);
        }
      } else {
        console.log(`TEST_RUN_PASS files=${result.reportedFiles} tests=${result.reportedTests}`);
      }
      process.exit(0);
    }
    if (attempt < MAX_ATTEMPTS) {
      console.warn(
        `note: attempt ${attempt}/${MAX_ATTEMPTS} passed every test but vitest exited ${code} ` +
          '(worker teardown fault); retrying.',
      );
      continue;
    }
    console.error(
      `TEST_RUN_INCONCLUSIVE files=${result.reportedFiles} tests=${result.reportedTests} — ` +
        'barcha test o‘tdi, lekin vitest har urinishda noaniq kod berdi (worker teardown).',
    );
    process.exit(1);
  }

  // Retry only the environment fault: a crashed run with nothing asserted as failing.
  const onlyEnvironmentFault = result.nativeAbort && result.failedTests === 0 && result.failedFiles === 0;

  if (onlyEnvironmentFault && attempt < MAX_ATTEMPTS) {
    console.warn(
      `note: attempt ${attempt}/${MAX_ATTEMPTS} was cut short by the native teardown abort ` +
        `(no assertion failed); retrying.`,
    );
    continue;
  }

  console.error('TEST_RUN_FAIL');
  for (const failure of result.failures) console.error('- ' + failure);
  if (result.nativeAbort) {
    console.error(
      '- a native abort during worker teardown cut the run short; this is the Node 24 ' +
        '`MultiIsolatePlatform::DisposeIsolate` fault, not an assertion failure',
    );
  }
  console.error(`  vitest exit code: ${code}; attempts: ${attempt}`);
  process.exit(1);
}
