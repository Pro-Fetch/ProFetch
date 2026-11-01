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
import type { DetectedBrowser, LaunchOptions, OperatingSystem, ResolvedConnection } from './browser-use-contract.js';
import { detectBrowsers } from './browser-use-detect.js';
import { ADAPTERS, adapterFor, planFor, type LaunchPlan } from './browser-use-adapters.js';
import { buildRegistry, selectBrowser } from './browser-use-registry.js';
import { unsearchableOn } from './browser-use-detect.js';
import type { Registry } from './browser-use-registry.js';

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
  options: { headless?: boolean; dataRoot: string; debuggingPort?: number; extraArgs?: string[] } = { dataRoot: '.' },
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
  try {
    const playwright = await import('playwright');
    const launcher = engine === 'firefox' ? playwright.firefox : playwright.chromium;
    // `--user-data-dir` is rejected by `launch()` — Playwright owns that switch there. Profile
    // isolation is expressed by launching a persistent context at the directory the adapter chose,
    // which is the same guarantee in the API that supports it.
    const args = plan.args.filter((a) => !a.startsWith('--user-data-dir'));
    const context = await launcher.launchPersistentContext(plan.userDataDir, {
      executablePath: plan.executablePath,
      headless: options.headless ?? true,
      args,
      timeout: 45_000,
    } as never);
    const browser = context.browser();
    return {
      ok: true,
      session: {
        product,
        executablePath: plan.executablePath,
        userDataDir: plan.userDataDir,
        notes: plan.notes,
        browser: browser as unknown as ManagedSession['browser'],
        context,
      },
    };
  } catch (error) {
    return { ok: false, reason: `${adapter.label} launch failed: ${(error as Error).message}` };
  }
}

/** Resolve a request against this machine — the same call the MCP tools will make. */
export async function resolveBrowser(
  request: Parameters<typeof selectBrowser>[1],
): Promise<ResolvedConnection & { registry: Registry }> {
  const registry = await localRegistry({ readVersions: false });
  const resolved = selectBrowser(registry, request);
  return { ...resolved, registry };
}
