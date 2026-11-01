import { describe, it, expect } from 'vitest';
import {
  ALL_CAPABILITIES,
  CAPABILITY_PROFILES,
  capabilityOf,
  missingFor,
  profileFor,
  supports,
} from '../src/core/browser-use-capabilities.js';
import type { CapabilityAnswer, CapabilityStatus } from '../src/core/browser-use-contract.js';
import { parseMajor } from '../src/core/browser-use-contract.js';

/**
 * The capability layer is a set of claims, and a claim nobody checks is exactly how the surveyed
 * products got into trouble: marketing numbers with no artifact, a cache that only exists in the paid
 * tier, URL validation switched off by default. These tests do not check that files exist — they check
 * that the matrix cannot say something indefensible.
 */

const PRODUCTS = Object.keys(CAPABILITY_PROFILES);

describe('the matrix has no blanks', () => {
  it('knows every product the registry claims to support', () => {
    // Adding a product without giving it a profile is how "supported" quietly becomes a guess.
    expect(PRODUCTS.length).toBeGreaterThanOrEqual(20);
    for (const p of [
      'chrome',
      'edge',
      'brave',
      'opera-gx',
      'vivaldi',
      'firefox',
      'firefox-nightly',
      'safari',
      'webkit',
    ]) {
      expect(PRODUCTS).toContain(p);
    }
  });

  it.each(PRODUCTS)('%s answers every capability exactly once', (product) => {
    const profile = profileFor(product)!;
    const seen = profile.answers.map((a) => a.capability);
    const duplicates = seen.filter((c, i) => seen.indexOf(c) !== i);
    expect(duplicates).toEqual([]);
    for (const capability of ALL_CAPABILITIES) {
      expect(seen, `${product} is silent about ${capability}`).toContain(capability);
    }
  });
});

describe('every answer can justify itself', () => {
  it.each(PRODUCTS)('%s gives a reason wherever it does not say yes', (product) => {
    const yes: CapabilityStatus[] = ['VERIFIED_NATIVE', 'VERIFIED_MANAGED', 'PARTIALLY_VERIFIED'];
    for (const a of profileFor(product)!.answers) {
      if (yes.includes(a.status)) continue;
      expect(a.reason.trim().length, `${product}.${a.capability} (${a.status}) has no reason`).toBeGreaterThan(10);
    }
  });

  it('does not let UNKNOWN claim evidence stronger than an inference', () => {
    const offenders: string[] = [];
    for (const product of PRODUCTS) {
      for (const a of profileFor(product)!.answers) {
        // UNKNOWN plus 'inferred' is honest: something in the specification suggests the answer and
        // nobody has run it. UNKNOWN plus 'documented' or 'source-confirmed' is a contradiction — it
        // says the evidence was read and still produced no answer.
        if (a.status === 'UNKNOWN' && a.evidence !== 'unknown' && a.evidence !== 'inferred')
          offenders.push(`${product}.${a.capability}=${a.evidence}`);
        if (a.status === 'UNSUPPORTED' && a.evidence === 'unknown')
          offenders.push(`${product}.${a.capability} unsupported-but-unchecked`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('does not claim anything is verified on this machine yet', () => {
    // Phase 3 writes profiles from specifications and source reading. A VERIFIED_* status means a run
    // happened, and none has yet — so if one appears here, it appeared without an experiment behind it.
    // Phase 4 is expected to make this test fail on purpose, and to update it with the evidence.
    const claimed: string[] = [];
    for (const product of PRODUCTS) {
      for (const a of profileFor(product)!.answers) {
        if (a.status === 'VERIFIED_NATIVE' || a.status === 'VERIFIED_MANAGED')
          claimed.push(`${product}.${a.capability}`);
      }
    }
    expect(claimed).toEqual([]);
  });
});

describe('the protocol facts the design rests on', () => {
  it('Firefox cannot give an accessibility tree, and says why', () => {
    const a = capabilityOf('firefox', 'accessibilityTree')!;
    expect(a.status).toBe('UNSUPPORTED');
    expect(a.reason).toMatch(/accessibility module/i);
  });

  it('Chromium can give one, over CDP', () => {
    const a = capabilityOf('chrome', 'accessibilityTree')!;
    expect(a.via).toBe('cdp');
    expect(a.status).not.toBe('UNSUPPORTED');
  });

  it('WebSocket traffic is refused as a capability everywhere, because this process cannot intercept it', () => {
    for (const product of PRODUCTS) {
      const a = capabilityOf(product, 'websockets')!;
      expect(a.status, product).toBe('UNSUPPORTED');
    }
  });

  it('Safari is blocked by environment on a Windows host, never reported as working', () => {
    const profile = profileFor('safari')!;
    const working = profile.answers.filter((a: CapabilityAnswer) =>
      ['VERIFIED_NATIVE', 'VERIFIED_MANAGED', 'PARTIALLY_VERIFIED'].includes(a.status),
    );
    expect(working.map((a) => a.capability)).toEqual([]);
    expect(capabilityOf('safari', 'launch')!.status).toBe('BLOCKED_BY_ENVIRONMENT');
    expect(capabilityOf('safari', 'attachToRunning')!.status).toBe('UNSUPPORTED');
  });

  it('Android Firefox does not inherit a Chromium transport', () => {
    const profile = profileFor('android-firefox')!;
    expect(profile.engine).toBe('firefox');
    expect(profile.protocols).not.toContain('cdp');
    expect(capabilityOf('android-firefox', 'accessibilityTree')!.status).toBe('UNSUPPORTED');
  });

  it('BiDi Firefox cannot be promised a full-page screenshot', () => {
    expect(capabilityOf('firefox', 'screenshotFullPage')!.status).toBe('UNSUPPORTED');
  });
});

describe('selection refuses what was never checked', () => {
  it('UNKNOWN is a no, even when partial evidence is accepted', () => {
    const r = supports('arc', 'launch', { allowPartial: true });
    expect(r.yes).toBe(false);
    expect(r.answer?.status).toBe('UNKNOWN');
  });

  it('PARTIALLY_VERIFIED is a yes only when the caller allows it', () => {
    expect(supports('chrome', 'accessibilityTree').yes).toBe(false);
    expect(supports('chrome', 'accessibilityTree', { allowPartial: true }).yes).toBe(true);
  });

  it('a protocol filter cannot be talked around', () => {
    // Chrome over BiDi is not Chrome over CDP: asking for one must not get the other's answer.
    expect(supports('chrome', 'accessibilityTree', { allowPartial: true, via: 'bidi' }).yes).toBe(false);
  });

  it('names exactly what Firefox loses for an accessibility-driven task', () => {
    expect(missingFor('firefox', ['accessibilityTree', 'hitTesting', 'screenshotFullPage'])).toEqual([
      'accessibilityTree',
      'hitTesting',
      'screenshotFullPage',
    ]);
    expect(missingFor('chrome', ['accessibilityTree', 'hitTesting', 'screenshotFullPage'])).toEqual(['hitTesting']);
  });
});

describe('version parsing', () => {
  it('reads the major from the strings browsers actually print', () => {
    expect(parseMajor('141.0.7396.99')).toBe(141);
    expect(parseMajor('Mozilla Firefox 129.0.1')).toBe(129); // a banner line still carries the version
    expect(parseMajor(' 130.0 ')).toBe(130);
    expect(parseMajor('')).toBe(0);
    expect(parseMajor('beta')).toBe(0);
  });
});
