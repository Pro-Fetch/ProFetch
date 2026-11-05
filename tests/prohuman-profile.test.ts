import { describe, it, expect } from 'vitest';
import {
  createProfile,
  profileSummary,
  PRESETS,
  LIMITS,
  ProfileError,
  mulberry32,
  randomSeed,
} from '../src/core/prohuman-profile.js';

/**
 * The profile is the whole contract of this pack: every number a driver will use, in one place, checked
 * before anything moves. These tests are about the checking, because a profile that accepts `wpm: 5000`
 * is a driver that will type like a script and still call itself human.
 */

describe('profiles are numbers, and the numbers are checked', () => {
  it('every preset builds, and each differs from the others in at least one number', () => {
    const names = Object.keys(PRESETS);
    const built = names.map((preset) => createProfile({ preset, seed: 1 }));
    expect(names.length).toBeGreaterThanOrEqual(6);
    const fingerprints = built.map(
      (p) => JSON.stringify(profileSummary(p).pointer) + JSON.stringify(profileSummary(p).keyboard),
    );
    expect(new Set(fingerprints).size).toBe(names.length);
  });

  it('refuses a preset that does not exist and names the ones that do', () => {
    expect(() => createProfile({ preset: 'drunk' })).toThrow(/unknown preset "drunk"/);
    expect(() => createProfile({ preset: 'drunk' })).toThrow(/calm, fast, impatient/);
  });

  it('refuses a number outside the range, naming the number', () => {
    expect(() => createProfile({ keyboard: { wpm: 5000 } })).toThrow(
      /keyboard.wpm = 5000 is outside the supported range/,
    );
    expect(() => createProfile({ pointer: { aMs: -5 } })).toThrow(/pointer.aMs/);
    expect(() => createProfile({ pointer: { idleStillnessMs: 90_000 } })).toThrow(/idleStillnessMs/);
  });

  it('refuses a non-number rather than coercing it', () => {
    expect(() => createProfile({ pointer: { aMs: 'fast' as unknown as number } })).toThrow(/must be a finite number/);
    expect(() => createProfile({ pointer: { aMs: Number.NaN } })).toThrow(/must be a finite number/);
  });

  it('refuses a range whose maximum is below its minimum', () => {
    expect(() => createProfile({ keyboard: { holdMinMs: 200, holdMaxMs: 50 } })).toThrow(
      /holdMaxMs must be >= holdMinMs/,
    );
    expect(() => createProfile({ scroll: { burstMin: 9, burstMax: 2 } })).toThrow(
      /scroll\.burstMax \(2\) must be >= scroll\.burstMin \(9\)/,
    );
  });

  it('keeps the runtime ceiling inside the stated limits', () => {
    expect(() => createProfile({ max_runtime_ms: 5 } as never)).toThrow(ProfileError);
    const capped = createProfile({ max_runtime_ms: LIMITS.maxRuntimeMs[1] });
    expect(capped.maxRuntimeMs).toBe(600_000);
  });

  it('is reproducible with a seed and different without one', () => {
    const a = createProfile({ preset: 'calm', seed: 42 });
    const b = createProfile({ preset: 'calm', seed: 42 });
    expect(a.seed).toBe(b.seed);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const seeds = new Set(Array.from({ length: 40 }, () => randomSeed()));
    expect(seeds.size).toBeGreaterThan(35);
  });

  it('names the profile the caller gave it, or the preset', () => {
    expect(createProfile({ preset: 'fast', seed: 3 }).name).toBe('fast');
    expect(createProfile({ preset: 'fast', seed: 3, name: '  my runner  ' }).name).toBe('my runner');
  });
});

describe('the random source is a function of its seed', () => {
  it('replays exactly', () => {
    const one = mulberry32(20261104);
    const two = mulberry32(20261104);
    const seq1 = Array.from({ length: 200 }, () => one());
    const seq2 = Array.from({ length: 200 }, () => two());
    expect(seq1).toEqual(seq2);
  });

  it('stays inside [0,1) and is not constant', () => {
    const rng = mulberry32(7);
    const values = Array.from({ length: 5000 }, () => rng());
    expect(values.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(new Set(values).size).toBeGreaterThan(4900);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    expect(mean).toBeGreaterThan(0.45);
    expect(mean).toBeLessThan(0.55);
  });

  it('starts differently for different seeds', () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
});
