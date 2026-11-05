/**
 * Movement planning: the maths between "go to that button" and a sequence of timed pointer events.
 *
 * Everything here is pure — it takes numbers and returns numbers — so the shape of a movement can be tested
 * without a browser. What the driver does with the plan is a separate concern; what the page recorded is a
 * third (`prohuman-metrics.ts`). Keeping them apart is what makes "the path was curved" a claim about the
 * plan and "the path *was* curved" a claim about the trace, and only the second one is evidence.
 */

import type { HumanProfile } from './prohuman-profile.js';

export interface Point {
  x: number;
  y: number;
}

export interface PathStep {
  x: number;
  y: number;
  /** Delay before this step, in ms — the gap between the previous event and this one. */
  delayMs: number;
  /** Which phase of the movement this step belongs to, so a report can separate approach from settle. */
  phase: 'approach' | 'overshoot' | 'correction' | 'settle';
}

export interface PathPlan {
  steps: PathStep[];
  /** Total planned duration, from the first event to the click-ready position. */
  durationMs: number;
  /** Straight-line distance, kept so curvature can be judged against it. */
  directPx: number;
  /** Planned path length, which is always longer than `directPx` — if it is not, the path is a line. */
  pathPx: number;
  /** Whether the plan went past the target and corrected, which is the tell of a hand, not a cursor. */
  overshot: boolean;
  targetWidthPx: number;
}

/** Index of difficulty: Fitts' law, in the form that does not divide by zero for a point target. */
export function fittsIndex(distancePx: number, widthPx: number): number {
  const w = Math.max(1, widthPx);
  return Math.log2(Math.max(1, distancePx) / w + 1);
}

/** Movement time from Fitts' law: `a + b · ID`, floored so a zero-distance move is still a human beat. */
export function movementMs(profile: HumanProfile, distancePx: number, widthPx: number): number {
  const { aMs, bMs } = profile.pointer;
  return Math.round(aMs + bMs * fittsIndex(distancePx, widthPx));
}

/**
 * The minimum-jerk position profile: `10t³ − 15t⁴ + 6t⁵`.
 *
 * It is the shape a free hand produces when it moves between two points: velocity starts at zero, peaks once
 * around the middle, and returns to zero without a second braking event. Linear interpolation — what a
 * `steps: N` API does — has a velocity discontinuity at both ends, which is the signature of a cursor
 * teleported by code.
 */
export function minJerk(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 10 * c ** 3 - 15 * c ** 4 + 6 * c ** 5;
}

function bezier(from: Point, to: Point, bowPx: number, sign: number, t: number): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  // Perpendicular to the direction of travel. `sign` is chosen by the caller once per movement: which side
  // a hand leans to is a property of the reach, not of the sample, and drawing it per sample turns the
  // curve into a zigzag — a bug this pack's own spike measured (923 mrad of "curvature" that was noise).
  const nx = -dy / len;
  const ny = dx / len;
  const cx = (from.x + to.x) / 2 + nx * bowPx * sign;
  const cy = (from.y + to.y) / 2 + ny * bowPx * sign;
  const mt = 1 - t;
  return { x: mt * mt * from.x + 2 * mt * t * cx + t * t * to.x, y: mt * mt * from.y + 2 * mt * t * cy + t * t * to.y };
}

/**
 * Plan a pointer movement.
 *
 * `targetWidthPx` is the target's own width where it is known (a button, a link) and 0 when the driver is
 * moving to bare coordinates — a point has no width, so Fitts' difficulty grows and overshoot is planned.
 */
