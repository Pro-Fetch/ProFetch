/**
 * Distinguishing "our code is wrong" from "the internet did not answer".
 *
 * Five suites in this repo call live third parties (Socrata portals, GitHub, example.com, a TLS
 * handshake) because the behaviour under test only exists against a real endpoint — a stubbed 429
 * proves the handler can parse a 429, nothing more. The cost showed up as builds that failed under
 * parallel load with `getaddrinfo ENOTFOUND`, which is a fact about the network, not about the code.
 *
 * So: a connectivity failure skips the case **by name**, and everything else still fails. An HTTP
 * 4xx/5xx from a host that answered is a product signal and is never skipped here — that is the
 * difference between a flaky suite and a blind one.
 */

const CONNECTIVITY = [
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ERR_NETWORK',
  'socket hang up',
  'Could not resolve host',
  'timed out',
  'LIVE_ENDPOINT_UNAVAILABLE',
  'DNS host manziliga resolve bo',
];

export function isConnectivityFailure(text: string): boolean {
  return CONNECTIVITY.some((marker) => text.includes(marker));
}

export type SkipFn = (() => void) | ((reason: string) => void);

/** Skip the running test when the answer says the network, not the code, is at fault. */
export function skipIfUnreachable(skip: SkipFn | undefined, text: string, what: string): boolean {
  if (!isConnectivityFailure(text)) return false;
  console.log(`SKIPPED (connectivity): ${what}`);
  if (skip) skip();
  return true;
}

/**
 * Can this host be reached at all right now?
 *
 * A response of any status means yes — a 403 from GitHub is a product question this suite answers.
 * Only a failure to reach the host counts as offline.
 */
export async function hostReachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'GET' });
    return response.status > 0;
  } catch (error) {
    // Node's fetch wraps everything as `TypeError: fetch failed`; the reason that matters — ENOTFOUND,
    // ECONNREFUSED, a TLS failure — is one level down in `cause`. Reading only the outer message made
    // an unreachable host look "reachable", which is the one wrong answer this helper may give.
    const chain = error as { message?: string; cause?: { message?: string; code?: string; cause?: unknown } };
    const cause = chain.cause as { message?: string; code?: string } | undefined;
    const text = [chain.message, cause?.message, cause?.code].filter(Boolean).join(' ');
    return !isConnectivityFailure(text);
  }
}

/** How many cases this run skipped for connectivity — so the number is visible, not silent. */
export function countSkipped(lines: string[]): number {
  return lines.filter((line) => line.startsWith('SKIPPED (connectivity)')).length;
}
