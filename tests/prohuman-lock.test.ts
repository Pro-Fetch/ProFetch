import { describe, it, expect, afterEach } from 'vitest';
import {
  acquirePointer,
  releasePointer,
  renewPointer,
  pointerHolder,
  releaseAllFor,
  __resetPointerLocks,
} from '../src/core/prohuman-lock.js';

/**
 * One writer per cursor.
 *
 * The rule these tests hold is the refusal: a second writer is told who is in the way, and is never quietly
 * queued. Queueing would let a caller believe its click happened when it asked for it, while the pointer had
 * already been moved somewhere else underneath it.
 */

afterEach(() => __resetPointerLocks());

describe('the cursor has one holder', () => {
  it('gives it to the first writer', () => {
    const taken = acquirePointer('s1', { kind: 'driver', id: 'ph-1' });
    expect(taken.ok).toBe(true);
    expect(pointerHolder('s1')?.id).toBe('ph-1');
  });

  it('refuses a second writer and names the holder', () => {
    acquirePointer('s1', { kind: 'driver', id: 'ph-1' });
    const refused = acquirePointer('s1', { kind: 'action', id: 'act-9' });
    expect(refused.ok).toBe(false);
    expect(refused.holder?.id).toBe('ph-1');
    expect(refused.reason).toMatch(/held by driver "ph-1"/);
    expect(refused.reason).toMatch(/pause_driver=true/);
  });

  it('lets the same holder renew without a fight', () => {
    acquirePointer('s1', { kind: 'driver', id: 'ph-1' });
    const again = acquirePointer('s1', { kind: 'driver', id: 'ph-1' });
    expect(again.ok).toBe(true);
    expect(again.holder?.renewals).toBe(1);
  });

  it('keeps two sessions independent', () => {
    acquirePointer('s1', { kind: 'driver', id: 'ph-1' });
    expect(acquirePointer('s2', { kind: 'action', id: 'act-1' }).ok).toBe(true);
  });
});

describe('a lease that outlives its holder is reclaimed, and the reclaim is said out loud', () => {
  it('expires at the ttl', () => {
    const t0 = 1_000_000;
    acquirePointer('s1', { kind: 'driver', id: 'ph-1', ttlMs: 1000 }, t0);
    expect(pointerHolder('s1', t0 + 500)?.id).toBe('ph-1');
    expect(pointerHolder('s1', t0 + 1500)).toBeNull();
    const next = acquirePointer('s1', { kind: 'action', id: 'act-2' }, t0 + 1500);
    expect(next.ok).toBe(true);
    expect(next.reason).toMatch(/reclaimed an expired lock held by driver "ph-1"/);
  });

  it('renews only for its own holder', () => {
    acquirePointer('s1', { kind: 'driver', id: 'ph-1' }, 10);
    const stranger = renewPointer('s1', 'ph-2', 20);
    expect(stranger.ok).toBe(false);
    expect(stranger.reason).toMatch(/does not hold the pointer/);
    // The failed renewal must not have handed the cursor over.
    expect(pointerHolder('s1', 20)?.id).toBe('ph-1');
  });

  it('drops an expired lease on a renewal attempt without giving it away', () => {
    acquirePointer('s1', { kind: 'driver', id: 'ph-1', ttlMs: 100 }, 0);
    const late = renewPointer('s1', 'ph-2', 500);
    expect(late.ok).toBe(false);
    expect(late.reason).toMatch(/had expired and was dropped/);
    expect(pointerHolder('s1', 500)).toBeNull();
  });
});

describe('releasing', () => {
  it('only works for the holder', () => {
    acquirePointer('s1', { kind: 'driver', id: 'ph-1' });
    const wrong = releasePointer('s1', 'ph-2');
    expect(wrong.ok).toBe(false);
    expect(pointerHolder('s1')).not.toBeNull();
    expect(releasePointer('s1', 'ph-1').ok).toBe(true);
    expect(pointerHolder('s1')).toBeNull();
  });

  it('is not an error when nothing was held', () => {
    expect(releasePointer('s1', 'ph-1').ok).toBe(true);
  });

  it('frees everything a session held when it closes', () => {
    acquirePointer('s1', { kind: 'driver', id: 'ph-1' });
    acquirePointer('s2', { kind: 'driver', id: 'ph-2' });
    releaseAllFor('s1');
    expect(pointerHolder('s1')).toBeNull();
    expect(pointerHolder('s2')?.id).toBe('ph-2');
  });
});
