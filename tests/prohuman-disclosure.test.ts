import { describe, it, expect } from 'vitest';
import { parseDisclosure, writingAllowed, disclosureEcho, DisclosureError } from '../src/core/prohuman-disclosure.js';

/**
 * Disclosure is what separates this pack from a concealment tool, so it is tested as a rule and not as a
 * paragraph. The rule: a session that has not said who it is does not run, and a session that nobody
 * authorised does not touch the page.
 */

const good = {
  name: 'ProFetch demo',
  contact_url: 'https://pro-fetch.example/contact',
  purpose: 'testing my own documentation site',
};

describe('identity is required, and required means refused without it', () => {
  it('accepts a complete identity', () => {
    const d = parseDisclosure({ identity: good, consent: 'own-site' });
    expect(d.identity.name).toBe('ProFetch demo');
    expect(d.consent).toBe('own-site');
  });

  it('takes the identity fields at the top level too', () => {
    const d = parseDisclosure({ ...good, consent: 'authorized' });
    expect(d.identity.contact_url).toBe('https://pro-fetch.example/contact');
  });

  it('refuses a missing name, purpose or contact', () => {
    expect(() => parseDisclosure({ identity: { ...good, name: '  ' } })).toThrow(DisclosureError);
    expect(() => parseDisclosure({ identity: { ...good, purpose: '' } })).toThrow(/purpose is required/);
    expect(() => parseDisclosure({ identity: { ...good, contact_url: 'not-a-url' } })).toThrow(
      /must be an absolute http\(s\) URL/,
    );
    expect(() => parseDisclosure({ identity: { ...good, contact_url: 'ftp://example.com' } })).toThrow(
      /must be http\(s\)/,
    );
  });

  it('defaults to the most restrictive consent rather than the least', () => {
    expect(parseDisclosure({ identity: good }).consent).toBe('public-read-only');
  });

  it('refuses a consent it does not know', () => {
    expect(() => parseDisclosure({ identity: good, consent: 'probably-fine' })).toThrow(/consent must be one of/);
  });
});

describe('what a session may do follows from what was said', () => {
  it('public-read-only refuses every page-changing action', () => {
    const d = parseDisclosure({ identity: good, consent: 'public-read-only' });
    const verdict = writingAllowed(d);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/nobody with authority/);
  });

  it('own-site and authorized allow it', () => {
    expect(writingAllowed(parseDisclosure({ identity: good, consent: 'own-site' })).ok).toBe(true);
    expect(writingAllowed(parseDisclosure({ identity: good, consent: 'authorized' })).ok).toBe(true);
  });

  it('robots.txt outranks a claimed consent', () => {
    // The site's own statement beats the caller's assertion: consent is a claim, robots.txt is an answer.
    const d = parseDisclosure({
      identity: good,
      consent: 'authorized',
      robots: { allowed: false, reason: 'Disallow: /private', source: 'example.com/robots.txt' },
    });
    const verdict = writingAllowed(d);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/robots.txt at example.com\/robots.txt does not allow/);
  });

  it('an absent robots check is reported as absent, not as permission', () => {
    const echo = disclosureEcho(parseDisclosure({ identity: good, consent: 'own-site' }));
    expect(echo.robots).toEqual({ allowed: true, reason: 'not checked', source: 'not fetched' });
  });

  it('echoes who the session is on every answer', () => {
    const echo = disclosureEcho(parseDisclosure({ identity: good, consent: 'public-read-only' }));
    expect(echo.identity).toEqual(good);
    expect(echo.consent).toBe('public-read-only');
    expect(echo.can_write).toBe(false);
    expect(String(echo.cannot_write_reason)).toMatch(/observe and measure/);
    expect(String(echo.note)).toMatch(/does not conceal/);
  });
});
