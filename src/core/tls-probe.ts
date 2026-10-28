/**
 * A real TLS probe for `pro_fetch_security_tls_audit`.
 *
 * ## Why this file exists
 *
 * The action was named `tls_audit` and did HTTP header checks. Its own answer admitted it:
 * `is_tls_audit: false` plus five `not_checked` lines — expiry, chain, protocol, cipher, hostname
 * match. Honest, but still a tool whose name promises something it does not do: a host that asks
 * "is the certificate still valid?" gets a HSTS answer and has to notice the difference itself. A
 * security engineer driving the workflow hit exactly that and stopped the run rather than invent
 * evidence.
 *
 * ## What it does
 *
 * `tls.connect` to host:port with SNI (`servername`), read the peer certificate, protocol and
 * cipher, and parse it with `crypto.X509Certificate`. Nothing about the certificate is guessed:
 * expiry, issuer, SAN names and the fingerprint come from the parsed certificate, and the hostname
 * match is computed against the SAN list with the usual single-label wildcard rule.
 *
 * ## What it deliberately does not claim
 *
 * No revocation checking (OCSP/CRL), and the trust decision is Node's own root store reported via
 * `authorized`, not an independent chain build. Those stay listed in `not_checked`, because a
 * security report that quietly drops a limitation is worse than one that states it.
 *
 * SSRF: the caller's URL is passed through the same `assertSafeUrl` the fetch path uses before
 * this probe runs, so a private or special-purpose target is refused here too. This module does not
 * add a second, unguarded network path.
 */

import { X509Certificate } from 'node:crypto';
import { connect, type TLSSocket } from 'node:tls';

export interface TlsCertificateFacts {
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  daysRemaining: number;
  expired: boolean;
  expiresSoon: boolean;
  serial: string;
  fingerprint256: string;
  sanDns: string[];
}

export interface TlsFacts {
  ok: boolean;
  host: string;
  port: number;
  protocol: string | null;
  cipher: string | null;
  cipherBits: number | null;
  certificate: TlsCertificateFacts | null;
  hostnameMatches: boolean;
  authorized: boolean;
  authorizationError: string | null;
  warnings: string[];
  elapsedMs: number;
  error?: string;
}

const DAY_MS = 86_400_000;
/** How soon "still valid" stops being reassuring. */
const EXPIRES_SOON_DAYS = 21;

