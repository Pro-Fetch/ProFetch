/**
 * Browser product adapters.
 *
 * The brief is explicit that an adapter may share infrastructure but must not be a decorative
 * one-liner, and the survey shows what decorative looks like in practice: five Chromium browsers do
 * not need five engines, they need one protocol driver and five *launch and attach* behaviours that
 * genuinely differ. This file is those differences, and nothing else.
 *
 * What actually differs per product:
 *   - where its user-data directory lives (two Chromium products sharing one profile directory is a
 *     launch failure, not a cosmetic detail);
 *   - which flags it needs to be automatable at all, and which it merely tolerates;
 *   - how a debugging endpoint is exposed — Chromium takes `--remote-debugging-port`, Firefox does
 *     not speak CDP any more and is reached through Marionette instead;
 *   - whose version banner can be read at all (Opera, Vivaldi and Arc cannot be trusted here);
 *   - what is impossible from this platform, which is reported rather than worked around.
 */

import type {
  BrowserAdapter,
  BrowserEngine,
  BrowserProtocol,
  CapabilityAnswer,
  LaunchOptions,
  OperatingSystem,
  ResolvedConnection,
} from './browser-use-contract.js';
import { PRODUCTS } from './browser-use-detect.js';
import { profileFor } from './browser-use-capabilities.js';
import { validateAttachEndpoint } from './browser-use-registry.js';

export interface LaunchPlan {
  executablePath: string;
  args: string[];
  /** The profile directory this launch will use. Never a real user profile. */
  userDataDir: string;
  /** Environment the process needs beyond the inherited one. */
  env: Record<string, string>;
  /** Product-specific caveats worth telling the caller before launching. */
  notes: string[];
}

const spec = (product: string) => PRODUCTS.find((p) => p.product === product);

/**
 * A throwaway profile directory per product.
 *
 * Pointing an automated Chromium at a user's own `User Data` directory fails while that browser is
 * open, and worse — it would hand the automation the user's cookies, extensions and logged-in
 * sessions. Every plan gets its own directory under the caller's data root; anything else has to be
 * asked for explicitly.
 */
function profileDir(product: string, options: LaunchOptions, dataRoot: string): string {
  const base = options.userDataDir ?? dataRoot;
  return base.replace(/[/\\]$/, '') + '/' + 'pro-fetch-' + product;
}

const CHROMIUM_BASE = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-timer-throttling',
  '--disable-blink-features=AutomationControlled',
];

function chromiumPlan(product: string, options: LaunchOptions, dataRoot: string, extra: string[]): LaunchPlan {
  const userDataDir = profileDir(product, options, dataRoot);
  const args = [...CHROMIUM_BASE, `--user-data-dir=${userDataDir}`];
  if (options.debuggingPort) args.push(`--remote-debugging-port=${options.debuggingPort}`);
  if (options.headless) args.push('--headless=new');
  args.push(...extra, ...(options.args ?? []));
  return { executablePath: options.executablePath, args, userDataDir, env: {}, notes: [] };
}

function firefoxPlan(product: string, options: LaunchOptions, dataRoot: string): LaunchPlan {
  const userDataDir = profileDir(product, options, dataRoot);
  // Firefox 129 removed CDP support; the cross-vendor transport is WebDriver BiDi over Marionette.
  // Advertising a debugging port here would claim a protocol the browser cannot speak.
  const args = ['-no-remote', '-profile', userDataDir, '--marionette'];
  if (options.headless) args.push('-headless');
  args.push(...(options.args ?? []));
  return {
    executablePath: options.executablePath,
    args,
    userDataDir,
    env: {},
    notes: ['reached over WebDriver BiDi (Marionette), not CDP — Firefox 129+ removed CDP support'],
  };
}

abstract class BaseAdapter implements BrowserAdapter {
  abstract readonly product: string;
  abstract readonly label: string;
  abstract readonly family: 'chromium' | 'firefox' | 'webkit';
  abstract readonly engine: BrowserEngine;
  abstract readonly protocols: BrowserProtocol[];
  /** Whether `--version` yields a banner worth parsing. False means "we do not know its version". */
  protected versionByFlag = true;
  /** Flags this product needs beyond its engine's defaults. */
  protected extraArgs: string[] = [];

  candidates(os: OperatingSystem): string[] {
    return spec(this.product)?.paths[os] ?? [];
  }

  async version(executablePath: string): Promise<string> {
    if (!this.versionByFlag) return '';
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    try {
      const { stdout } = await promisify(execFile)(executablePath, ['--version'], { windowsHide: true, timeout: 8000 });
      return String(stdout).trim();
    } catch {
      // Chromium builds print a banner and exit; some builds exit non-zero while doing it. A version
      // that cannot be read stays unread rather than being invented from a launcher message.
      return '';
    }
  }

  launchArgs(options: LaunchOptions): string[] {
    try {
      return this.plan(options, process.env.LOCALAPPDATA ?? process.env.APPDATA ?? '.').args;
    } catch {
      return [];
    }
  }

  capabilities(): CapabilityAnswer[] {
    return profileFor(this.product)?.answers ?? [];
  }

