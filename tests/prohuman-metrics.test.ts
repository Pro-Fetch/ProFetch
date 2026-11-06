import { describe, it, expect } from 'vitest';
import {
  distribution,
  curvatureOf,
  curvatureRad,
  pathPx,
  measureTrace,
  stillnessVerdict,
  type TraceEvent,
} from '../src/core/prohuman-metrics.js';

/**
 * Measurement of a trace, pinned against the three ways this module was wrong before it was written.
 *
 * A synthetic trace is the right fixture here: every case below is a shape that appeared in a live run or
 * in the spike, and the assertion is the number we want the pack to report about it.
 */

const ev = (over: Partial<TraceEvent>): TraceEvent => ({
  type: 'mousemove',
  t: 0,
  trusted: true,
  x: 0,
  y: 0,
  key: null,
  dy: null,
  ...over,
});

const line = (points: Array<[number, number, number]>): TraceEvent[] => points.map(([t, x, y]) => ev({ t, x, y }));

describe('distributions describe spread, not size', () => {
  it('a metronome has CV 0 and a hand does not', () => {
    expect(distribution([100, 100, 100, 100]).cv).toBe(0);
    expect(distribution([40, 180, 90, 220]).cv).toBeGreaterThan(0.4);
  });

  it('an empty sample is reported as empty, not as zero risk', () => {
    const empty = distribution([]);
    expect(empty.n).toBe(0);
    expect(empty.max).toBe(0);
    expect(empty.cv).toBe(0);
  });

  it('reports percentiles from the sorted values', () => {
    const d = distribution([1, 2, 3, 4, 5, 6, 7, 8, 9, 100]);
    // floor(0.5n) of ten sorted values is the sixth, not the fifth: the definition is the one the report
    // prints, so it is stated here rather than assumed.
    expect(d.p50).toBe(6);
    expect(d.max).toBe(100);
    expect(d.mean).toBeGreaterThan(d.p50);
  });
});

describe('curvature ignores the jitter of a resting hand', () => {
  it('a straight reach scores zero', () => {
    const straight = Array.from({ length: 20 }, (_, i) => ({ x: i * 40, y: 300 }));
    expect(curvatureRad(straight, 5)).toBe(0);
  });

  it('a bowed reach scores above zero', () => {
    const arc = Array.from({ length: 21 }, (_, i) => ({ x: i * 40, y: 300 - Math.sin((i / 20) * Math.PI) * 80 }));
    expect(curvatureRad(arc, 5)).toBeGreaterThan(0.01);
  });

  it('sub-floor steps are not turns', () => {
    // The measured case: a 2px settle jitter averaged into a long reach turned 42 mrad into 923 mrad.
    const reach = Array.from({ length: 11 }, (_, i) => ({ x: i * 100, y: 500 }));
    const withJitter = [...reach, { x: 1001, y: 501 }, { x: 1002, y: 499 }, { x: 1000.5, y: 500.5 }];
    expect(curvatureRad(withJitter, 5)).toBe(curvatureRad(reach, 5));
    expect(curvatureRad(withJitter, 0)).toBeGreaterThan(curvatureRad(reach, 0));
  });

  it('the two kinds of zero are not the same answer', () => {
    // A straight reach and a trace the browser coalesced into two points both report 0 radians. Only the
    // sample count says which one happened, and a caller reading the angle alone can conclude that a
    // recorded two-point trace proves a synthetic straight line. Measured on a macOS CI runner, where a
    // reach that did move was reported exactly this way.
    const straight = Array.from({ length: 20 }, (_, i) => ({ x: i * 40, y: 300 }));
    const coalesced = [
      { x: 100, y: 200 },
      { x: 700, y: 640 },
    ];
    expect(curvatureOf(straight, 5).meanRad).toBe(0);
    expect(curvatureOf(straight, 5).samples).toBe(18);
    expect(curvatureOf(coalesced, 5).meanRad).toBe(0);
    expect(curvatureOf(coalesced, 5).samples, 'two points cannot form a turn').toBe(0);
  });
});

