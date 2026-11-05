import { describe, it, expect } from 'vitest';
import {
  fittsIndex,
  movementMs,
  minJerk,
  planPath,
  planScroll,
  planTyping,
  planDwell,
  nextIdleGap,
  planDrift,
} from '../src/core/prohuman-path.js';
import { createProfile, mulberry32 } from '../src/core/prohuman-profile.js';

/**
 * The movement model, tested as maths rather than as a browser session.
 *
 * Each test names the mistake it prevents: a straight line, a metronome, a zigzag, a click that never
 * settles, a scroll that is one jump. Those are the shapes of a machine, and they are what a plan can
 * produce if nobody checks.
 */

const profile = createProfile({ preset: 'calm', seed: 11 });
const rng = mulberry32(1234);

describe('Fitts’ law sizes the movement, not a constant', () => {
  it('is harder for a farther or narrower target', () => {
    expect(fittsIndex(600, 20)).toBeGreaterThan(fittsIndex(60, 20));
    expect(fittsIndex(300, 12)).toBeGreaterThan(fittsIndex(300, 120));
  });

  it('takes longer for a farther or narrower target', () => {
    expect(movementMs(profile, 600, 40)).toBeGreaterThan(movementMs(profile, 60, 40));
    expect(movementMs(profile, 300, 10)).toBeGreaterThan(movementMs(profile, 300, 200));
  });

  it('never plans a zero-time reach', () => {
    expect(movementMs(profile, 0, 100)).toBeGreaterThan(0);
  });

  it('a faster preset covers the same distance in less time', () => {
    const impatient = createProfile({ preset: 'impatient', seed: 11 });
    expect(movementMs(impatient, 500, 30)).toBeLessThan(movementMs(profile, 500, 30));
  });
});

describe('the velocity profile is a hand, not a stepper', () => {
  it('starts at zero, ends at one, and is monotonic', () => {
    expect(minJerk(0)).toBe(0);
    expect(minJerk(1)).toBe(1);
    let previous = -1;
    for (let i = 0; i <= 100; i++) {
      const v = minJerk(i / 100);
      expect(v).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = v;
    }
  });

  it('is slowest at the ends and fastest in the middle', () => {
    const startSpeed = minJerk(0.02) - minJerk(0);
    const midSpeed = minJerk(0.52) - minJerk(0.5);
    const endSpeed = minJerk(1) - minJerk(0.98);
    expect(midSpeed).toBeGreaterThan(startSpeed);
    expect(midSpeed).toBeGreaterThan(endSpeed);
  });

  it('clamps input outside the unit interval', () => {
    expect(minJerk(-1)).toBe(0);
    expect(minJerk(2)).toBe(1);
  });
});

