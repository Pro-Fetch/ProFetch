import { describe, it, expect } from 'vitest';
import { buildRegistry, selectBrowser, validateAttachEndpoint } from '../src/core/browser-use-registry.js';
import type { DetectedBrowser } from '../src/core/browser-use-contract.js';

/**
 * Selection is where "universal browser support" becomes a claim with consequences: a wrong answer
 * here is a task running on the wrong engine, or a debugger port opened to the wrong network. Every
 * case below is offline — the registry is built from hand-written detection records, never from this
 * machine's actual installs, so the assertions hold on any host.
 */

function browser(over: Partial<DetectedBrowser> & { product: string }): DetectedBrowser {
  return {
    label: over.product,
    family: 'chromium',
    engine: 'chromium',
    channel: 'stable',
    os: 'windows',
    device: 'desktop',
    version: '141.0.0.0',
    major: 141,
    executablePath: 'C:\\fake\\' + over.product + '.exe',
    source: 'detected',
    present: true,
    ...over,
  } as DetectedBrowser;
}

const CHROME = browser({ product: 'chrome' });
const FIREFOX = browser({ product: 'firefox', family: 'firefox', engine: 'firefox', label: 'Mozilla Firefox' });
const SAFARI = browser({ product: 'safari', family: 'webkit', engine: 'webkit', os: 'macos', label: 'Apple Safari' });

const registry = buildRegistry([CHROME, FIREFOX, SAFARI]);

describe('registry construction', () => {
  it('keeps products it can describe and names the ones it cannot', () => {
    const built = buildRegistry([CHROME, browser({ product: 'netscape' })]);
    expect(built.entries.map((e) => e.browser.product)).toEqual(['chrome']);
    expect(built.unmapped).toEqual(['netscape']);
  });

  it('carries the "we did not look here" list through to the caller', () => {
    expect(buildRegistry([CHROME], ['safari']).unsearchable).toEqual(['safari']);
  });
});

describe('capability-aware selection', () => {
  it('gives Chromium to an accessibility-tree task and says over which protocol', () => {
    const r = selectBrowser(registry, { product: 'chrome', requires: ['accessibilityTree'] });
    expect(r.ok).toBe(true);
    expect(r.protocol).toBe('cdp');
  });

  it('refuses Firefox for an accessibility-tree task and explains the protocol gap', () => {
    const r = selectBrowser(registry, { product: 'firefox', requires: ['accessibilityTree'] });
    expect(r.ok).toBe(false);
    expect(r.blocker).toMatch(/accessibility module/i);
    // The alternative is offered with its cost named, not as a quiet swap.
    expect(r.alternatives?.some((a) => a.browser === 'chrome' && a.loses.length === 0)).toBe(true);
  });

  it('never substitutes when the caller named a product', () => {
    const r = selectBrowser(registry, { product: 'firefox', requires: ['accessibilityTree'] });
    expect(r.ok).toBe(false);
    expect(r.browser?.product).toBe('firefox');
  });

  it('refuses a browser that is not installed, listing what is', () => {
    const r = selectBrowser(buildRegistry([CHROME]), { product: 'brave' });
    expect(r.ok).toBe(false);
    expect(r.blocker).toMatch(/brave was not found/);
    expect(r.blocker).toMatch(/chrome/);
  });

  it('will not claim native attachment before an experiment proves it', () => {
    // attachToRunning is PARTIALLY_VERIFIED for Chromium (read from the protocol, not run here), and
    // native mode is the one case that refuses partial evidence: attaching to a user's real profile is
    // not something to attempt on the strength of a specification.
    const r = selectBrowser(registry, { product: 'chrome', mode: 'native' });
    expect(r.ok).toBe(false);
    expect(r.blocker).toMatch(/cannot be attached/i);
    expect(r.alternatives?.[0]?.loses).toContain('attachToRunning');
  });

  it('does not reject a browser whose version could not be read', () => {
    const unknown = browser({ product: 'chrome', version: '', major: 0 });
    const r = selectBrowser(buildRegistry([unknown]), { product: 'chrome', minMajor: 120 });
    // major 0 means "we do not know", which is reported elsewhere; silently hiding the browser would
    // be a worse failure than selecting it and letting the version check happen at launch.
    expect(r.ok).toBe(true);
  });

  it('rejects a browser whose known version is too old', () => {
    const old = browser({ product: 'chrome', version: '90.0.0.0', major: 90 });
    const r = selectBrowser(buildRegistry([old]), { product: 'chrome', minMajor: 120 });
    expect(r.ok).toBe(false);
  });

  it('never returns a protocol the profile does not advertise', () => {
    for (const request of [
      { product: 'chrome' },
      { product: 'firefox' },
      { product: 'safari' },
      { requires: ['screenshotViewport'] },
    ]) {
      const r = selectBrowser(registry, request);
      if (!r.ok || !r.protocol) continue;
      const entry = registry.entries.find((e) => e.browser.product === r.browser!.product)!;
      expect(entry.protocols, r.browser!.product).toContain(r.protocol);
    }
  });
});

describe('native attach endpoints', () => {
  it('accepts loopback, which is the normal debugging-port case', () => {
    for (const url of [
      'http://127.0.0.1:9222',
      'http://localhost:9222/json/version',
      'ws://[::1]:9222/devtools/browser',
    ]) {
      const v = validateAttachEndpoint(url);
      expect(v.ok, url).toBe(true);
    }
  });

  it('refuses a private network endpoint without an explicit opt-in', () => {
    const v = validateAttachEndpoint('http://10.0.0.5:9222');
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/opt-in/i);
    expect(validateAttachEndpoint('http://10.0.0.5:9222', { allowRemote: true }).ok).toBe(true);
  });

  it('refuses a public endpoint even with the opt-in, because that is not automation', () => {
    expect(validateAttachEndpoint('http://example.com:9222', { allowRemote: true }).ok).toBe(false);
  });

  it('honours an explicit allowlist of hosts', () => {
    expect(
      validateAttachEndpoint('http://build-agent.internal:9222', { allowedHosts: ['build-agent.internal'] }).ok,
    ).toBe(true);
  });

  it('refuses credentials, wrong schemes and malformed input', () => {
    expect(validateAttachEndpoint('http://user:pass@127.0.0.1:9222').ok).toBe(false);
    expect(validateAttachEndpoint('file:///tmp/devtools').ok).toBe(false);
    expect(validateAttachEndpoint('not a url').ok).toBe(false);
    expect(validateAttachEndpoint('http://127.0.0.1:99999').ok).toBe(false);
  });

  it('reports the cloud metadata address as a private host, not as a page URL', () => {
    const v = validateAttachEndpoint('http://169.254.169.254:9222');
    expect(v.ok).toBe(false);
    expect(v.host).toBe('169.254.169.254');
  });
});
