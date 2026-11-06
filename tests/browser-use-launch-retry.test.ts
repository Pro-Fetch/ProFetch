import { describe, expect, it } from 'vitest';
import '../src/loader.js';
import { LAUNCH_ATTEMPTS, isTransientLaunchFailure, launchManaged } from '../src/core/browser-use-runtime.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The launch-retry policy.
 *
 * The Windows CI runner produced the failure this exists for and no local run could: Chrome was spawned,
 * then Playwright reported the target closed and the cleanup's `taskkill` could not find the pid. The
 * classifier is tested against that text verbatim, because a retry policy that guesses at the shape of the
 * failure it is meant to survive is a retry policy that retries the wrong things.
 */

const WINDOWS_LAUNCH_RACE =
  'Google Chrome launch failed: browserType.launchPersistentContext: Target page, context or browser ' +
  'has been closed\nBrowser logs:\n<launched> pid=22184\n[pid=22184] <will force kill>\ntaskkill stderr: ERROR: no process found';

describe('a launch that died is not a launch that was refused', () => {
  it('recognises the race the Windows runner reported, word for word', () => {
    expect(isTransientLaunchFailure(WINDOWS_LAUNCH_RACE)).toBe(true);
  });

  it('recognises the other ways a process dies under load', () => {
    for (const message of [
      'browser has been closed',
      'browserType.launchPersistentContext: Timeout 45000ms exceeded',
      'browserType.launch: ENOENT: no such file or directory, kill pid 4321',
      'connect ECONNREFUSED 127.0.0.1:9222',
      'Cannot allocate memory',
    ]) {
      expect(isTransientLaunchFailure(message), message).toBe(true);
    }
  });

  it('does not call a refusal a race', () => {
    // Retrying these only repeats them, and each retry costs the caller a browser they do not have.
    for (const message of [
      'Firefox is not installed on this host. Detected: chromium.',
      'No adapter for "safari".',
      'launchPersistentContext: Invalid arguments: --user-data-dir is not allowed',
      'profile could not be opened: the directory is corrupt',
    ]) {
      expect(isTransientLaunchFailure(message), message).toBe(false);
    }
  });

  it('says how many attempts the policy makes', () => {
    expect(LAUNCH_ATTEMPTS).toBe(3);
  });
});

describe('launchManaged still refuses what it cannot run, without pretending', () => {
  it('refuses an unknown browser product by name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pf-launch-retry-'));
    try {
      const result = await launchManaged('netscape', { dataRoot: root });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('netscape');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('a failed launch leaves no half-open session behind', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pf-launch-retry-'));
    try {
      const result = await launchManaged('netscape', { dataRoot: root });
      expect(result.ok).toBe(false);
      // Nothing was spawned, so nothing was left to clean: the directory the caller made is still empty.
      const { readdir } = await import('node:fs/promises');
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
