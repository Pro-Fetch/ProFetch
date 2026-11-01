import { describe, it, expect, vi } from 'vitest';
import { PRODUCTS, detectBrowsers, expandTokens, unsearchableOn } from '../src/core/browser-use-detect.js';
import type { DetectOptions } from '../src/core/browser-use-detect.js';

/**
 * Detection is filesystem and process observation, so it is injected rather than called: these tests
 * hand the module a fake `exists` and a fake version reader and never touch a disk or spawn a process.
 * A detection test that required Chrome to be installed would pass on one machine and skip on
 * another, and a skipped test in this category reads as "browser supported".
 */

const CHROME_WIN = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EDGE_WIN = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const FIREFOX_WIN = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';

function fakeOptions(over: Partial<DetectOptions> & { present: string[] }): DetectOptions {
  const { present, ...rest } = over;
  return {
    os: 'windows',
    exists: (p) => present.includes(p),
    ...rest,
  };
}

describe('finding browsers on Windows', () => {
  it('detects Chrome with its engine and channel', async () => {
    const found = await detectBrowsers(fakeOptions({ present: [CHROME_WIN] }));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      product: 'chrome',
      engine: 'chromium',
      family: 'chromium',
      channel: 'stable',
      os: 'windows',
      executablePath: CHROME_WIN,
      source: 'detected',
      present: true,
    });
  });

  it('finds every installed product, not just the first', async () => {
    const found = await detectBrowsers(fakeOptions({ present: [CHROME_WIN, EDGE_WIN, FIREFOX_WIN] }));
    expect(found.map((b) => b.product).sort()).toEqual(['chrome', 'edge', 'firefox']);
    expect(found.find((b) => b.product === 'firefox')!.engine).toBe('firefox');
  });

  it('returns nothing rather than guessing when no path matches', async () => {
    expect(await detectBrowsers(fakeOptions({ present: [] }))).toEqual([]);
  });
});

describe('environment tokens', () => {
  it('expands the Windows variables the candidate list uses', () => {
    expect(
      expandTokens('%LOCALAPPDATA%\\Google\\Chrome SxS\\Application\\chrome.exe', {
        LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
      }),
    ).toBe('C:\\Users\\u\\AppData\\Local\\Google\\Chrome SxS\\Application\\chrome.exe');
  });

  it('never probes a path whose token could not be expanded', async () => {
    const exists = vi.fn(() => true);
    await detectBrowsers({ os: 'windows', exists, env: {} });
    // A literal `%LOCALAPPDATA%\...` is not a file anyone has installed; probing it would be a bug
    // in the expander, and on some resolvers it becomes a relative path that exists by accident.
    for (const call of exists.mock.calls) expect(call[0]).not.toContain('%');
  });

  it('drops a token-only product when the variable is missing, and keeps an absolute one', async () => {
    const exists = vi.fn(() => true);
    const found = await detectBrowsers({ os: 'windows', exists, env: {} });
    const products = found.map((b) => b.product);
    expect(products).toContain('chrome'); // absolute Program Files candidate
    expect(products).not.toContain('chrome-canary'); // its only Windows path is %LOCALAPPDATA%...
    const withLocal = await detectBrowsers({
      os: 'windows',
      exists: vi.fn(() => true),
      env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
    });
    expect(withLocal.map((b) => b.product)).toContain('chrome-canary');
  });
});

describe('version reporting', () => {
  it('reads a major version from a product that answers --version', async () => {
    const found = await detectBrowsers(
      fakeOptions({
        present: [CHROME_WIN],
        readVersion: async () => 'Google Chrome 141.0.7396.99',
      }),
    );
    expect(found[0].version).toBe('Google Chrome 141.0.7396.99');
    expect(found[0].major).toBe(141);
  });

  it('does not ask Opera or Vivaldi for a version, and reports 0 rather than a guess', async () => {
    const readVersion = vi.fn(async () => 'whatever');
    const opera = 'C:\\Program Files\\Opera\\opera.exe';
    const found = await detectBrowsers(fakeOptions({ present: [opera], readVersion }));
    expect(found.map((b) => b.product)).toContain('opera');
    expect(readVersion.mock.calls.map((c) => c[0])).not.toContain(opera);
    const entry = found.find((b) => b.product === 'opera')!;
    expect(entry.version).toBe('');
    expect(entry.major).toBe(0);
  });

  it('keeps a browser detected when its version line cannot be read', async () => {
    const found = await detectBrowsers({
      os: 'windows',
      exists: (p) => p === CHROME_WIN,
      readVersion: async () => {
        throw new Error('spawn refused');
      },
    });
    expect(found).toHaveLength(1);
    expect(found[0].product).toBe('chrome');
    // Detected, but unusable for anything version-sensitive — and that is visible in the data.
    expect(found[0].version).toBe('');
    expect(found[0].major).toBe(0);
  });

  it('never probes a version for a product whose flag output is unreliable', async () => {
    const readVersion = vi.fn(async () => `Opera 114.0.5282.24`);
    await detectBrowsers(fakeOptions({ present: ['C:\\Program Files\\Opera\\opera.exe'], readVersion }));
    expect(readVersion).not.toHaveBeenCalled();
  });
});

describe('PATH lookup', () => {
  it('uses `which` on Linux where install paths vary by distribution', async () => {
    const found = await detectBrowsers({
      os: 'linux',
      exists: (p) => p === '/snap/bin/firefox',
      which: (name) => (name === 'firefox' ? '/snap/bin/firefox' : ''),
    });
    expect(found.map((b) => b.product)).toEqual(['firefox']);
  });
});

describe('the table is honest about what it cannot look for', () => {
  it('lists products with no candidate on this OS instead of reporting them absent', () => {
    const notOnWindows = unsearchableOn('windows');
    expect(notOnWindows).toContain('safari');
    expect(notOnWindows).toContain('safari-tech-preview');
    expect(notOnWindows).toContain('arc');
    // "we did not look" and "we looked and it is not there" are different sentences.
    expect(notOnWindows).not.toContain('chrome');
  });

  it('has a candidate list for every desktop OS it claims to support', () => {
    for (const spec of PRODUCTS) {
      const total = ['windows', 'macos', 'linux'].reduce(
        (sum, os) => sum + (spec.paths[os as 'windows']?.length ?? 0),
        0,
      );
      expect(total + spec.pathNames.length, spec.product).toBeGreaterThan(0);
    }
  });
});
