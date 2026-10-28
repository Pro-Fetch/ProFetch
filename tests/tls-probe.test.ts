/**
 * The TLS probe, which exists because `pro_fetch_security_tls_audit` was auditing headers and
 * admitting it (`is_tls_audit: false`). A security engineer driving the workflow stopped rather than
 * report a header check as a certificate check, so the tool now does the handshake.
 *
 * The pure rules (SAN parsing, wildcard hostname match, days remaining) are checked on their own;
 * the probe itself is checked against a real host and against the cases that must fail safe.
 */

import { describe, it, expect } from 'vitest';
import '../src/loader.js';
import { dispatch } from '../src/core/tool.js';
import { daysUntil, hostMatchesPattern, probeTls, sanDnsNames } from '../src/core/tls-probe.js';

const text = (result: { content?: Array<{ type: string; text?: string }> }) =>
  (result.content ?? []).map((item) => item.text ?? '').join(' ');

describe('tls probe rules', () => {
  it('reads DNS names out of a SAN list', () => {
    expect(sanDnsNames('DNS:Example.COM, DNS:*.api.example.com, IP Address:1.2.3.4')).toEqual([
      'example.com',
      '*.api.example.com',
    ]);
    expect(sanDnsNames(undefined)).toEqual([]);
    expect(sanDnsNames('IP Address:1.2.3.4')).toEqual([]);
  });

  it('matches a wildcard against exactly one label, like browsers do', () => {
    expect(hostMatchesPattern('a.example.com', '*.example.com')).toBe(true);
    expect(hostMatchesPattern('example.com', '*.example.com')).toBe(false);
    // Accepting a two-label name for a single-label wildcard is the classic over-match a security
    // tool must not make: it would pass a certificate a browser rejects.
    expect(hostMatchesPattern('a.b.example.com', '*.example.com')).toBe(false);
    expect(hostMatchesPattern('EXAMPLE.com', 'example.com')).toBe(true);
    expect(hostMatchesPattern('example.com.evil.test', 'example.com')).toBe(false);
  });

  it('counts days to expiry and reports a missing date as NaN', () => {
    const future = new Date(Date.now() + 30 * 86_400_000).toUTCString();
    expect(daysUntil(future)).toBeGreaterThanOrEqual(29);
    expect(daysUntil(new Date(Date.now() - 5 * 86_400_000).toUTCString())).toBeLessThan(0);
    expect(Number.isNaN(daysUntil('not a date'))).toBe(true);
  });
});

describe('tls probe failures', () => {
  it('refuses to call an http URL a TLS audit', async () => {
    const facts = await probeTls('http://example.com/');
    expect(facts.ok).toBe(false);
    expect(facts.error).toContain('https');
  });

  it('fails safe on a garbage URL and an unreachable host', async () => {
    expect((await probeTls('not-a-url')).ok).toBe(false);
    const dead = await probeTls('https://127.0.0.1:9/', 1500);
    expect(dead.ok).toBe(false);
    expect(typeof dead.error).toBe('string');
  });
});

describe('tls probe against a real host', () => {
  it('reads protocol, cipher and certificate from the handshake', async (context) => {
    const facts = await probeTls('https://example.com/', 12_000);
    // A live handshake needs the network and someone else's DNS; this suite must not become a
    // connectivity monitor. When the host cannot be reached at all the case is skipped by name, and
    // the pure rules above stay strict either way.
    if (!facts.ok && /ENOTFOUND|EAI_|timed out|ECONNREFUSED|ETIMEDOUT/.test(facts.error ?? '')) {
      context.skip();
      return;
    }
    expect(facts.ok, facts.error ?? '').toBe(true);
    expect(facts.protocol).toMatch(/^TLSv1\.[23]$/);
    expect(facts.cipher).toBeTruthy();
    expect(facts.certificate).not.toBeNull();
    expect(facts.certificate!.sanDns.map((name) => name.toLowerCase())).toContain('example.com');
    expect(facts.hostnameMatches).toBe(true);
    expect(facts.certificate!.expired).toBe(false);
    expect(facts.certificate!.daysRemaining).toBeGreaterThan(0);
    expect(facts.certificate!.validTo).toBeTruthy();
    expect(facts.elapsedMs).toBeGreaterThan(0);
  });

  it('reports the certificate facts through the tool, not only in the module', async (context) => {
    const res = await dispatch('pro_fetch_security_tls_audit', { url: 'https://example.com/' });
    const body = text(res);
    if (/DNS host manziliga resolve bo/.test(body)) {
      context.skip();
      return;
    }
    expect(res.isError, body).not.toBe(true);
    expect(body).toContain('"is_tls_audit": true');
    expect(body).toContain('"validTo"');
    // The certificate verdict sits beside the header lists, not inside them.
    expect(body).toContain('"certificate_checks"');
    expect(body).not.toContain('"headers_present": ["certificateValid');
    // What genuinely remains unchecked shrinks to revocation and independent chain building.
    expect(body).toContain('OCSP');
    expect(body).not.toContain('shifrlash algoritmi (cipher suite)');
  });
});
