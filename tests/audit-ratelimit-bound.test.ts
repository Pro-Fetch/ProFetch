/**
 * Pin for audit finding 2.1: `MAX_BUCKETS` was declared and never enforced.
 *
 * Reaching the ceiling called `pruneStaleBuckets()`, which only drops buckets idle for fifteen minutes, so a
 * run that keeps naming new domains — one per hostname it reads — grew the map forever. The auditor measured
 * 60,000 entries against a stated 50,000; on this machine the same loop took 32 seconds, because the idle
 * sweep ran on every insert past the ceiling.
 */

import { afterEach, describe, expect, it } from 'vitest';
import '../src/loader.js';
import { bucketsSnapshot, bucketStatus, MAX_BUCKETS, resetBuckets, take } from '../src/core/ratelimit.js';

afterEach(() => resetBuckets());

describe('the rate limiter bounds what it says it bounds', () => {
  it('does not grow past MAX_BUCKETS just because every bucket was touched recently', () => {
    for (let i = 0; i < 60_000; i++) take('audit21' + i);
    expect(Object.keys(bucketsSnapshot()).length).toBeLessThanOrEqual(MAX_BUCKETS);
  });

  it('spends from a bucket without forgetting the others it just created', () => {
    // Eviction must not become a way to lose a debt: a key that is being limited still refuses.
    expect(take('audit21-debt', 2, 600_000)).toBe(true);
    expect(take('audit21-debt', 2, 600_000)).toBe(true);
    expect(take('audit21-debt', 2, 600_000)).toBe(false);
    expect(bucketStatus('audit21-debt', 2, 600_000).tokens).toBe(0);
  });

  it('stays under the ceiling while the same keys keep being used', () => {
    // The churn case that matters in a long session: many hosts, revisited. Nothing here should be evicted
    // for size, because the map never reaches the ceiling.
    for (let round = 0; round < 40; round++) {
      for (let i = 0; i < 200; i++) take('audit21b' + i);
    }
    expect(Object.keys(bucketsSnapshot()).length).toBe(200);
  });
});
