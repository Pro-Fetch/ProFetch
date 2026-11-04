/**
 * Environment guards for suites that need something a fresh clone may not have.
 *
 * Two facts made this file necessary. An external audit on a Linux clone with `npm ci` and no
 * `npx playwright install` got 12 failing tests and 24 skipped ones: `pinned-proxy` died at suite level
 * because a browser binary was missing, `browser-use-session` failed eleven times for the same reason, and
 * `smart-system-quality` failed on `better-sqlite3`, which is an *optional* dependency — the server is
 * designed to degrade without it, so a test that hard-fails there is testing the machine, not the code.
 *
 * The other fact is why the guard has to announce itself. `scripts/run-tests.mjs` treats a skipped test as
 * a failure on purpose: a suite where a third of the assertions never ran must not report a pass. So a skip
 * here prints an `ENV_SKIP` line, and the runner accepts skips only when they were declared — an
 * unexplained `it.skip` still fails the build.
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const require = createRequire(import.meta.url);

/** Print the declaration. Call it only on the branch that really skips. */
export function declareEnvSkip(file: string, capability: string, reason: string): void {
  console.log(`ENV_SKIP file=${file} capability=${capability} reason=${reason}`);
}

/**
 * `describe.skipIf` plus the declaration the runner looks for.
 *
 * The line is printed only when the block really is skipped: a declaration whose tests then ran is a
 * guard that stopped guarding, and the runner fails that.
 */
export function skipBlockWithout(file: string, capability: string, reason: string, available: boolean): void {
  if (!available) declareEnvSkip(file, capability, reason);
}

/** Is a browser launchable here — installed on the host, or downloaded for Playwright? */
export async function browserAvailable(): Promise<{ ok: boolean; reason: string }> {
  const { detectInstalled } = await import('../../src/core/browser-use-runtime.js');
  const detected = await detectInstalled({ readVersions: false }).catch(() => []);
  if (detected.length > 0) return { ok: true, reason: '' };
  // Playwright's own cache: a host with no browser app installed may still have `chromium` downloaded.
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(process.env.HOME ?? '', '.cache', 'ms-playwright');
  const have =
    existsSync(cache) &&
    (await import('node:fs')).readdirSync(cache).some((entry) => /chromium|chrome-headless/.test(entry));
  return have
    ? { ok: true, reason: '' }
    : {
        ok: false,
        reason:
          'no browser installed and no Playwright download in ' + cache + ' — run `npx playwright install chromium`',
      };
}

/** Is an optional native module actually present? Absence is a supported state, not a failure. */
export function moduleAvailable(name: string): { ok: boolean; reason: string } {
  try {
    require.resolve(name);
    return { ok: true, reason: '' };
  } catch {
    return {
      ok: false,
      reason: `${name} is not installed (it is an optional dependency; the server degrades without it)`,
    };
  }
}
