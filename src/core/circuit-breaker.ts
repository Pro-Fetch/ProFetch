/**
 * Deciding, per host, when to stop asking.
 *
 * ## What this is for
 *
 * A host that refuses to resolve, hangs, or resets the connection will keep refusing for a while, and every
 * retry costs the caller seconds and the host packets it did not ask for. The breaker exists for both sides:
 * the caller gets an instant, named answer instead of another timeout, and the host is not hammered by a
 * pipeline that cannot take a hint.
 *
 * ## What counts as a failure — and what emphatically does not
 *
 * Only transport-level faults count: DNS could not resolve, the connection was refused or reset, the request
 * timed out, TLS failed. Those say the host is not answering.
 *
 * An HTTP 404, a 403, a block page, a paywall or a rate-limit answer **is** an answer. Counting them would
 * open the circuit against exactly the hosts that are talking to us, and would turn a policy problem into a
 * network outage. A refusal is information; the breaker is not a way to punish it.
 *
 * ## Recovery
 *
 * After the cooldown the host goes half-open and one request is allowed through as a probe. Success closes
 * the circuit; failure re-opens it with a fresh cooldown, and the number of trips is kept so a caller can see
 * a host that keeps coming back broken rather than only the last one.
 *
 * ## Reporting
 *
 * `breakerState(host)` and `breakerReport()` are the observable half, used by the metrics tool. A breaker
 * nobody can inspect is a request that silently disappears.
 */

import { boundedEnv } from './bounded-env.js';

export type TransportClass =
  | 'dns_unresolvable'
  | 'timeout'
  | 'connection_refused'
  | 'connection_reset'
  | 'tls_failed'
  | 'socket_hang_up'
  | 'network_unreachable';

/** The whole taxonomy a fetch can end in, transport faults and answers alike. */
export type ErrorClass =
  | TransportClass
  | 'http_error'
  | 'blocked'
  | 'auth_wall'
  | 'rate_limited'
  | 'policy_refused'
  | 'too_large'
  | 'browser_unavailable'
  | 'unknown';

/** Transport faults are the only ones the breaker remembers. */
const TRANSPORT_CLASSES: ReadonlySet<string> = new Set<string>([
  'dns_unresolvable',
  'timeout',
  'connection_refused',
  'connection_reset',
  'tls_failed',
  'socket_hang_up',
  'network_unreachable',
  // Internal aliases the HTTP layer reports, kept so the mapping below has one source of truth.
  'DNS_ERROR',
  'HTTP_TIMEOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'TLS_ERROR',
  'EPIPE',
  'EHOSTUNREACH',
]);

/**
 * Map an error we already have to a class, from its message and code.
 *
 * The patterns are ordered from most specific to least, because Node's messages overlap: a TLS failure and a
 * reset both say "socket". An unrecognised error is reported as `unknown` rather than guessed into a class
 * that would either open a circuit or excuse one wrongly.
 */
export function classifyFetchError(error: unknown): ErrorClass {
  const message = (error instanceof Error ? error.message : String(error)) || '';
  const code = (error as { code?: string })?.code ?? '';
  const haystack = code + ' ' + message;
  if (/ENOTFOUND|EAI_AGAIN|resolve bo/i.test(haystack)) return 'dns_unresolvable';
  if (/TLS|CERT|UNABLE_TO_VERIFY|SELF_SIGNED|ssl/i.test(haystack)) return 'tls_failed';
  if (/ECONNREFUSED/i.test(haystack)) return 'connection_refused';
  if (/ECONNRESET|EPIPE|socket hang up|hang up/i.test(haystack))
    return /hang up/i.test(haystack) ? 'socket_hang_up' : 'connection_reset';
  if (/ETIMEDOUT|timeout|HTTP_TIMEOUT|AbortError/i.test(haystack)) return 'timeout';
  if (/EHOSTUNREACH|ENETUNREACH|network/i.test(haystack)) return 'network_unreachable';
  if (/too large|maxBytes|hajmi.*(osh|cheg)|MAX_BYTES/i.test(haystack)) return 'too_large';
  if (/playwright|browser|brauser/i.test(haystack)) return 'browser_unavailable';
  return 'unknown';
}

/** Whether this class is a reason to stop asking the host for a while. */
export function isTransportFailure(kind: ErrorClass | string): boolean {
  return TRANSPORT_CLASSES.has(kind);
}

export interface BreakerSettings {
  threshold: number;
  cooldownMs: number;
  enabled: boolean;
}

