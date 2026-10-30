/**
 * The gate that decides "the network failed" vs "the product failed".
 *
 * If this classification is wrong in the permissive direction, real defects get skipped and the
 * suite becomes theatre. So both directions are pinned: connectivity signatures skip, and every
 * answer a reachable host actually gave — 403, 500, an HTML body, bad credentials — stays a failure.
 */

import { describe, it, expect } from 'vitest';
import { hostReachable, isConnectivityFailure, skipIfUnreachable } from './helpers/liveGate.js';

describe('isConnectivityFailure', () => {
  it('recognises a host that could not be reached', () => {
    for (const text of [
      'getaddrinfo ENOTFOUND example.com',
      'Error: connect ECONNREFUSED 127.0.0.1:9',
      'read ECONNRESET',
      'Test timed out in 60000ms',
      'fatal: unable to access: Could not resolve host: github.com',
      'LIVE_ENDPOINT_UNAVAILABLE: pro_opendata_rows ga Socrata 3 marta urunildi',
      'DNS host manziliga resolve bo‘lmadi: example.com',
    ])
      expect(isConnectivityFailure(text), text).toBe(true);
  });

  it('does not excuse an answer the server actually gave', () => {
    for (const text of [
      'GitHub 403: rate limit exceeded',
      'HTTP 500 Internal Server Error',
      'Wayback availability API JSON emas javob qaytardi, HTTP 200, content-type: text/html',
      'GitHub 401: Bad credentials',
      'portal_without_data_api: true',
    ])
      expect(isConnectivityFailure(text), text).toBe(false);
  });
});

describe('hostReachable', () => {
  it('is false for a name that cannot resolve', async () => {
    expect(await hostReachable('https://this-host-does-not-exist.invalid/')).toBe(false);
  });

  it('answers without throwing for a real host', async () => {
    expect(typeof (await hostReachable('https://example.com/'))).toBe('boolean');
  });
});

describe('skipIfUnreachable', () => {
  it('calls skip only for a connectivity answer', () => {
    let skipped = 0;
    expect(skipIfUnreachable(() => (skipped += 1), 'getaddrinfo ENOTFOUND api.github.com', 'github case')).toBe(true);
    expect(skipped).toBe(1);
    expect(skipIfUnreachable(() => (skipped += 1), 'GitHub 401: Bad credentials', 'auth case')).toBe(false);
    expect(skipped).toBe(1);
  });
});
