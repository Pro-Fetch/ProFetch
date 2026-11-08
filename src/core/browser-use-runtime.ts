/**
 * The runtime half of the Browser Intelligence Engine: real detection and a real managed session.
 *
 * Everything above this file in the category is description. This is the first place that touches a
 * disk, spawns a process, and can therefore be *wrong in public* — which is why every result it
 * produces is reported with the evidence that produced it rather than as a boolean.
 *
 * Two rules the implementation is held to:
 *
 * 1. **A capability becomes `VERIFIED_MANAGED` only because something ran.** The profiles in
 *    `browser-use-capabilities.ts` are read from specifications; this module is what turns a claim
 *    into a fact, and the compatibility report records which is which.
 * 2. **A missing browser is reported, not substituted.** Asking for Firefox on a machine without it
 *    returns a refusal naming what *is* installed. Silently launching Chromium instead is the failure
 *    the brief forbids and the survey found in the wild.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DetectedBrowser, LaunchOptions, OperatingSystem, ResolvedConnection } from './browser-use-contract.js';
import { detectBrowsers } from './browser-use-detect.js';
import { ADAPTERS, adapterFor, planFor, type LaunchPlan } from './browser-use-adapters.js';
import { buildRegistry, selectBrowser } from './browser-use-registry.js';
import { unsearchableOn } from './browser-use-detect.js';
import { attachNetworkGuard } from './browser-use-network-guard.js';
import type { Registry } from './browser-use-registry.js';

/** How many times a transiently-failing launch is tried, into a fresh profile directory each time. */
export const LAUNCH_ATTEMPTS = 3;

/**
 * A launch that died the way launches die under load, not a launch that was refused.
 *
 * Measured on the Windows CI runner, verbatim: the browser process started, then Playwright reported
 * "Target page, context or browser has been closed" and the cleanup's taskkill said the pid no longer
 * existed — while the same build passed on the other five matrix jobs. That is a race, and a race is
 * retried. A *refusal* — the executable missing, the profile undecodable, a permanent argument error —
 * is not, because retrying it would only repeat it.
 *
 * Exported so a unit test can pin the shapes without faking a browser crash.
 */
export function isTransientLaunchFailure(message: string): boolean {
  // `Timeout \d+ms exceeded` is Playwright's own wording — the first version of this pattern looked for
  // "timed out", which is what a human writes and not what this library emits, so a launch that ran out of
  // time was classified as permanent and never retried.
  return /Target page, context or browser has been closed|browser has been closed|Timeout \d+ ?ms exceeded|process (did not exit|exit code)|kill ENOENT|ENOENT[^\n]*pid|EACCES|[Cc]annot allocate|out of memory|ENOMEM|ECONNREFUSED|connection refused|will force kill|gracefully close start/i.test(
    message,
  );
}

export function currentOs(): OperatingSystem {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'linux') return 'linux';
  return 'unknown';
}

/** Detection wired to the real filesystem and the real process table. */
export async function detectInstalled(options: { readVersions?: boolean } = {}): Promise<DetectedBrowser[]> {
  const os = currentOs();
  return detectBrowsers({
    os,
    exists: (p) => {
      try {
        return existsSync(p);
      } catch {
        return false;
      }
    },
    which: (name) => whichOnPath(name),
    readVersion: options.readVersions ? (executablePath) => readExecutableVersion(os, executablePath) : undefined,
  });
}

/** A PATH lookup without spawning a shell: `where` on Windows, manual PATH walk elsewhere. */
export function whichOnPath(name: string): string {
  const envPath = process.env.PATH ?? process.env.Path ?? '';
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of envPath.split(process.platform === 'win32' ? ';' : ':')) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = dir.replace(/[/\\]$/, '') + (process.platform === 'win32' ? '\\' : '/') + name + ext;
      try {
        if (existsSync(candidate)) return candidate;
      } catch {
        /* a malformed PATH entry is not an error worth propagating */
      }
    }
  }
  return '';
}

/**
 * A version string for an executable, by the method that actually works on this OS.
 *
 * On Windows, `chrome.exe --version` does not print a version: the binary writes a localised
 * "this switch is not supported" message and exits non-zero, which read back as UTF-8 becomes
 * mojibake and would be stored as a version. The file-version resource is what Windows reports, so
 * that is what is asked for — one PowerShell call per candidate, and an empty string rather than a
 * guess when it fails.
 */
export async function readExecutableVersion(os: OperatingSystem, executablePath: string): Promise<string> {
  if (os === 'windows') {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    try {
      const { stdout } = await promisify(execFile)(
        'powershell.exe',
        ['-NoProfile', '-Command', `(Get-Item -LiteralPath $env:PF_EXE).VersionInfo.ProductVersion`],
        { windowsHide: true, timeout: 15_000, env: { ...process.env, PF_EXE: executablePath } },
      );
      return String(stdout).trim();
    } catch {
      return '';
    }
  }
  const adapter = ADAPTERS.find((a) => a.candidates(os).includes(executablePath));
  return adapter ? adapter.version(executablePath) : '';
}

/** The registry built from what is actually on this machine. */
export async function localRegistry(options: { readVersions?: boolean } = {}): Promise<Registry> {
  const detected = await detectInstalled(options);
  return buildRegistry(detected, unsearchableOn(currentOs()));
}

