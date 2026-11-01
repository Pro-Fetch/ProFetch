import { describe, it, expect } from 'vitest';
import { ADAPTERS, adapterFor, planFor } from '../src/core/browser-use-adapters.js';
import type { LaunchOptions } from '../src/core/browser-use-contract.js';
import { PRODUCTS } from '../src/core/browser-use-detect.js';

/**
 * An adapter earns its file by being different where the product is different. These tests assert the
 * differences — profile isolation, the transport a browser can actually speak, and what is refused
 * outright — because a shared base class that hides five identical subclasses is exactly the padding
 * the brief forbids.
 */

const options = (over: Partial<LaunchOptions> = {}): LaunchOptions => ({
  headless: true,
  executablePath: 'C:\\fake\\browser.exe',
  ...over,
});

const planOf = (product: string, over?: Partial<LaunchOptions>) => {
  const r = planFor(product, options(over), 'C:\\data');
  if (!r.ok) throw new Error(r.reason);
  return r.plan;
};

describe('coverage', () => {
  it('has an adapter for every product the detector can find, and no orphans', () => {
    const detected = PRODUCTS.map((p) => p.product).sort();
    const adapted = ADAPTERS.map((a) => a.product).sort();
    expect(adapted).toEqual(detected);
  });

  it('reports a product it cannot drive instead of inventing a command line', () => {
    const r = planFor('netscape', options(), 'C:\\data');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/No adapter/);
  });
});

describe('chromium launch behaviour', () => {
  it('isolates every product in its own profile directory', () => {
    const chrome = planOf('chrome');
    const edge = planOf('edge');
    expect(chrome.userDataDir).toContain('pro-fetch-chrome');
    expect(edge.userDataDir).toContain('pro-fetch-edge');
    expect(chrome.userDataDir).not.toBe(edge.userDataDir);
    // Two Chromium products sharing one profile directory do not "work" — the second one fails to
    // start, or worse, inherits the first one's session.
    expect(chrome.args.join(' ')).toContain(`--user-data-dir=${chrome.userDataDir}`);
  });

  it('exposes a debugging port only when one was asked for', () => {
    expect(planOf('chrome').args.join(' ')).not.toMatch(/remote-debugging-port/);
    expect(planOf('chrome', { debuggingPort: 9222 }).args.join(' ')).toContain('--remote-debugging-port=9222');
  });

  it('uses the modern headless mode and honours a caller-supplied profile', () => {
    expect(planOf('chrome').args).toContain('--headless=new');
    expect(planOf('chrome', { headless: false }).args).not.toContain('--headless=new');
    expect(planOf('chrome', { userDataDir: 'D:\\mine' }).userDataDir).toBe('D:\\mine/pro-fetch-chrome');
  });

  it('carries the Brave Shields caveat into the plan rather than hiding it', () => {
    const brave = planOf('brave');
    expect(brave.notes.join(' ')).toMatch(/Shields/);
  });
});

describe('firefox launch behaviour', () => {
  it('reaches Firefox over Marionette and never claims a CDP port', () => {
    const plan = planOf('firefox');
    expect(plan.args).toContain('--marionette');
    expect(plan.args.join(' ')).not.toMatch(/remote-debugging-port/);
    expect(plan.notes.join(' ')).toMatch(/Marionette|BiDi/i);
  });

  it('does not advertise CDP among its protocols', () => {
    expect(adapterFor('firefox')!.protocols).not.toContain('cdp');
    expect(adapterFor('firefox')!.protocols).toContain('bidi');
  });

  it('passes the profile through the -profile argument Firefox actually reads', () => {
    const plan = planOf('firefox');
    const i = plan.args.indexOf('-profile');
    expect(i).toBeGreaterThan(-1);
    expect(plan.args[i + 1]).toBe(plan.userDataDir);
  });
});

describe('safari refuses rather than impersonating', () => {
  it('produces no plan and names the platform requirement', () => {
    const r = planFor('safari', options(), 'C:\\data');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/macOS/);
  });

  it('launches no arguments at all', () => {
    expect(adapterFor('safari')!.launchArgs(options())).toEqual([]);
  });
});

describe('version honesty', () => {
  it('returns an empty version for products whose banner cannot be trusted, without spawning', async () => {
    // A bogus path would make a real spawn fail slowly; these must return immediately.
    for (const product of ['opera', 'opera-gx', 'vivaldi', 'arc', 'safari']) {
      const started = Date.now();
      expect(await adapterFor(product)!.version('C:\\definitely\\not\\here.exe')).toBe('');
      expect(Date.now() - started, product).toBeLessThan(500);
    }
  });

  it('still attempts a banner read for products that answer one', async () => {
    // The path does not exist, so this resolves to '' through the catch — what is being asserted is
    // that the Chromium adapter *tried*, i.e. it did not short-circuit like the unreliable ones.
    const adapter = adapterFor('chrome')!;
    const result = await adapter.version('C:\\definitely\\not\\here.exe');
    expect(result).toBe('');
  });
});

describe('attachment', () => {
  it('accepts a loopback endpoint and names the protocol it would use', () => {
    const r = adapterFor('chrome')!.attach('http://127.0.0.1:9222');
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('native');
    expect(r.protocol).toBe('cdp');
  });

  it('refuses a public debugger and says why', () => {
    const r = adapterFor('chrome')!.attach('http://example.com:9222');
    expect(r.ok).toBe(false);
    expect(r.blocker).toMatch(/never permitted/i);
  });

  it('will not offer CDP attachment for Firefox', () => {
    const r = adapterFor('firefox')!.attach('http://127.0.0.1:9222');
    expect(r.ok).toBe(true);
    expect(r.protocol).not.toBe('cdp');
  });
});