/**
 * Operator bounds. The threshold is deliberately small: three consecutive transport failures on one host is
 * already a pattern, and a higher number just means more timeouts before the caller learns anything.
 */
export function breakerSettings(): BreakerSettings {
  const flag = (process.env.PRO_FETCH_BREAKER_ENABLED ?? '').trim().toLowerCase();
  return {
    threshold: boundedEnv('PRO_FETCH_BREAKER_THRESHOLD', 3, 2, 20),
    cooldownMs: boundedEnv('PRO_FETCH_BREAKER_COOLDOWN_MS', 30_000, 1_000, 3_600_000),
    enabled: !(flag === '0' || flag === 'false'),
  };
}

interface HostState {
  failures: number;
  openedAt: number | null;
  /** Consecutive cooldowns this host has tripped — a host that keeps coming back is worth knowing about. */
  trips: number;
  lastClass: ErrorClass | null;
}

const hosts = new Map<string, HostState>();

function state(host: string): HostState {
  let entry = hosts.get(host);
  if (!entry) {
    entry = { failures: 0, openedAt: null, trips: 0, lastClass: null };
    hosts.set(host, entry);
  }
  return entry;
}

/**
 * Refuse a host that is not answering, or let a probe through.
 *
 * Returns `null` when the request may proceed. The refusal is a message, not a boolean: it has to say which
 * host, how many failures, and when asking again — otherwise the caller retries blindly.
 */
export function breakerRefusal(host: string, now = Date.now()): { retry_in_ms: number; failures: number } | null {
  const settings = breakerSettings();
  if (!settings.enabled) return null;
  const entry = state(host);
  if (entry.openedAt === null) return null;
  const elapsed = now - entry.openedAt;
  if (elapsed >= settings.cooldownMs) {
    // Half-open: the next request is the probe. `failures` is left one short of the threshold so a second
    // failure re-opens immediately, without a fresh streak of three being required.
    entry.openedAt = null;
    entry.failures = settings.threshold - 1;
    return null;
  }
  return { retry_in_ms: settings.cooldownMs - elapsed, failures: entry.failures };
}

/** Record a transport failure. The third consecutive one opens the circuit. */
export function recordFailure(host: string, kind: ErrorClass, now = Date.now()): void {
  const settings = breakerSettings();
  if (!settings.enabled || !isTransportFailure(kind)) return;
  const entry = state(host);
  entry.failures++;
  entry.lastClass = kind;
  if (entry.failures >= settings.threshold) {
    entry.openedAt = now;
    entry.trips++;
  }
}

/** Any answer — including an HTTP error — means the host is talking, so the streak is forgotten. */
export function recordSuccess(host: string): void {
  const entry = state(host);
  entry.failures = 0;
  entry.openedAt = null;
  entry.lastClass = null;
}

export interface BreakerHostReport {
  host: string;
  state: 'closed' | 'open' | 'half_open';
  failures: number;
  trips: number;
  last_class: ErrorClass | null;
  retry_in_ms: number | null;
}

/** The state of one host, as the caller would want it stated. */
export function breakerState(host: string, now = Date.now()): BreakerHostReport {
  const settings = breakerSettings();
  const entry = state(host);
  const open = entry.openedAt !== null && now - entry.openedAt < settings.cooldownMs;
  return {
    host,
    state: open ? 'open' : entry.failures >= settings.threshold - 1 && entry.lastClass ? 'half_open' : 'closed',
    failures: entry.failures,
    trips: entry.trips,
    last_class: entry.lastClass,
    retry_in_ms: open ? settings.cooldownMs - (now - (entry.openedAt as number)) : null,
  };
}

/** Every host with a history, worst first. */
export function breakerReport(): {
  enabled: boolean;
  threshold: number;
  cooldown_ms: number;
  hosts: number;
  open: number;
  entries: BreakerHostReport[];
} {
  const settings = breakerSettings();
  const now = Date.now();
  const entries = Array.from(hosts.keys())
    .map((host) => breakerState(host, now))
    .filter((entry) => entry.failures > 0 || entry.trips > 0)
    .sort((a, b) => b.failures - a.failures || b.trips - a.trips);
  return {
    enabled: settings.enabled,
    threshold: settings.threshold,
    cooldown_ms: settings.cooldownMs,
    hosts: hosts.size,
    open: entries.filter((entry) => entry.state === 'open').length,
    entries,
  };
}

/** Forget a host (or everything). Tests use it; so does an operator who fixed the DNS record. */
export function resetBreaker(host?: string): void {
  if (host) hosts.delete(host);
  else hosts.clear();
}