/** DNS names from a SAN list (`DNS:a.com, DNS:*.b.com`), lowercased, IP entries ignored. */
export function sanDnsNames(san: string | undefined): string[] {
  if (!san) return [];
  return san
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('DNS:'))
    .map((entry) => entry.slice(4).trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Certificate hostname match: exact, or a `*.` wildcard covering exactly one label.
 *
 * The one-label rule is what browsers do; matching `*.example.com` against `a.b.example.com` would
 * accept a certificate that a browser rejects, which is the wrong direction for a security tool.
 */
export function hostMatchesPattern(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (p === h) return true;
  if (!p.startsWith('*.')) return false;
  const suffix = p.slice(2);
  const dot = h.indexOf('.');
  if (dot <= 0) return false;
  return h.slice(dot + 1) === suffix && !h.slice(0, dot).includes('.');
}

/** Days left before expiry, negative when already expired. */
export function daysUntil(validTo: string, now = Date.now()): number {
  const end = Date.parse(validTo);
  if (!Number.isFinite(end)) return Number.NaN;
  return Math.floor((end - now) / DAY_MS);
}

function flattenDn(dn: string | undefined): string {
  // Distinguished names arrive multi-line; flatten them so they survive a JSON round trip readably.
  return (dn ?? '').split(String.fromCharCode(10)).join(', ');
}

function subjectOf(cert: X509Certificate): string {
  // `subject` is a multi-line DN; flatten it so it survives a JSON round trip readably.
  return (cert.subject ?? '').replace(/\n/g, ', ');
}

/**
 * Probe one https URL. Never throws: a failed handshake is a result (`ok: false`, `error` set),
 * because the caller is building a security report, not asking for an exception.
 */
export async function probeTls(rawUrl: string, timeoutMs = 8000): Promise<TlsFacts> {
  const started = Date.now();
  let host = '';
  let port = 443;
  try {
    const url = new URL(rawUrl);
    host = url.hostname;
    port = url.port ? Number(url.port) : 443;
    if (url.protocol !== 'https:') {
      return {
        ok: false,
        host,
        port,
        protocol: null,
        cipher: null,
        cipherBits: null,
        certificate: null,
        hostnameMatches: false,
        authorized: false,
        authorizationError: null,
        warnings: [],
        elapsedMs: Date.now() - started,
        error: `TLS uchun https kerak (hozir: ${url.protocol})`,
      };
    }
  } catch {
    return {
      ok: false,
      host,
      port,
      protocol: null,
      cipher: null,
      cipherBits: null,
      certificate: null,
      hostnameMatches: false,
      authorized: false,
      authorizationError: null,
      warnings: [],
      elapsedMs: Date.now() - started,
      error: 'URL yaroqsiz',
    };
  }

  return new Promise<TlsFacts>((resolve) => {
    const warnings: string[] = [];
    let settled = false;
    const finish = (facts: Omit<TlsFacts, 'elapsedMs'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...facts, elapsedMs: Date.now() - started });
    };

    // RFC 6066 forbids an IP literal as SNI (Node warns about it), so only DNS names are sent.
    const servername = /^[0-9.]+:[0-9:]+$/.test(host) || /^[0-9.]+$/.test(host) ? undefined : host;
    const socket: TLSSocket = connect({
      host,
      port,
      ...(servername ? { servername } : {}),
      timeout: timeoutMs,
      // The handshake is completed even for an untrusted chain so the certificate can be read and
      // reported; the verdict is `authorized` below, not a silent pass/fail.
      rejectUnauthorized: false,
    });
    const timer = setTimeout(() => {
      socket.destroy();
      finish({
        ok: false,
        host,
        port,
        protocol: null,
        cipher: null,
        cipherBits: null,
        certificate: null,
        hostnameMatches: false,
        authorized: false,
        authorizationError: null,
        warnings,
        error: `handshake ${timeoutMs} ms ichida tugamadi`,
      });
    }, timeoutMs + 500);

    socket.on('error', (error) => {
      socket.destroy();
      finish({
        ok: false,
        host,
        port,
        protocol: socket.getProtocol() ?? null,
        cipher: socket.getCipher()?.name ?? null,
        cipherBits: (socket.getCipher() as unknown as { bits?: number })?.bits ?? null,
        certificate: null,
        hostnameMatches: false,
        authorized: false,
        authorizationError: error.message,
        warnings,
        error: error.message,
      });
    });

    socket.on('secureConnect', () => {
      const raw = socket.getPeerCertificate(true);
      const cipher = socket.getCipher();
      const protocol = socket.getProtocol();
      if (!raw || !raw.raw) {
        socket.end();
        finish({
          ok: false,
          host,
          port,
          protocol: protocol ?? null,
          cipher: cipher?.name ?? null,
          cipherBits: (cipher as unknown as { bits?: number })?.bits ?? null,
          certificate: null,
          hostnameMatches: false,
          authorized: socket.authorized,
          authorizationError: socket.authorizationError?.toString() ?? 'no certificate',
          warnings,
          error: 'server sertifikat yubormadi',
        });
        return;
      }

      let parsed: X509Certificate;
      try {
        parsed = new X509Certificate(raw.raw);
      } catch (error) {
        socket.end();
        finish({
          ok: false,
          host,
          port,
          protocol: protocol ?? null,
          cipher: cipher?.name ?? null,
          cipherBits: (cipher as unknown as { bits?: number })?.bits ?? null,
          certificate: null,
          hostnameMatches: false,
          authorized: socket.authorized,
          authorizationError: socket.authorizationError?.toString() ?? null,
          warnings,
          error: `sertifikat o'qilmadi: ${(error as Error).message}`,
        });
        return;
      }

      const san = sanDnsNames(parsed.subjectAltName);
      const hostnameMatches = san.some((pattern) => hostMatchesPattern(host, pattern));
      const remaining = daysUntil(parsed.validTo);
      if (Number.isNaN(remaining)) warnings.push("sertifikat muddati o'qilmadi");
      if (remaining < 0) warnings.push('sertifikat muddati tugagan');
      else if (remaining <= EXPIRES_SOON_DAYS) warnings.push(`muddati ${remaining} kundan keyin tugaydi`);
      if (!hostnameMatches) warnings.push(`server nomi sertifikat ro'yxatida yo'q: ${host}`);
      if (!socket.authorized) warnings.push('ishonch zanjiri Node root store’iga tasdiqlanmagan');
      if (san.length === 0) warnings.push('SAN yo‘q: CN bilan tekshirish yetarli emas');

      socket.end();
      finish({
        ok: true,
        host,
        port,
        protocol: protocol ?? null,
        cipher: cipher?.name ?? null,
        cipherBits: (cipher as unknown as { bits?: number })?.bits ?? null,
        hostnameMatches,
        authorized: socket.authorized,
        authorizationError: socket.authorized ? null : (socket.authorizationError?.toString() ?? 'not authorized'),
        warnings,
        certificate: {
          subject: subjectOf(parsed),
          issuer: flattenDn(parsed.issuer),
          validFrom: parsed.validFrom,
          validTo: parsed.validTo,
          daysRemaining: remaining,
          expired: remaining < 0,
          expiresSoon: remaining >= 0 && remaining <= EXPIRES_SOON_DAYS,
          serial: parsed.serialNumber,
          fingerprint256: parsed.fingerprint256,
          sanDns: san,
        },
      });
    });
  });
}