export function planPath(
  from: Point,
  to: Point,
  targetWidthPx: number,
  profile: HumanProfile,
  rng: () => number,
): PathPlan {
  const { pointer } = profile;
  const directPx = Math.hypot(to.x - from.x, to.y - from.y);
  const width = targetWidthPx > 0 ? targetWidthPx : 1;
  const duration = movementMs(profile, directPx, width);
  const steps: PathStep[] = [];

  // A movement is sampled at roughly the rate a hand produces events: 60–120 Hz, never a fixed stride.
  const sampleCount = Math.max(6, Math.min(60, Math.round(duration / (10 + rng() * 8))));
  const bow = pointer.sigmaCurvePx * (0.4 + rng() * 1.2);
  const sign = rng() < 0.5 ? -1 : 1;

  const small = width < pointer.smallTargetPx && directPx > 20;
  const overshoot = small ? pointer.overshootPx * (0.5 + rng()) : 0;
  // Where the hand aims when it plans to overshoot: past the target along the direction of travel.
  const aimPast: Point =
    overshoot > 0 && directPx > 0
      ? { x: to.x + ((to.x - from.x) / directPx) * overshoot, y: to.y + ((to.y - from.y) / directPx) * overshoot }
      : to;

  let pathPx = 0;
  let previous: Point | null = null;
  for (let i = 1; i <= sampleCount; i++) {
    const t = i / sampleCount;
    const p = bezier(from, aimPast, bow, sign, minJerk(t));
    const gap = Math.round((duration / sampleCount) * (0.6 + rng() * 0.9));
    if (previous) pathPx += Math.hypot(p.x - previous.x, p.y - previous.y);
    steps.push({ x: round2(p.x), y: round2(p.y), delayMs: gap, phase: 'approach' });
    previous = p;
  }

  // Corrections: the hand comes back to the target it overshot, in one or two visible sub-movements.
  if (overshoot > 0) {
    const corrections = 1 + (rng() < 0.45 ? 1 : 0);
    let cursor = aimPast;
    for (let i = 0; i < corrections; i++) {
      const f = (i + 1) / (corrections + 1);
      const p = {
        x: cursor.x + (to.x - cursor.x) * (0.6 + rng() * 0.4),
        y: cursor.y + (to.y - cursor.y) * (0.6 + rng() * 0.4),
      };
      pathPx += Math.hypot(p.x - cursor.x, p.y - cursor.y);
      steps.push({ x: round2(p.x), y: round2(p.y), delayMs: Math.round(30 + rng() * 90), phase: 'correction' });
      cursor = p;
    }
    pathPx += Math.hypot(to.x - cursor.x, to.y - cursor.y);
    steps.push({ x: round2(to.x), y: round2(to.y), delayMs: Math.round(25 + rng() * 70), phase: 'overshoot' });
  }

  // Settling: a few movements smaller than the noise floor, then the click. A machine goes straight to the
  // button and presses it; a hand stops for a moment on it.
  const settleSteps = 2 + Math.round(rng() * 2);
  const settleEach = Math.max(8, Math.round(pointer.settleMs / settleSteps));
  for (let i = 0; i < settleSteps; i++) {
    const jx = to.x + (rng() - 0.5) * pointer.noiseFloorPx * 0.6;
    const jy = to.y + (rng() - 0.5) * pointer.noiseFloorPx * 0.6;
    steps.push({
      x: round2(jx),
      y: round2(jy),
      delayMs: Math.round(settleEach * (0.7 + rng() * 0.6)),
      phase: 'settle',
    });
  }

  const durationMs = steps.reduce((sum, s) => sum + s.delayMs, 0);
  return {
    steps,
    durationMs,
    directPx: Math.round(directPx),
    pathPx: Math.round(pathPx || directPx),
    overshot: overshoot > 0,
    targetWidthPx: width,
  };
}

/**
 * Plan a scroll: bursts of differing amplitude, pauses to read, occasional regressions.
 *
 * One `scrollTo(y)` is the shape of a machine. A person drags the wheel in short pushes, stops, and
 * sometimes goes back up a little because the last line was worth re-reading.
 */
export function planScroll(
  profile: HumanProfile,
  rng: () => number,
  direction: 1 | -1 = 1,
): Array<{ dy: number; pauseMs: number; regression: boolean }> {
  const s = profile.scroll;
  const count = Math.round(s.burstMin + rng() * (s.burstMax - s.burstMin));
  const out: Array<{ dy: number; pauseMs: number; regression: boolean }> = [];
  for (let i = 0; i < count; i++) {
    const amp = Math.round(s.amplitudeMinPx + rng() * (s.amplitudeMaxPx - s.amplitudeMinPx));
    out.push({
      dy: amp * direction,
      pauseMs: Math.round(s.pauseMinMs + rng() * (s.pauseMaxMs - s.pauseMinMs)),
      regression: false,
    });
    if (rng() < s.regressionRate) {
      const back = Math.round(amp * (0.15 + rng() * 0.35));
      out.push({ dy: -back * direction, pauseMs: Math.round(s.pauseMinMs + rng() * s.pauseMaxMs), regression: true });
    }
  }
  return out;
}

export interface KeyStep {
  /** A Playwright key name: a single character, or `Space`, `Enter`, `Backspace`. */
  key: string;
  holdMs: number;
  /** Gap after the key-up, before the next key-down. */
  gapMs: number;
  kind: 'key' | 'mistake' | 'correction';
}

/**
 * QWERTY adjacency, used by the mistake model.
 *
 * The first version listed nine letters, so `typo_rate` was a probability that mostly could not fire: a
 * text of 43 characters with a 20% typo rate produced one mistake, because 26 of its letters had no
 * neighbours to slip to. A rate that cannot act on most keys is not a rate, so the whole row is mapped.
 */
