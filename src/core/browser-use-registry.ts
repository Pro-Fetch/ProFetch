/**
 * The browser registry and the capability-aware connection resolver.
 *
 * Two jobs, one file, because they answer the same question from two sides: *can this request be
 * honoured on this machine, and if not, what exactly is missing*.
 *
 * The rule the project brief is emphatic about — do not silently substitute a browser when the
 * requested one matters to the task — is the reason this is not a one-line filter. A refusal has to
 * carry the blocker, and an alternative has to carry what it loses. Stagehand is the cautionary
 * example: its cache only exists in the paid tier, so a "faster" local run and a cached cloud run are
 * different products wearing one name. Silent substitution creates exactly that class of measurement
 * error.
 *
 * The second reason is security. A native debugging endpoint is a loopback port that executes
 * arbitrary JavaScript in a real user profile. The SSRF guard that protects every *page* this server
 * visits would reject `http://127.0.0.1:9222` — and it must, because that is a page-fetch rule. The
 * attach path is different: loopback is the *expected* case, and anything beyond loopback has to be an
 * explicit operator decision. `validateAttachEndpoint` encodes that split instead of reusing the page
 * rule and getting it wrong in both directions.
 */

import type {
  BrowserRequest,
  CapabilityAnswer,
  DetectedBrowser,
  ResolvedConnection,
  ConnectionMode,
  BrowserProtocol,
} from './browser-use-contract.js';
import { ALL_CAPABILITIES, capabilityOf, missingFor, profileFor } from './browser-use-capabilities.js';

export interface RegistryEntry {
  browser: DetectedBrowser;
  /** Protocols this product can actually be driven over, from its capability profile. */
  protocols: BrowserProtocol[];
  capabilities: CapabilityAnswer[];
}

export interface Registry {
  entries: RegistryEntry[];
  /** Products detected on disk but with no capability profile — reported, never selected. */
  unmapped: string[];
  /** Products the detector cannot even look for on this OS. */
  unsearchable: string[];
}

/** Build the registry from a detection run. Entries without a profile are kept visible. */
export function buildRegistry(detected: DetectedBrowser[], unsearchable: string[] = []): Registry {
  const entries: RegistryEntry[] = [];
  const unmapped: string[] = [];
  for (const browser of detected) {
    const profile = profileFor(browser.product);
    if (!profile) {
      unmapped.push(browser.product);
      continue;
    }
    entries.push({ browser, protocols: profile.protocols, capabilities: profile.answers });
  }
  return { entries, unmapped, unsearchable };
}

function good(status: CapabilityAnswer['status'], allowPartial: boolean): boolean {
  const verified: CapabilityAnswer['status'][] = ['VERIFIED_NATIVE', 'VERIFIED_MANAGED'];
  return allowPartial ? [...verified, 'PARTIALLY_VERIFIED'].includes(status) : verified.includes(status);
}

function entrySupports(
  entry: RegistryEntry,
  capability: (typeof ALL_CAPABILITIES)[number],
  options: { allowPartial: boolean; via?: BrowserProtocol },
): CapabilityAnswer | undefined {
  const answer = entry.capabilities.find((a) => a.capability === capability);
  if (!answer) return undefined;
  if (options.via && answer.via && answer.via !== options.via) return undefined;
  return good(answer.status, options.allowPartial) ? answer : undefined;
}

/**
 * Choose a browser for a request.
 *
 * Selection is strict about the requested *product*: if the caller named `firefox` and the installed
 * Firefox cannot satisfy a required capability, the answer is a refusal that says so, with a managed
 * alternative listed and its losses named. Only when the caller asked for no specific product does the
 * resolver pick among what is installed.
 */