describe('a planned reach', () => {
  const from = { x: 100, y: 700 };
  const to = { x: 900, y: 200 };

  it('lands on the target and ends with a settle window', () => {
    const plan = planPath(from, to, 80, profile, rng);
    const last = plan.steps[plan.steps.length - 1];
    expect(last.phase).toBe('settle');
    expect(Math.abs(last.x - to.x)).toBeLessThan(profile.pointer.noiseFloorPx);
    expect(Math.abs(last.y - to.y)).toBeLessThan(profile.pointer.noiseFloorPx);
    expect(plan.steps.filter((s) => s.phase === 'settle').length).toBeGreaterThanOrEqual(2);
  });

  it('is longer than the straight line, because it is not the straight line', () => {
    const plan = planPath(from, to, 80, profile, rng);
    expect(plan.pathPx).toBeGreaterThan(plan.directPx);
    const points = plan.steps.map((s) => ({ x: s.x, y: s.y }));
    let drawn = 0;
    for (let i = 1; i < points.length; i++)
      drawn += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    expect(drawn).toBeGreaterThan(plan.directPx);
  });

  it('produces several events, not one jump', () => {
    const plan = planPath(from, to, 80, profile, rng);
    expect(plan.steps.length).toBeGreaterThan(8);
  });

  it('delays vary — a metronome is the failure state', () => {
    // Variation, not distinct rounded values: at ~14 ms per step, rounding collapses the set long before
    // the timing actually becomes uniform, so the honest measure is the coefficient of variation.
    const plan = planPath(from, to, 80, profile, rng);
    const delays = plan.steps.map((s) => s.delayMs);
    const mean = delays.reduce((a, b) => a + b, 0) / delays.length;
    const sd = Math.sqrt(delays.reduce((a, b) => a + (b - mean) ** 2, 0) / delays.length);
    expect(sd / mean).toBeGreaterThan(0.15);
  });

  it('overshoots a small target and corrects back', () => {
    const plan = planPath(from, to, 8, profile, rng);
    expect(plan.overshot).toBe(true);
    expect(plan.steps.filter((s) => s.phase === 'correction').length).toBeGreaterThanOrEqual(1);
  });

  it('does not overshoot a wide target', () => {
    const plan = planPath(from, to, 300, profile, rng);
    expect(plan.overshot).toBe(false);
    expect(plan.steps.filter((s) => s.phase === 'correction')).toHaveLength(0);
  });

  it('curves to one side within a single path, not to a new side every sample', () => {
    // The bug this guards: drawing the bow sign per sample produced a zigzag that measured as enormous
    // curvature. A path that leans one way has turn angles clustered near zero.
    const plan = planPath({ x: 100, y: 500 }, { x: 1200, y: 500 }, 200, profile, rng);
    const pts = plan.steps.filter((s) => s.phase === 'approach').map((s) => ({ x: s.x, y: s.y }));
    let turns = 0;
    let signChanges = 0;
    let previousSide = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const cross =
        (pts[i].x - pts[i - 1].x) * (pts[i + 1].y - pts[i].y) - (pts[i].y - pts[i - 1].y) * (pts[i + 1].x - pts[i].x);
      if (Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) < 5) continue;
      const side = Math.sign(cross);
      if (side !== 0) {
        if (previousSide !== 0 && side !== previousSide) signChanges++;
        previousSide = side;
        turns++;
      }
    }
    expect(turns).toBeGreaterThan(5);
    expect(signChanges / turns).toBeLessThan(0.2);
  });

  it('is reproducible from the same seed', () => {
    const a = planPath(from, to, 80, profile, mulberry32(9));
    const b = planPath(from, to, 80, profile, mulberry32(9));
    expect(a.steps).toEqual(b.steps);
  });
});

describe('typing has a rhythm and sometimes a mistake', () => {
  const text = 'the quick brown fox jumps over the lazy dog.';

  it('emits a down and an up for every character', () => {
    const steps = planTyping(text, profile, rng);
    const keys = steps.filter((s) => s.kind === 'key');
    expect(keys).toHaveLength(text.length);
    expect(keys.find((s) => s.key === ' ')).toBeUndefined();
    expect(keys.filter((s) => s.key === 'Space').length).toBe(text.split(' ').length - 1);
  });

  it('pauses longer after punctuation than in the middle of a word', () => {
    // Means over a long text, not one pair: a single gap is dominated by the random component, and a test
    // that compares two draws measures the draw rather than the model.
    const strict = createProfile({ preset: 'calm', seed: 5, keyboard: { typoRate: 0 } });
    const sample = 'first stop, second stop, third stop, then a long stretch of ordinary prose here';
    const steps = planTyping(sample, strict, mulberry32(5));
    const after: number[] = [];
    const during: number[] = [];
    for (let i = 1; i < steps.length; i++) {
      if (steps[i].kind !== 'key') continue;
      const previousKey = steps[i - 1].key;
      if (previousKey === ',') after.push(steps[i].gapMs);
      else if (/^[a-z]$/.test(previousKey)) during.push(steps[i].gapMs);
    }
    const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
    expect(after.length).toBeGreaterThan(1);
    expect(mean(after)).toBeGreaterThan(mean(during));
  });

  it('with no typo rate, produces no corrections at all', () => {
    const strict = createProfile({ preset: 'calm', seed: 3, keyboard: { typoRate: 0 } });
    const steps = planTyping(text, strict, mulberry32(3));
    expect(steps.filter((s) => s.kind !== 'key')).toHaveLength(0);
  });

  it('with a high typo rate, makes mistakes and takes them back', () => {
    const sloppy = createProfile({ preset: 'calm', seed: 4, keyboard: { typoRate: 0.2 } });
    const steps = planTyping(text, sloppy, mulberry32(4));
    const mistakes = steps.filter((s) => s.kind === 'mistake').length;
    const fixes = steps.filter((s) => s.kind === 'correction').length;
    expect(mistakes).toBeGreaterThan(2);
    expect(fixes).toBeGreaterThanOrEqual(mistakes);
  });

  it('is reproducible from the same seed', () => {
    expect(planTyping(text, profile, mulberry32(8))).toEqual(planTyping(text, profile, mulberry32(8)));
  });
});

