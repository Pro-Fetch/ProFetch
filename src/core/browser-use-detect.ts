/**
 * Installed-browser discovery.
 *
 * The engine cannot claim to support a browser it cannot find, and the survey showed how that
 * becomes a lie: Stagehand's `findChromePath` is a hand-maintained candidate list with an explicit
 * "not supported on this platform" branch, and browser-use's channel list stops at the four Chromium
 * builds it ships. Neither is wrong — they are just narrow, and narrowness is only honest when it is
 * visible.
 *
 * So this module is built to be *testable without a browser*: it takes an existence probe and a
 * version reader as parameters. The unit tests hand it fakes and never touch the filesystem, which
 * matters because a detection test that requires Chrome to be installed is a test that reports
 * `passed` on one machine and `skipped` on another, and a skipped test here reads as a supported
 * browser.
 */

import type { BrowserEngine, BrowserFamily, DetectedBrowser, OperatingSystem } from './browser-use-contract.js';
import { parseMajor } from './browser-use-contract.js';

export interface ProductSpec {
  product: string;
  label: string;
  family: BrowserFamily;
  engine: BrowserEngine;
  channel: string;
  /** Absolute candidate paths per desktop OS. Empty means "not expected on that platform". */
  paths: Partial<Record<OperatingSystem, string[]>>;
  /** Executable names to look for on PATH (Linux, and Windows as a fallback). */
  pathNames: string[];
  /**
   * Whether `--version` prints a version line without opening a window.
   *
   * Chromium builds and Firefox do. Opera and Vivaldi are inconsistent across releases, and Arc does
   * not expose a CLI at all — pretending otherwise produces a detected browser with a fabricated
   * version.
   */
  versionByFlag: boolean;
}