export function selectBrowser(
  registry: Registry,
  request: BrowserRequest,
  options: { allowPartial?: boolean } = {},
): ResolvedConnection {
  const allowPartial = options.allowPartial ?? true;
  const requires = request.requires ?? [];

  const matches = registry.entries.filter((entry) => {
    const b = entry.browser;
    if (request.product && b.product !== request.product) return false;
    if (request.channel && b.channel !== request.channel) return false;
    if (request.engine && b.engine !== request.engine) return false;
    if (request.os && b.os !== request.os) return false;
    if (request.device && b.device !== request.device) return false;
    if (request.minMajor && b.major > 0 && b.major < request.minMajor) return false;
    if (request.executablePath && b.executablePath !== request.executablePath) return false;
    return true;
  });

  if (matches.length === 0) {
    const named = request.product ?? request.engine ?? 'any supported browser';
    const present = registry.entries.map((e) => e.browser.product);
    return {
      ok: false,
      blocker:
        `No installed browser matches "${named}". Detected: ` +
        (present.length ? present.join(', ') : 'none') +
        (request.product && !present.includes(request.product)
          ? ` — ${request.product} was not found on this machine`
          : ''),
      alternatives: registry.entries.slice(0, 5).map((e) => ({
        browser: e.browser.product,
        mode: 'managed' as ConnectionMode,
        protocol: e.protocols[0],
        loses: missingFor(e.browser.product, requires),
      })),
    };
  }

  // Native attachment is a property of the browser, not of the caller's wish.
  const wantNative = request.mode === 'native';
  const candidates = matches.map((entry) => {
    const missing = requires.filter((c) => !entrySupports(entry, c, { allowPartial, via: request.protocol }));
    const attach = entrySupports(entry, 'attachToRunning', { allowPartial: false, via: request.protocol });
    return { entry, missing, attach: !!attach };
  });

  if (wantNative) {
    const attachable = candidates.filter((c) => c.attach && c.missing.length === 0);
    if (attachable.length === 0) {
      const first = candidates[0];
      const answer = capabilityOf(first.entry.browser.product, 'attachToRunning');
      const managed = candidates.find((c) => c.missing.length === 0);
      return {
        ok: false,
        browser: first.entry.browser,
        blocker:
          `${first.entry.browser.label} cannot be attached to as requested` +
          (answer ? `: ${answer.reason}` : '') +
          '. A managed instance is a different thing and is not offered as a silent substitute.',
        alternatives: managed
          ? [
              {
                browser: managed.entry.browser.product,
                mode: 'managed',
                protocol: managed.entry.protocols[0],
                loses: ['attachToRunning'],
              },
            ]
          : [],
      };
    }
    const chosen = attachable[0];
    return {
      ok: true,
      browser: chosen.entry.browser,
      mode: 'native',
      protocol: request.protocol ?? chosen.entry.protocols[0],
    };
  }

  const usable = candidates.filter((c) => c.missing.length === 0);
  if (usable.length === 0) {
    const closest = candidates.reduce((a, b) => (a.missing.length <= b.missing.length ? a : b));
    return {
      ok: false,
      browser: closest.entry.browser,
      blocker:
        `${closest.entry.browser.label} is installed but cannot satisfy ` +
        closest.missing
          .map((c) => {
            const a = closest.entry.capabilities.find((x) => x.capability === c);
            return `${c} (${a ? a.status + ': ' + a.reason : 'no profile entry'})`;
          })
          .join('; '),
      alternatives: registry.entries
        .map((e) => ({
          browser: e.browser.product,
          mode: 'managed' as ConnectionMode,
          protocol: e.protocols[0],
          loses: missingFor(e.browser.product, requires),
        }))
        .filter((a) => a.loses.length === 0 && a.browser !== closest.entry.browser.product)
        .slice(0, 3),
    };
  }

  // Prefer the caller's protocol, then the entry that loses the least.
  usable.sort((a, b) => a.missing.length - b.missing.length);
  const chosen = usable[0].entry;
  const protocol =
    request.protocol ??
    chosen.protocols.find((p) => chosen.capabilities.some((c) => good(c.status, allowPartial) && c.via === p)) ??
    chosen.protocols[0];
  return { ok: true, browser: chosen.browser, mode: 'managed', protocol };
}

export interface EndpointPolicy {
  /** Allow a non-loopback host. Off by default; a remote debugger executes JS in a real profile. */
  allowRemote?: boolean;
  /** Hosts explicitly permitted even when not loopback. */
  allowedHosts?: string[];
}

export interface EndpointVerdict {
  ok: boolean;
  reason: string;
  host?: string;
  port?: number;
  scheme?: string;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:']);

function isPrivateAddress(host: string): boolean {
  // Deliberately narrow: this is a debugger-endpoint rule, not the page-fetch SSRF guard. It answers
  // "is this an internal address", and the page guard remains the authority for everything a browser
  // actually navigates to.
  if (host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('127.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (host.startsWith('169.254.')) return true;
  if (host.toLowerCase().endsWith('.local') || host.toLowerCase().endsWith('.internal')) return true;
  return false;
}

/**
 * Validate a native-attach endpoint.
 *
 * Loopback is allowed: that is the normal case for `--remote-debugging-port`. Anything else is an
 * operator decision — a private network address needs `allowRemote`, and a public host is refused
 * outright, because a debugging endpoint on the internet is not a browser connection, it is a remote
 * code execution channel into somebody's profile. Credentials in the URL are refused for the same
 * reason the page guard refuses them.
 */
export function validateAttachEndpoint(raw: string, policy: EndpointPolicy = {}): EndpointVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `Attach endpoint is not a valid URL: ${raw.slice(0, 120)}` };
  }
  if (!SCHEMES.has(url.protocol)) {
    return {
      ok: false,
      reason: `Unsupported endpoint scheme "${url.protocol.slice(0, -1)}" — expected http, https, ws or wss`,
    };
  }
  if (url.username || url.password) {
    return {
      ok: false,
      reason: 'Credentials in an attach endpoint are refused; configure the endpoint, not a user in the URL',
    };
  }
  const host = url.hostname.toLowerCase();
  const port = url.port ? Number(url.port) : url.protocol === 'wss:' || url.protocol === 'https:' ? 443 : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, reason: `Endpoint port is out of range: ${url.port}`, host };
  }
  if (LOOPBACK.has(host))
    return { ok: true, reason: 'loopback debugging endpoint', host, port, scheme: url.protocol.slice(0, -1) };
  if (policy.allowedHosts?.includes(host)) {
    return { ok: true, reason: 'host explicitly allowed by policy', host, port, scheme: url.protocol.slice(0, -1) };
  }
  if (isPrivateAddress(host)) {
    return policy.allowRemote
      ? {
          ok: true,
          reason: 'private network endpoint permitted by explicit policy',
          host,
          port,
          scheme: url.protocol.slice(0, -1),
        }
      : {
          ok: false,
          reason:
            'Private-network debugging endpoints need an explicit opt-in. A remote debugger executes arbitrary JavaScript in a real browser profile.',
          host,
          port,
        };
  }
  return {
    ok: false,
    reason:
      'Public attach endpoints are never permitted: a debugging port on a public address is remote code execution, not automation.',
    host,
    port,
  };
}