describe('scrolling arrives in bursts', () => {
  it('plans between burstMin and burstMax pushes', () => {
    const bursts = planScroll(profile, rng);
    expect(bursts.length).toBeGreaterThanOrEqual(profile.scroll.burstMin);
    expect(bursts.length).toBeLessThanOrEqual(profile.scroll.burstMax * 2);
  });

  it('a re-read moves the other way', () => {
    const touchpad = createProfile({ preset: 'touchpad', seed: 6, scroll: { regressionRate: 1 } });
    const bursts = planScroll(touchpad, mulberry32(6));
    const regressions = bursts.filter((b) => b.regression);
    expect(regressions.length).toBeGreaterThan(0);
    expect(regressions.every((b) => b.dy < 0)).toBe(true);
  });

  it('respects the requested direction', () => {
    const up = planScroll(profile, rng, -1).filter((b) => !b.regression);
    expect(up.every((b) => b.dy < 0)).toBe(true);
  });
});

describe('dwell, idle and drift', () => {
  it('reading time grows with the number of words', () => {
    expect(planDwell(200, profile, rng)).toBeGreaterThan(planDwell(20, profile, rng));
  });

  it('a faster reader spends less time on the same text', () => {
    const impatient = createProfile({ preset: 'impatient', seed: 1 });
    expect(planDwell(100, impatient, rng)).toBeLessThan(planDwell(100, profile, rng));
  });

  it('the idle gap always stays under the stillness ceiling', () => {
    for (let seed = 0; seed < 400; seed++) {
      const gap = nextIdleGap(profile, mulberry32(seed));
      expect(gap).toBeLessThanOrEqual(profile.pointer.idleStillnessMs);
      expect(gap).toBeGreaterThan(0);
    }
  });

  it('drift stays inside the viewport and near the pointer', () => {
    const viewport = { x: 1280, y: 800 };
    for (let seed = 0; seed < 300; seed++) {
      const next = planDrift({ x: 640, y: 400 }, viewport, profile, mulberry32(seed));
      expect(next.x).toBeGreaterThanOrEqual(2);
      expect(next.x).toBeLessThan(viewport.x);
      expect(next.y).toBeGreaterThanOrEqual(2);
      expect(next.y).toBeLessThan(viewport.y);
      expect(Math.hypot(next.x - 640, next.y - 400)).toBeLessThanOrEqual(profile.pointer.driftPx * 1.5);
    }
  });

  it('drift keeps the pointer from being exactly where it was', () => {
    const moved = Array.from({ length: 50 }, (_, i) =>
      planDrift({ x: 600, y: 300 }, { x: 1280, y: 800 }, profile, mulberry32(i)),
    );
    expect(new Set(moved.map((p) => `${p.x},${p.y}`)).size).toBeGreaterThan(40);
  });
});
