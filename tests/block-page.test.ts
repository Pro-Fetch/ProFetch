import { describe, it, expect } from 'vitest';
import { COMPAT_USER_AGENT, classifyBlockPage, compatUaEnabled } from '../src/core/block-page.js';

/**
 * A block page is a refusal, not an answer.
 *
 * Every fixture here is a string a real host actually sent back on 2026-11-05, captured by running the
 * tool against it — not a paraphrase. The ResearchGate case is the reason this test exists: the page
 * writes "We’ve detected unusual activity" with a typographic apostrophe, the first pattern used a
 * straight one, and a 21 KB Cloudflare challenge was reported as a user-agent filter, which sent the
 * retry ladder chasing a header that was never the problem.
 */

const RESEARCHGATE = `
Access restricted
We’ve detected unusual activity from your network.
Access to this page has been restricted. Please check your network settings.
`;

const AKAMAI = `Access Denied
You don't have permission to access "http://www.akamai.com/" on this server.
Reference #18.bccf2d8b.1793871521.23f4c1a`;

const NSA = `Access Denied
You don't have permission to access "http://www.nsa.gov/Portals/75/documents/Cybersecurity/CSI_MCP_SECURITY.pdf" on this server.
Reference #18.66d81502.1793871522.71e64b`;

describe('a refusal is named, not served as content', () => {
  it('leaves a real answer alone', () => {
    expect(classifyBlockPage(200, {}, '<html><body>the article</body></html>')).toBe(null);
    expect(classifyBlockPage(404, {}, 'not found')).toBe(null);
  });

  it('recognises the Cloudflare challenge from the body, apostrophe and all', () => {
    const block = classifyBlockPage(403, {}, RESEARCHGATE);
    expect(block?.kind).toBe('cloudflare_challenge');
    // A new user-agent does not move a network-reputation challenge; claiming otherwise is a lie
    // that costs an extra request and hides the real remedy.
    expect(block?.ua_sensitive).toBe(false);
    expect(block?.hint).toContain('brauzer dvigateli');
  });

  it('recognises Cloudflare from headers alone, when the page wording changes', () => {
    const block = classifyBlockPage(
      403,
      { server: 'cloudflare', 'cf-ray': '8f0a1b2c3d4e5678' },
      'some new interstitial',
    );
    expect(block?.kind).toBe('cloudflare_challenge');
  });

  it('recognises the Akamai edge denial, which IS a user-agent filter', () => {
    for (const body of [AKAMAI, NSA]) {
      const block = classifyBlockPage(403, {}, body);
      expect(block?.kind).toBe('edge_denied');
      expect(block?.ua_sensitive).toBe(true);
      expect(block?.hint).toContain('PRO_FETCH_HTTP_COMPAT_UA');
    }
  });

  it('never calls an unrecognised refusal a success', () => {
    const block = classifyBlockPage(403, { server: 'something-else' }, '<html>no known markers at all</html>');
    expect(block).not.toBe(null);
    expect(block?.marker).toContain('noma');
    expect(block?.kind).toBe('edge_denied');
  });

  it('separates rate limiting and legal blocks from bot filtering', () => {
    expect(classifyBlockPage(429, {}, 'Too Many Requests')?.kind).toBe('rate_limited');
    expect(classifyBlockPage(429, {}, 'nothing recognisable')?.kind).toBe('rate_limited');
    expect(classifyBlockPage(451, {}, 'Unavailable For Legal Reasons')?.kind).toBe('legal_block');
    expect(classifyBlockPage(403, {}, 'The requested URL was blocked by a security policy')?.kind).toBe('waf_blocked');
  });

  it('does not let a 451 be treated as a Cloudflare challenge by its headers', () => {
    // The header shortcut exists for interstitials; a legal block is a legal block whatever served it.
    expect(classifyBlockPage(451, { server: 'cloudflare' }, 'Unavailable For Legal Reasons')?.kind).toBe('legal_block');
  });
});

describe('the compat user-agent is opt-in and says what it is', () => {
  it('is off unless the operator turns it on', () => {
    delete process.env.PRO_FETCH_HTTP_COMPAT_UA;
    expect(compatUaEnabled()).toBe(false);
    process.env.PRO_FETCH_HTTP_COMPAT_UA = '1';
    expect(compatUaEnabled()).toBe(true);
    process.env.PRO_FETCH_HTTP_COMPAT_UA = 'true';
    expect(compatUaEnabled()).toBe(true);
    process.env.PRO_FETCH_HTTP_COMPAT_UA = '0';
    expect(compatUaEnabled()).toBe(false);
    delete process.env.PRO_FETCH_HTTP_COMPAT_UA;
  });

  it('names a browser and a version, which is what the two hosts asked for', () => {
    expect(COMPAT_USER_AGENT).toMatch(/^Mozilla\/5\.0 .*Chrome\/\d+/);
  });
});