describe('a measured trace', () => {
  it('counts the pointer, the keys and the wheel separately', () => {
    const events = [
      ...line([
        [0, 10, 10],
        [50, 60, 40],
        [120, 120, 90],
      ]),
      ev({ type: 'keydown', t: 200, key: 'a', x: null, y: null }),
      ev({ type: 'keyup', t: 260, key: 'a', x: null, y: null }),
      ev({ type: 'wheel', t: 300, dy: 120, x: null, y: null }),
    ];
    const m = measureTrace(events, 5);
    expect(m.pointerEvents).toBe(3);
    expect(m.keydownEvents).toBe(1);
    expect(m.wheelEvents).toBe(1);
    expect(m.keyHoldMs.mean).toBe(60);
    expect(m.pathPx).toBeGreaterThan(0);
    expect(m.trustedRatio).toBe(1);
  });

  it('reports a synthetic event rather than trusting it silently', () => {
    const events = line([
      [0, 0, 0],
      [40, 50, 50],
    ]).map((e, i) => ({ ...e, trusted: i === 0 }));
    expect(measureTrace(events, 5).trustedRatio).toBe(0.5);
  });

  it('finds the longest stillness and where it ended', () => {
    const events = line([
      [1000, 0, 0],
      [1100, 10, 5],
      [3100, 40, 20],
      [3200, 80, 30],
    ]);
    const m = measureTrace(events, 5);
    expect(m.stillnessMaxMs).toBe(2000);
    expect(m.stillnessEndsAtMs).toBe(2100);
  });

  it('counts backspaces as corrections, because that is what a correction looks like in evidence', () => {
    const events = [
      ev({ type: 'keydown', t: 0, key: 'a', x: null, y: null }),
      ev({ type: 'keydown', t: 40, key: 'Backspace', x: null, y: null }),
      ev({ type: 'keydown', t: 80, key: 'Backspace', x: null, y: null }),
    ];
    expect(measureTrace(events, 5).correctionCount).toBe(2);
  });

  it('tortuosity is 1 for a straight line and above 1 for a curve', () => {
    const straight = measureTrace(
      line([
        [0, 0, 0],
        [10, 100, 0],
        [20, 200, 0],
      ]),
      5,
    );
    const curved = measureTrace(
      line([
        [0, 0, 0],
        [10, 100, 60],
        [20, 200, 0],
      ]),
      5,
    );
    expect(straight.tortuosity).toBeCloseTo(1, 2);
    expect(curved.tortuosity).toBeGreaterThan(1.1);
  });

  it('measures an empty trace without dividing by anything', () => {
    const m = measureTrace([], 5);
    expect(m.events).toBe(0);
    expect(m.trustedRatio).toBe(0);
    expect(m.curvatureRad).toBe(0);
    expect(m.curvatureSamples).toBe(0);
    expect(m.tortuosity).toBe(0);
  });
});

describe('the stillness verdict', () => {
  it('passes when every gap is under the ceiling', () => {
    const events = line([
      [0, 0, 0],
      [100, 10, 10],
      [200, 20, 12],
      [300, 30, 14],
    ]);
    const verdict = stillnessVerdict(events, 320);
    expect(verdict.ok).toBe(true);
    expect(verdict.worstMs).toBe(100);
    expect(verdict.violations).toBe(0);
  });

  it('fails and names the worst gap when the pointer sat still', () => {
    const events = line([
      [0, 0, 0],
      [100, 10, 10],
      [1400, 20, 12],
    ]);
    const verdict = stillnessVerdict(events, 320);
    expect(verdict.ok).toBe(false);
    expect(verdict.worstMs).toBe(1300);
    expect(verdict.violations).toBe(1);
  });

  it('treats an empty trace as a broken recorder, not as a steady pointer', () => {
    // This is the difference between a failed measurement and a passed one that measured nothing.
    const verdict = stillnessVerdict([], 320);
    expect(verdict.ok).toBe(false);
    expect(verdict.samples).toBe(0);
  });

  it('counts several violations rather than only the worst', () => {
    const events = line([
      [0, 0, 0],
      [500, 10, 10],
      [1000, 20, 20],
      [1500, 30, 30],
    ]);
    const verdict = stillnessVerdict(events, 320);
    expect(verdict.violations).toBe(3);
  });
});
