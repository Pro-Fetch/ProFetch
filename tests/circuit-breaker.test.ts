/**
 * The per-host circuit breaker and the error taxonomy it depends on.
 *
 * The interesting half of a breaker is not the counting, it is what refuses to be counted: a 404, a block
 * page and a paywall are all answers, and treating them as failures would open the circuit against exactly
 * the hosts that are talking to us. Those cases are here alongside the ones that do count.
 *
 * No network and no browser: the clock is passed in, so a cooldown is a number in a test rather than thirty
 * seconds of waiting.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/loader.js';
import { cache } from '../src/core/cache.js';
import { dispatch } from '../src/core/tool.js';
import { fetchUrl } from '../src/core/fetcher.js';
import {
  breakerRefusal,
  breakerReport,
  breakerSettings,
  breakerState,
  classifyFetchError,
  isTransportFailure,
  recordFailure,
  recordSuccess,
  resetBreaker,
} from '../src/core/circuit-breaker.js';

const HOST = 'breaker.test';

afterEach(() => {
  resetBreaker();
  vi.unstubAllGlobals();
  cache.clear();
  delete process.env.PRO_FETCH_BREAKER_THRESHOLD;
  delete process.env.PRO_FETCH_BREAKER_COOLDOWN_MS;
  delete process.env.PRO_FETCH_BREAKER_ENABLED;
});

describe('classifying what went wrong', () => {
  it('names each transport fault from the error we actually have', () => {
    expect(classifyFetchError(new Error('getaddrinfo ENOTFOUND nope.example'))).toBe('dns_unresolvable');
    expect(classifyFetchError(new Error('DNS host manziliga resolve bo‘lmadi: x — EAI_AGAIN'))).toBe(
      'dns_unresolvable',
    );
    expect(classifyFetchError(Object.assign(new Error('boom'), { code: 'ECONNREFUSED' }))).toBe('connection_refused');
    expect(classifyFetchError(Object.assign(new Error('boom'), { code: 'ECONNRESET' }))).toBe('connection_reset');
    expect(classifyFetchError(new Error('socket hang up'))).toBe('socket_hang_up');
    expect(classifyFetchError(Object.assign(new Error('boom'), { code: 'ETIMEDOUT' }))).toBe('timeout');
    expect(classifyFetchError(new Error('HTTP_TIMEOUT after 15000ms'))).toBe('timeout');
    expect(classifyFetchError(new Error('unable to verify the first certificate'))).toBe('tls_failed');
    expect(classifyFetchError(Object.assign(new Error('boom'), { code: 'EHOSTUNREACH' }))).toBe('network_unreachable');
    expect(classifyFetchError(new Error('response too large: 40 MB'))).toBe('too_large');
    expect(classifyFetchError(new Error('browserType.launch: no Playwright'))).toBe('browser_unavailable');
  });

  it('says unknown rather than guessing a class that would open or excuse a circuit', () => {
    expect(classifyFetchError(new Error('something we have never seen'))).toBe('unknown');
    expect(classifyFetchError('a string, not an error')).toBe('unknown');
  });

  it('counts only faults that mean "not answering"', () => {
    for (const kind of ['dns_unresolvable', 'timeout', 'connection_refused', 'tls_failed', 'socket_hang_up']) {
      expect(isTransportFailure(kind), kind).toBe(true);
    }
    for (const kind of ['http_error', 'blocked', 'auth_wall', 'rate_limited', 'policy_refused', 'unknown']) {
      expect(isTransportFailure(kind), kind).toBe(false);
    }
  });
});

describe('the operator bounds', () => {
  it('clamps the threshold and the cooldown, and falls back on nonsense', () => {
    process.env.PRO_FETCH_BREAKER_THRESHOLD = '5000';
    process.env.PRO_FETCH_BREAKER_COOLDOWN_MS = '1';
    expect(breakerSettings()).toMatchObject({ threshold: 20, cooldownMs: 1000 });
    process.env.PRO_FETCH_BREAKER_THRESHOLD = 'abc';
    expect(breakerSettings().threshold).toBe(3);
    expect(breakerSettings().enabled).toBe(true);
    process.env.PRO_FETCH_BREAKER_ENABLED = '0';
    expect(breakerSettings().enabled).toBe(false);
  });
});

describe('the state machine', () => {
  const t0 = 1_000_000;

  it('opens after three consecutive transport failures and refuses with a countdown', () => {
    recordFailure(HOST, 'timeout', t0);
    recordFailure(HOST, 'timeout', t0 + 1000);
    expect(breakerRefusal(HOST, t0 + 2000)).toBeNull();
    recordFailure(HOST, 'dns_unresolvable', t0 + 2000);
    const refusal = breakerRefusal(HOST, t0 + 2000);
    expect(refusal).not.toBeNull();
    expect(refusal?.failures).toBe(3);
    expect(refusal?.retry_in_ms).toBe(30_000);
    // The circuit opened at t0 + 2000; fifteen seconds later the countdown has gone down, not reset.
    expect(breakerRefusal(HOST, t0 + 17_000)?.retry_in_ms).toBe(15_000);
    expect(breakerState(HOST, t0 + 2000).state).toBe('open');
  });

  it('does not open for answers — a 404, a block page and a paywall all mean the host is talking', () => {
    for (let i = 0; i < 10; i++) recordFailure(HOST, 'http_error', t0 + i * 100);
    for (let i = 0; i < 10; i++) recordFailure(HOST, 'auth_wall', t0 + i * 100);
    expect(breakerRefusal(HOST, t0)).toBeNull();
    expect(breakerState(HOST, t0).failures).toBe(0);
  });

  it('lets one probe through after the cooldown and re-opens on a single further failure', () => {
    for (let i = 0; i < 3; i++) recordFailure(HOST, 'timeout', t0 + i);
    expect(breakerRefusal(HOST, t0 + 31_000)).toBeNull(); // half-open: the probe is allowed
    recordFailure(HOST, 'timeout', t0 + 31_001);
    const again = breakerRefusal(HOST, t0 + 31_002);
    expect(again).not.toBeNull();
    expect(again?.failures).toBe(3);
    expect(breakerReport().entries.find((entry) => entry.host === HOST)?.trips).toBe(2);
  });

  it('closes again on the first answer, and forgets the streak', () => {
    for (let i = 0; i < 2; i++) recordFailure(HOST, 'timeout', t0 + i);
    recordSuccess(HOST);
    recordFailure(HOST, 'timeout', t0 + 3000);
    expect(breakerRefusal(HOST, t0 + 3000)).toBeNull();
    expect(breakerState(HOST, t0 + 3000).failures).toBe(1);
  });

  it('reports nothing about a host it never saw fail', () => {
    expect(breakerReport().hosts).toBe(0);
    expect(breakerReport().entries).toEqual([]);
  });

  it('stays silent for every host while the operator has it switched off', () => {
    process.env.PRO_FETCH_BREAKER_ENABLED = 'false';
    for (let i = 0; i < 8; i++) recordFailure(HOST, 'timeout', t0 + i);
    expect(breakerRefusal(HOST, t0)).toBeNull();
  });
});

describe('fetchUrl enforces it before spending a request', () => {
  function stubFailures(times: number): { calls: number } {
    const counter = { calls: 0 };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        counter.calls++;
        if (counter.calls <= times) throw new Error('fetch failed: getaddrinfo ENOTFOUND breaker.example');
        return new Response(
          '<html><body><p>Back up and running with enough words to be a document now.</p></body></html>',
          {
            status: 200,
            headers: { 'content-type': 'text/html' },
          },
        );
      }),
    );
    return counter;
  }

  it('opens the circuit after three DNS failures and the fourth call never leaves the process', async () => {
    const counter = stubFailures(10);
    const url = 'http://93.184.216.34/breaker-a';
    for (let i = 0; i < 3; i++) {
      await expect(fetchUrl(url + '-' + i, { useCache: false })).rejects.toThrow(/ENOTFOUND/);
    }
    const before = counter.calls;
    expect(before).toBeGreaterThan(0);
    await expect(fetchUrl(url + '-3', { useCache: false })).rejects.toThrow(/CIRCUIT_OPEN/);
    // The whole point of the breaker: the refused call asked the network for nothing.
    expect(counter.calls).toBe(before);
  });

  it('serves a cached document even while the host is open, because a cache hit costs the host nothing', async () => {
    stubFailures(0);
    const url = 'http://93.184.216.34/cached-while-open';
    const first = await fetchUrl(url);
    expect(first.cached).toBe(false);
    for (let i = 0; i < 3; i++) recordFailure('93.184.216.34', 'timeout');
    const second = await fetchUrl(url);
    expect(second.cached).toBe(true);
    expect(second.markdown).toContain('Back up and running');
  });
});

describe('pro_fetch_browser_metrics', () => {
  function payload(result: Awaited<ReturnType<typeof dispatch>>): Record<string, any> {
    const text = (result.content ?? []).map((item: { text?: string }) => item.text ?? '').join('\n');
    const match = /```json\n([\s\S]*?)\n```/.exec(text);
    return JSON.parse(match ? match[1] : text);
  }

  it('reports the pool, the breakers and the reader policy', async () => {
    recordFailure('metric.example', 'timeout');
    const body = payload(await dispatch('pro_fetch_browser_metrics', {}));
    expect(body.pool).toBeDefined();
    expect(typeof body.pool.reads).toBe('number');
    expect(body.pool.settings.size).toBeGreaterThanOrEqual(1);
    expect(body.breaker.entries.some((entry: any) => entry.host === 'metric.example')).toBe(true);
    expect(body.breaker_settings.threshold).toBe(3);
    expect(body.policy.block_resources).toEqual(['font', 'image', 'media']);
    expect(typeof body.policy.playwright_available).toBe('boolean');
  });

  it('returns only the section that was asked for', async () => {
    const body = payload(await dispatch('pro_fetch_browser_metrics', { include: 'breaker' }));
    expect(body.breaker).toBeDefined();
    expect(body.pool).toBeUndefined();
    expect(body.policy).toBeUndefined();
  });

  it('refuses an unknown section instead of answering with an empty report', async () => {
    const result = await dispatch('pro_fetch_browser_metrics', { include: 'memories' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('pool, breaker, policy');
  });
});