export const PRODUCTS: ProductSpec[] = [
  {
    product: 'chrome',
    label: 'Google Chrome',
    family: 'chromium',
    engine: 'chromium',
    channel: 'stable',
    paths: {
      windows: [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        '%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe',
      ],
      macos: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
      linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'],
    },
    pathNames: ['google-chrome', 'google-chrome-stable', 'chrome'],
    versionByFlag: true,
  },
  {
    product: 'chrome-beta',
    label: 'Google Chrome Beta',
    family: 'chromium',
    engine: 'chromium',
    channel: 'beta',
    paths: {
      windows: ['C:\\Program Files\\Google\\Chrome Beta\\Application\\chrome.exe'],
      macos: ['/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta'],
      linux: ['/usr/bin/google-chrome-beta'],
    },
    pathNames: ['google-chrome-beta'],
    versionByFlag: true,
  },
  {
    product: 'chrome-dev',
    label: 'Google Chrome Dev',
    family: 'chromium',
    engine: 'chromium',
    channel: 'dev',
    paths: {
      windows: ['C:\\Program Files\\Google\\Chrome Dev\\Application\\chrome.exe'],
      macos: ['/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev'],
      linux: ['/usr/bin/google-chrome-unstable'],
    },
    pathNames: ['google-chrome-unstable'],
    versionByFlag: true,
  },
  {
    product: 'chrome-canary',
    label: 'Google Chrome Canary',
    family: 'chromium',
    engine: 'chromium',
    channel: 'canary',
    paths: {
      windows: ['%LOCALAPPDATA%\\Google\\Chrome SxS\\Application\\chrome.exe'],
      macos: ['/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'],
    },
    pathNames: [],
    versionByFlag: true,
  },
  {
    product: 'chromium',
    label: 'Chromium',
    family: 'chromium',
    engine: 'chromium',
    channel: 'stable',
    paths: {
      windows: ['%LOCALAPPDATA%\\Chromium\\Application\\chrome.exe'],
      macos: ['/Applications/Chromium.app/Contents/MacOS/Chromium'],
      linux: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
    },
    pathNames: ['chromium', 'chromium-browser'],
    versionByFlag: true,
  },
  {
    product: 'edge',
    label: 'Microsoft Edge',
    family: 'chromium',
    engine: 'chromium',
    channel: 'stable',
    paths: {
      windows: [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      ],
      macos: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
      linux: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'],
    },
    pathNames: ['microsoft-edge', 'msedge'],
    versionByFlag: true,
  },
  {
    product: 'edge-beta',
    label: 'Microsoft Edge Beta',
    family: 'chromium',
    engine: 'chromium',
    channel: 'beta',
    paths: {
      windows: ['C:\\Program Files (x86)\\Microsoft\\Edge Beta\\Application\\msedge.exe'],
      macos: ['/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta'],
      linux: ['/usr/bin/microsoft-edge-beta'],
    },
    pathNames: ['microsoft-edge-beta'],
    versionByFlag: true,
  },
  {
    product: 'edge-dev',
    label: 'Microsoft Edge Dev',
    family: 'chromium',
    engine: 'chromium',
    channel: 'dev',
    paths: {
      windows: ['C:\\Program Files (x86)\\Microsoft\\EdgeDev\\Application\\msedge.exe'],
      macos: ['/Applications/Microsoft Edge Dev.app/Contents/MacOS/Microsoft Edge Dev'],
      linux: ['/usr/bin/microsoft-edge-dev'],
    },
    pathNames: ['microsoft-edge-dev'],
    versionByFlag: true,
  },
  {
    product: 'edge-canary',
    label: 'Microsoft Edge Canary',
    family: 'chromium',
    engine: 'chromium',
    channel: 'canary',
    paths: {
      windows: ['%LOCALAPPDATA%\\Microsoft\\Edge SxS\\Application\\msedge.exe'],
      macos: ['/Applications/Microsoft Edge Canary.app/Contents/MacOS/Microsoft Edge Canary'],
    },
    pathNames: [],
    versionByFlag: true,
  },
  {
    product: 'brave',
    label: 'Brave',
    family: 'chromium',
    engine: 'chromium',
    channel: 'stable',
    paths: {
      windows: ['C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
      macos: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
      linux: ['/usr/bin/brave-browser', '/usr/bin/brave'],
    },
    pathNames: ['brave-browser', 'brave'],
    versionByFlag: true,
  },
  {
    product: 'opera',
    label: 'Opera',
    family: 'chromium',
    engine: 'chromium',
    channel: 'stable',
    paths: {
      windows: ['%PROGRAMFILES%\\Programs\\Opera\\opera.exe', 'C:\\Program Files\\Opera\\opera.exe'],
      macos: ['/Applications/Opera.app/Contents/MacOS/Opera'],
      linux: ['/usr/bin/opera'],
    },
    pathNames: ['opera'],
    // Opera's --version output has changed shape across releases; report the version as unknown
    // rather than guessing from a string that may be a launcher banner.
    versionByFlag: false,
  },
  {
    product: 'opera-gx',
    label: 'Opera GX',
    family: 'chromium',
    engine: 'chromium',
    channel: 'stable',
    paths: { windows: ['%LOCALAPPDATA%\\Programs\\Opera GX\\opera.exe'] },
    pathNames: [],
    versionByFlag: false,
  },
  {
    product: 'vivaldi',
    label: 'Vivaldi',
    family: 'chromium',
    engine: 'chromium',
    channel: 'stable',
    paths: {
      windows: ['C:\\Program Files\\Vivaldi\\Application\\vivaldi.exe'],
      macos: ['/Applications/Vivaldi.app/Contents/MacOS/Vivaldi'],
      linux: ['/usr/bin/vivaldi', '/usr/bin/vivaldi-stable'],
    },
    pathNames: ['vivaldi', 'vivaldi-stable'],
    versionByFlag: false,
  },
  {
    product: 'arc',
    label: 'Arc',
    family: 'chromium',
    engine: 'chromium',
    channel: 'stable',
    paths: { macos: ['/Applications/Arc.app/Contents/MacOS/Arc'] },
    pathNames: [],
    versionByFlag: false,
  },
  {
    product: 'firefox',
    label: 'Mozilla Firefox',
    family: 'firefox',
    engine: 'firefox',
    channel: 'stable',
    paths: {
      windows: [
        'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
        'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
      ],
      macos: ['/Applications/Firefox.app/Contents/MacOS/firefox'],
      linux: ['/usr/bin/firefox', '/snap/bin/firefox', '/usr/lib/firefox/firefox'],
    },
    pathNames: ['firefox'],
    versionByFlag: true,
  },
  {
    product: 'firefox-esr',
    label: 'Mozilla Firefox ESR',
    family: 'firefox',
    engine: 'firefox',
    channel: 'esr',
    paths: {
      windows: ['C:\\Program Files\\Mozilla Firefox ESR\\firefox.exe'],
      linux: ['/usr/bin/firefox-esr'],
    },
    pathNames: ['firefox-esr'],
    versionByFlag: true,
  },
  {
    product: 'firefox-developer',
    label: 'Firefox Developer Edition',
    family: 'firefox',
    engine: 'firefox',
    channel: 'developer',
    paths: {
      windows: ['C:\\Program Files\\Firefox Developer Edition\\firefox.exe'],
      macos: ['/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox'],
      linux: ['/usr/bin/firefox-trunk'],
    },
    pathNames: ['firefox-dev', 'firefox-trunk'],
    versionByFlag: true,
  },
  {
    product: 'firefox-nightly',
    label: 'Firefox Nightly',
    family: 'firefox',
    engine: 'firefox',
    channel: 'nightly',
    paths: {
      windows: ['C:\\Program Files\\Firefox Nightly\\firefox.exe'],
      macos: ['/Applications/Firefox Nightly.app/Contents/MacOS/firefox'],
      linux: ['/usr/bin/firefox-nightly'],
    },
    pathNames: ['firefox-nightly'],
    versionByFlag: true,
  },
  {
    product: 'safari',
    label: 'Apple Safari',
    family: 'webkit',
    engine: 'webkit',
    channel: 'stable',
    paths: { macos: ['/Applications/Safari.app/Contents/MacOS/Safari'] },
    pathNames: [],
    // Safari cannot be driven from its own binary; automation goes through `safaridriver`, which
    // must be enabled by the user on macOS. Recording the app path here is not a capability claim.
    versionByFlag: false,
  },
  {
    product: 'safari-tech-preview',
    label: 'Safari Technology Preview',
    family: 'webkit',
    engine: 'webkit',
    channel: 'preview',
    paths: {
      macos: ['/Applications/Safari Technology Preview.app/Contents/MacOS/Safari Technology Preview'],
    },
    pathNames: [],
    versionByFlag: false,
  },
];

/** Expands the handful of environment tokens Windows paths actually use. */
export function expandTokens(input: string, env: Record<string, string | undefined>): string {
  return input.replace(/%([A-Z_]+)%/g, (_whole, name: string) => env[name] ?? '');
}

/**
 * Expand a candidate, or return an empty string when any token is unresolved.
 *
 * Substituting an empty string is the trap: `%LOCALAPPDATA%\\Google\\Chrome SxS\\Application\\chrome.exe`
 * becomes `\\Google\\Chrome SxS\\...`, which is a *relative* path, which a permissive existence probe
 * can answer true for. The detection test that caught this asserted "no probe may receive a `%`"
 * and still passed, because by then the token was gone — the failure was silent by construction.
 */
export function expandCandidate(input: string, env: Record<string, string | undefined>): string {
  let missing = false;
  const out = input.replace(/%([A-Z_]+)%/g, (_whole, name: string) => {
    const value = env[name];
    if (!value) {
      missing = true;
      return '';
    }
    return value;
  });
  return missing ? '' : out;
}

export interface DetectOptions {
  os: OperatingSystem;
  /** Does this path exist? Injected so tests never touch the disk. */
  exists: (path: string) => boolean;
  /** Read a version line from an executable. Injected so tests never spawn a process. */
  readVersion?: (executablePath: string) => Promise<string>;
  /** Resolve a PATH lookup. Injected for the same reason. */
  which?: (name: string) => string;
  env?: Record<string, string | undefined>;
}

/**
 * Every browser this machine appears to have, with how confident each field is.
 *
 * A product found on disk but whose version could not be read is reported with `version: ''` and
 * `major: 0`, not with a guessed number: the support matrix downstream distinguishes "installed"
 * from "tested", and a fabricated version would erase that line.
 */
export async function detectBrowsers(options: DetectOptions): Promise<DetectedBrowser[]> {
  const env = options.env ?? process.env;
  const found: DetectedBrowser[] = [];
  for (const spec of PRODUCTS) {
    const candidates = [
      ...(spec.paths[options.os] ?? []).map((p) => expandCandidate(p, env as Record<string, string | undefined>)),
      ...(options.os === 'linux' || options.os === 'windows'
        ? options.which
          ? spec.pathNames.map(options.which)
          : []
        : []),
    ].filter((p) => p && !p.includes('%'));

    let executablePath = '';
    for (const candidate of candidates) {
      if (candidate && options.exists(candidate)) {
        executablePath = candidate;
        break;
      }
    }
    if (!executablePath) continue;

    let version = '';
    if (spec.versionByFlag && options.readVersion) {
      try {
        const raw = await options.readVersion(executablePath);
        if (typeof raw === 'string') version = raw.trim();
      } catch {
        // A version that cannot be read is a missing fact, not a missing browser. The executable is
        // still reported, with major 0, which the selection layer treats as "do not prefer this one
        // unless the caller asked for it by path" — dropping it here would turn a failed version
        // probe into the claim that the browser is not installed.
        version = '';
      }
    }
    found.push({
      product: spec.product,
      label: spec.label,
      family: spec.family,
      engine: spec.engine,
      channel: spec.channel,
      os: options.os,
      device: 'desktop',
      version,
      major: parseMajor(version),
      executablePath,
      source: 'detected',
      present: true,
    });
  }
  return found;
}

/** Products the table knows about that have no path entry for this OS — reported, not hidden. */
export function unsearchableOn(os: OperatingSystem): string[] {
  return PRODUCTS.filter((spec) => !(spec.paths[os]?.length ?? 0) && spec.pathNames.length === 0).map(
    (spec) => spec.product,
  );
}