const NEIGHBOURS: Record<string, string[]> = {
  q: ['w', 'a'],
  w: ['q', 'e', 's'],
  e: ['w', 'r', 'd'],
  r: ['e', 't', 'f'],
  t: ['r', 'y', 'g'],
  y: ['t', 'u', 'h'],
  u: ['y', 'i', 'j'],
  i: ['u', 'o', 'k'],
  o: ['i', 'p', 'l'],
  p: ['o', ';', 'l'],
  a: ['q', 's', 'z'],
  s: ['a', 'w', 'd', 'x'],
  d: ['s', 'e', 'f', 'c'],
  f: ['d', 'r', 'g', 'v'],
  g: ['f', 't', 'h', 'b'],
  h: ['g', 'y', 'j', 'n'],
  j: ['h', 'u', 'k', 'm'],
  k: ['j', 'i', 'l'],
  l: ['k', 'o', 'p'],
  z: ['a', 's', 'x'],
  x: ['z', 's', 'd', 'c'],
  c: ['x', 'd', 'f', 'v'],
  v: ['c', 'f', 'g', 'b'],
  b: ['v', 'g', 'h', 'n'],
  n: ['b', 'h', 'j', 'm'],
  m: ['n', 'j', 'k', 'l'],
};

/**
 * Plan a typing run: per-key down/up with cadence, word-boundary pauses, and seeded mistakes that are then
 * corrected with backspaces.
 *
 * The mistake is not decoration. A stream of characters with zero corrections and a constant gap is the
 * easiest thing in a trace to spot; a person's text has a rhythm that breaks at word boundaries and
 * occasionally has to be taken back. The count is a probability, so most runs have no typo at all.
 */
export function planTyping(text: string, profile: HumanProfile, rng: () => number): KeyStep[] {
  const k = profile.keyboard;
  const steps: KeyStep[] = [];
  const msPerChar = (120 / k.wpm) * 1000; // 120 characters per "word" by the five-character convention.
  let previous = '';
  for (const ch of text) {
    const lower = ch.toLowerCase();
    if (rng() < k.typoRate && NEIGHBOURS[lower]) {
      const wrong = NEIGHBOURS[lower][rng() < 0.5 ? 0 : 1];
      steps.push({
        key: ch === ch.toUpperCase() && ch !== ch.toLowerCase() ? wrong.toUpperCase() : wrong,
        holdMs: Math.round(k.holdMinMs + rng() * (k.holdMaxMs - k.holdMinMs)),
        gapMs: Math.round(msPerChar * (0.5 + rng())),
        kind: 'mistake',
      });
      const fixes = 1 + (rng() < 0.3 ? 1 : 0);
      for (let i = 0; i < fixes; i++) {
        steps.push({
          key: 'Backspace',
          holdMs: 45 + Math.round(rng() * 40),
          gapMs: Math.round(60 + rng() * 120),
          kind: 'correction',
        });
      }
    }
    const keyName = ch === ' ' ? 'Space' : ch;
    let gap = Math.round(msPerChar * (0.55 + rng() * 0.95));
    if (previous === ' ') gap += Math.round(k.wordPauseMs * (0.4 + rng()));
    if (/[,.!?;:]/.test(previous)) gap += Math.round(k.punctPauseMs * (0.5 + rng()));
    if (previous === '.' || previous === '?' || previous === '!')
      gap += Math.round(k.sentencePauseMs * (0.3 + rng() * 0.9));
    steps.push({
      key: keyName,
      holdMs: Math.round(k.holdMinMs + rng() * (k.holdMaxMs - k.holdMinMs)),
      gapMs: gap,
      kind: 'key',
    });
    previous = ch;
  }
  return steps;
}

/** How long a person spends on `words` words at the profile's reading speed. */
export function planDwell(words: number, profile: HumanProfile, rng: () => number): number {
  const wpm = profile.attention.readWpm;
  const base = (words / wpm) * 60_000;
  return Math.round(base * (0.75 + rng() * 0.6));
}

/**
 * The gap the idle scheduler should wait before its next micro-movement.
 *
 * It must be shorter than the profile's stillness ceiling, and it must not be the same number twice: a
 * fixed 200 ms heartbeat is a pattern, and a pattern is what this whole module is trying not to be.
 */
export function nextIdleGap(profile: HumanProfile, rng: () => number): number {
  const ceiling = profile.pointer.idleStillnessMs;
  return Math.max(40, Math.round(ceiling * (0.35 + rng() * 0.5)));
}

/** A drift position near the current one, inside the viewport, that keeps the pointer from being exactly still. */
export function planDrift(current: Point, viewport: Point, profile: HumanProfile, rng: () => number): Point {
  const d = profile.pointer.driftPx;
  const x = current.x + (rng() - 0.5) * 2 * d;
  const y = current.y + (rng() - 0.5) * 2 * d;
  return { x: round2(Math.min(viewport.x - 2, Math.max(2, x))), y: round2(Math.min(viewport.y - 2, Math.max(2, y))) };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