  attach(endpoint: string): ResolvedConnection {
    const verdict = validateAttachEndpoint(endpoint);
    const browser = {
      product: this.product,
      label: this.label,
      family: this.family,
      engine: this.engine,
      channel: spec(this.product)?.channel ?? 'stable',
      os: (process.platform === 'win32'
        ? 'windows'
        : process.platform === 'darwin'
          ? 'macos'
          : 'linux') as OperatingSystem,
      device: 'desktop' as const,
      version: '',
      major: 0,
      executablePath: '',
      source: 'caller' as const,
      present: true,
    };
    return verdict.ok
      ? { ok: true, browser, mode: 'native', protocol: this.protocols.includes('cdp') ? 'cdp' : this.protocols[0] }
      : { ok: false, browser, blocker: verdict.reason };
  }

  abstract plan(options: LaunchOptions, dataRoot: string): LaunchPlan;
}

class ChromiumAdapter extends BaseAdapter {
  readonly family = 'chromium' as const;
  readonly engine: BrowserEngine = 'chromium';
  readonly protocols: BrowserProtocol[] = ['playwright-chromium', 'cdp'];
  constructor(
    readonly product: string,
    readonly label: string,
    extra: string[] = [],
    versionByFlag = true,
    readonly limitation?: string,
  ) {
    super();
    this.extraArgs = extra;
    this.versionByFlag = versionByFlag;
  }
  plan(options: LaunchOptions, dataRoot: string): LaunchPlan {
    const plan = chromiumPlan(this.product, options, dataRoot, this.extraArgs);
    if (this.limitation) plan.notes.push(this.limitation);
    return plan;
  }
}

class FirefoxAdapter extends BaseAdapter {
  readonly family = 'firefox' as const;
  readonly engine: BrowserEngine = 'firefox';
  readonly protocols: BrowserProtocol[] = ['playwright-firefox', 'bidi', 'webdriver'];
  constructor(
    readonly product: string,
    readonly label: string,
  ) {
    super();
  }
  plan(options: LaunchOptions, dataRoot: string): LaunchPlan {
    return firefoxPlan(this.product, options, dataRoot);
  }
}

/**
 * Safari is not launchable from here, and says so.
 *
 * `safaridriver` is macOS-only and needs a user-enabled automation port. Producing a plausible command
 * line from a Windows host is the exact failure the brief forbids — a managed browser dressed up as
 * native support — so this adapter throws and the caller reports the limitation.
 */
class SafariAdapter extends BaseAdapter {
  readonly family = 'webkit' as const;
  readonly engine: BrowserEngine = 'webkit';
  readonly protocols: BrowserProtocol[] = ['safaridriver', 'webdriver'];
  protected versionByFlag = false;
  constructor(
    readonly product: string,
    readonly label: string,
  ) {
    super();
  }
  plan(): LaunchPlan {
    throw new Error(
      'Safari automation requires macOS with the automation port enabled (`safaridriver --enable`). ' +
        'It cannot be launched from this host, and no substitute browser is started in its place.',
    );
  }
  launchArgs(): string[] {
    return [];
  }
}

export const ADAPTERS: BrowserAdapter[] = [
  new ChromiumAdapter('chrome', 'Google Chrome'),
  new ChromiumAdapter('chrome-beta', 'Google Chrome Beta'),
  new ChromiumAdapter('chrome-dev', 'Google Chrome Dev'),
  new ChromiumAdapter('chrome-canary', 'Google Chrome Canary'),
  new ChromiumAdapter('chromium', 'Chromium'),
  new ChromiumAdapter('edge', 'Microsoft Edge'),
  new ChromiumAdapter('edge-beta', 'Microsoft Edge Beta'),
  new ChromiumAdapter('edge-dev', 'Microsoft Edge Dev'),
  new ChromiumAdapter('edge-canary', 'Microsoft Edge Canary'),
  new ChromiumAdapter(
    'brave',
    'Brave',
    ['--disable-brave-update'],
    true,
    'Brave Shields can drop sub-resources before the driver observes them; a missing request is not proof the page did not ask for it',
  ),
  new ChromiumAdapter(
    'opera',
    'Opera',
    ['--disable-feature=autoupdate'],
    false,
    'version banner is not reliable across releases',
  ),
  new ChromiumAdapter(
    'opera-gx',
    'Opera GX',
    ['--disable-feature=autoupdate'],
    false,
    'version banner is not reliable across releases',
  ),
  new ChromiumAdapter('vivaldi', 'Vivaldi', [], false, 'version banner is not reliable across releases'),
  new ChromiumAdapter('arc', 'Arc', [], false, 'no documented remote-debugging endpoint; launch support is unverified'),
  new FirefoxAdapter('firefox', 'Mozilla Firefox'),
  new FirefoxAdapter('firefox-esr', 'Mozilla Firefox ESR'),
  new FirefoxAdapter('firefox-developer', 'Firefox Developer Edition'),
  new FirefoxAdapter('firefox-nightly', 'Firefox Nightly'),
  new SafariAdapter('safari', 'Apple Safari'),
  new SafariAdapter('safari-tech-preview', 'Safari Technology Preview'),
];

export function adapterFor(product: string): BrowserAdapter | undefined {
  return ADAPTERS.find((a) => a.product === product);
}

/** Build a launch plan for a product, or explain why there is none. */
export function planFor(
  product: string,
  options: LaunchOptions,
  dataRoot: string,
): { ok: true; plan: LaunchPlan } | { ok: false; reason: string } {
  const adapter = adapterFor(product);
  if (!adapter) {
    return {
      ok: false,
      reason: `No adapter for "${product}". Detected products without an adapter are reported, not guessed at.`,
    };
  }
  try {
    return {
      ok: true,
      plan: (adapter as unknown as { plan(o: LaunchOptions, d: string): LaunchPlan }).plan(options, dataRoot),
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