export interface ManagedSession {
  product: string;
  executablePath: string;
  userDataDir: string;
  notes: string[];
  /**
   * Whether sub-resource requests in this session go through the pinned network guard. Kept as a field as
   * well as in `notes`, because a report that says "the guard is on" has to read a fact, not parse a
   * sentence it wrote itself.
   */
  networkGuard: { ok: boolean; reason: string };
  /** The Playwright browser handle. Typed loosely: Playwright is an optional dependency. */
  browser: { close(): Promise<void>; isConnected(): boolean };
  context: unknown;
}

/**
 * Launch a managed browser for a product, through the adapter's plan.
 *
 * The plan is what makes this honest: the profile directory, the flags and the transport notes all
 * come from the adapter, so a launch cannot quietly use a different configuration than the one the
 * compatibility report describes.
 */
export async function launchManaged(
  product: string,
  options: {
    headless?: boolean;
    dataRoot: string;
    debuggingPort?: number;
    extraArgs?: string[];
    deviceScaleFactor?: number;
  } = { dataRoot: '.' },
): Promise<{ ok: true; session: ManagedSession } | { ok: false; reason: string }> {
  const adapter = adapterFor(product);
  if (!adapter) return { ok: false, reason: `No adapter for "${product}".` };
  const executablePath = adapter.candidates(currentOs()).find((p) => {
    try {
      return existsSync(p);
    } catch {
      return false;
    }
  });
  if (!executablePath) {
    const installed = (await detectInstalled()).map((b) => b.product);
    return {
      ok: false,
      reason:
        `${adapter.label} is not installed on this host. ` +
        `Detected: ${installed.length ? installed.join(', ') : 'nothing the registry recognises'}. ` +
        'No substitute browser is launched in its place.',
    };
  }
  const launch: LaunchOptions = {
    headless: options.headless ?? true,
    executablePath,
    debuggingPort: options.debuggingPort,
    args: options.extraArgs,
  };
  const planned = planFor(product, launch, options.dataRoot);
  if (!planned.ok) return { ok: false, reason: planned.reason };
  const plan: LaunchPlan = planned.plan;

  const engine = adapter.engine;
  const playwright = await import('playwright');
  const launcher = engine === 'firefox' ? playwright.firefox : playwright.chromium;

  let reason = '';
  for (let attempt = 1; attempt <= LAUNCH_ATTEMPTS; attempt += 1) {
    // A second launch into the first attempt's profile directory inherits whatever it left behind
    // (SingletonLock, DevToolsActivePort, an unclean exit). Each attempt gets its own directory, inside
    // the caller's dataRoot so the caller's own cleanup still removes all of them.
    const profileDir = attempt === 1 ? plan.userDataDir : join(options.dataRoot, `launch-retry-${attempt}`);
    try {
      // `--user-data-dir` is rejected by `launch()` — Playwright owns that switch there. Profile
      // isolation is expressed by launching a persistent context at the directory the adapter chose,
      // which is the same guarantee in the API that supports it.
      const args = plan.args.filter((a) => !a.startsWith('--user-data-dir'));
      const context = await launcher.launchPersistentContext(profileDir, {
        executablePath: plan.executablePath,
        headless: options.headless ?? true,
        args,
        timeout: 45_000,
        // Emulated, not pretended: the host's own ratio is untouched, and a caller that needs to know the
        // physical display can read `window.devicePixelRatio` before asking for either.
        ...(options.deviceScaleFactor ? { deviceScaleFactor: options.deviceScaleFactor } : {}),
      } as never);
      const browser = context.browser();
      // The page is about to be able to fetch anything; the guard is attached before the caller is told the
      // session exists, and the outcome is written into the session's own notes so a report can say whether
      // sub-resource requests are validated rather than leaving that to be assumed.
      const guard = await attachNetworkGuard(context as unknown as Parameters<typeof attachNetworkGuard>[0]);
      const launchNotes =
        attempt === 1
          ? plan.notes
          : [...plan.notes, `launched on attempt ${attempt}/${LAUNCH_ATTEMPTS} after: ${reason}`];
      return {
        ok: true,
        session: {
          product,
          executablePath: plan.executablePath,
          userDataDir: profileDir,
          notes: [...launchNotes, `network guard: ${guard.ok ? 'on' : 'off'} — ${guard.reason}`],
          networkGuard: guard,
          browser: browser as unknown as ManagedSession['browser'],
          context,
        },
      };
    } catch (error) {
      reason = `${adapter.label} launch failed: ${(error as Error).message}`;
      if (!isTransientLaunchFailure(reason)) break;
      if (attempt < LAUNCH_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  }
  return {
    ok: false,
    reason: `${reason} — ${LAUNCH_ATTEMPTS} urinish${
      isTransientLaunchFailure(reason)
        ? ' (launch race like the one ' + 'the Windows runner reports: the process starts and the connection dies)'
        : ' (this failure is not a ' + 'launch race, retrying would not help)'
    }`,
  };
}

/** Resolve a request against this machine — the same call the MCP tools will make. */
export async function resolveBrowser(
  request: Parameters<typeof selectBrowser>[1],
): Promise<ResolvedConnection & { registry: Registry }> {
  const registry = await localRegistry({ readVersions: false });
  const resolved = selectBrowser(registry, request);
  return { ...resolved, registry };
}
