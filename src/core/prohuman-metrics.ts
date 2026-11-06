/**
 * Measurement of what the page actually reported.
 *
 * ## Why this module exists separately from the planner
 *
 * `prohuman-path.ts` says what the driver intended. Intent is not evidence. A driver can plan a beautiful
 * curved path and the browser can coalesce the events, the page can be scrolled out from under it, or the
 * recorder can have been destroyed by a navigation — all of which happened during the M0 spike. The only
 * number worth reporting is the one computed from the events the page itself captured.
 *
 * ## The two mistakes this module was written after
 *
 * 1. **Stitching documents together.** The trace before a click and the trace after the navigation it
 *    caused are different coordinate systems. Joined into one polyline, the jump between them reads as a
 *    turn of ~1.4 radians — enormous curvature that describes a page load, not a hand. Every function here
 *    takes the events of *one* document.
 * 2. **Counting jitter as turning.** A hand resting on a button moves 1–2 px; the angle between two such
 *    steps is essentially random. Averaging those into the curvature of a 600 px reach turned a measured
 *    42 mrad path into a reported 923 mrad one. Steps below `noiseFloorPx` are excluded, and the floor is
 *    part of the profile so the exclusion is a stated number rather than a magic constant.
 */

import type { Point } from './prohuman-path.js';

export interface TraceEvent {
  /** `mousemove`, `mousedown`, `mouseup`, `click`, `keydown`, `keyup`, `wheel`, `blur`, `focus`. */
  type: string;
  /** `event.timeStamp`, ms since the document's own time origin. */
  t: number;
  /** `event.isTrusted` — true only for events the browser dispatched, which is the point of recording. */
  trusted: boolean;
  x: number | null;
  y: number | null;
  key: string | null;
  dy: number | null;
}

export interface Distribution {
  n: number;
  mean: number;
  sd: number;
  /** Standard deviation over the mean. A metronome has 0; a hand does not. */
  cv: number;
  p50: number;
  p95: number;
  max: number;
  min: number;
}

export interface TraceMetrics {
  events: number;
  pointerEvents: number;
  keydownEvents: number;
  wheelEvents: number;
  /** Fraction of recorded events with `isTrusted`. Anything below 1 means synthetic events were injected. */
  trustedRatio: number;
  /** Length of the recorded pointer polyline, in CSS px. */
  pathPx: number;
  /** Straight-line distance between the first and last recorded pointer positions. */
  displacementPx: number;
  /** Mean turn angle in radians, ignoring steps at or below the noise floor. */
  curvatureRad: number;
  /** How many turns `curvatureRad` averaged. Zero here means the angle was never measurable, not that the path was straight. */
  curvatureSamples: number;
  /** `pathPx / displacementPx`: 1.0 is a straight line; a curved reach is measurably above it. */
  tortuosity: number;
  interEventMs: Distribution;
  keyHoldMs: Distribution;
  /** Longest gap between pointer events, in ms. */
  stillnessMaxMs: number;
  /** Where that gap ended, as an offset from the first recorded event. */
  stillnessEndsAtMs: number;
  /** Backspaces recorded, which is how a correction shows up in evidence rather than in intent. */
  correctionCount: number;
  /** How many of the planned phases the trace covers, for a reader deciding whether the run is complete. */
  windowMs: number;
}

export function distribution(values: number[]): Distribution {
  if (!values.length) return { n: 0, mean: 0, sd: 0, cv: 0, p50: 0, p95: 0, max: 0, min: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  return {
    n: values.length,
    mean: round2(mean),
    sd: round2(sd),
    cv: mean ? round2(sd / mean) : 0,
    p50: round2(pick(0.5)),
    p95: round2(pick(0.95)),
    max: round2(sorted[sorted.length - 1]),
    min: round2(sorted[0]),
  };
}

/**
 * Mean absolute turn angle, and the number of turns it was computed from.
 *
 * The sample count is not decoration. `0` is a true measurement for a pointer that travelled in a straight
 * line, and no measurement at all for a trace the browser recorded as two points. Chrome coalescing on a
 * loaded runner produces the second case from a driver that moved exactly as planned — and a reported zero
 * without its sample count reads as evidence that the movement was synthetic.
 */
export function curvatureOf(points: Point[], noiseFloorPx: number): { meanRad: number; samples: number } {
  let sum = 0;
  let n = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const ax = points[i].x - points[i - 1].x;
    const ay = points[i].y - points[i - 1].y;
    const bx = points[i + 1].x - points[i].x;
    const by = points[i + 1].y - points[i].y;
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    if (la <= noiseFloorPx || lb <= noiseFloorPx) continue;
    const dot = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)));
    sum += Math.acos(dot);
    n++;
  }
  return { meanRad: n ? round3(sum / n) : 0, samples: n };
}

/** Mean absolute turn angle. Steps at or below `noiseFloorPx` are jitter and are not turns. */
export function curvatureRad(points: Point[], noiseFloorPx: number): number {
  return curvatureOf(points, noiseFloorPx).meanRad;
}

export function pathPx(points: Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++)
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return round2(total);
}

/**
 * Measure one document's trace.
 *
 * `noiseFloorPx` comes from the profile rather than being fixed here, so the same trace measured against a
 * different definition of jitter gives a different curvature — and the report says which definition it used.
 */
export function measureTrace(events: TraceEvent[], noiseFloorPx: number): TraceMetrics {
  const moves = events.filter((e) => e.type === 'mousemove' && typeof e.x === 'number' && typeof e.y === 'number');
  const points: Point[] = moves.map((e) => ({ x: e.x as number, y: e.y as number }));
  const times = moves.map((e) => e.t);
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);

  const downs = events.filter((e) => e.type === 'keydown');
  const holds: number[] = [];
  for (const down of downs) {
    const up = events.find((e) => e.type === 'keyup' && e.t > down.t && e.key === down.key);
    if (up) holds.push(up.t - down.t);
  }

  const first = events.length ? events[0].t : 0;
  const last = events.length ? events[events.length - 1].t : 0;
  let stillnessMax = 0;
  let stillnessEndsAt = 0;
  for (let i = 1; i < times.length; i++) {
    if (times[i] - times[i - 1] > stillnessMax) {
      stillnessMax = times[i] - times[i - 1];
      stillnessEndsAt = times[i] - first;
    }
  }

  const displacement =
    points.length > 1
      ? Math.hypot(points[points.length - 1].x - points[0].x, points[points.length - 1].y - points[0].y)
      : 0;
  const length = pathPx(points);
  const turns = curvatureOf(points, noiseFloorPx);

  return {
    events: events.length,
    pointerEvents: moves.length,
    keydownEvents: downs.length,
    wheelEvents: events.filter((e) => e.type === 'wheel').length,
    trustedRatio: events.length ? round3(events.filter((e) => e.trusted).length / events.length) : 0,
    pathPx: length,
    displacementPx: round2(displacement),
    curvatureRad: turns.meanRad,
    curvatureSamples: turns.samples,
    tortuosity: displacement > 1 ? round3(length / displacement) : 0,
    interEventMs: distribution(gaps),
    keyHoldMs: distribution(holds),
    stillnessMaxMs: round2(stillnessMax),
    stillnessEndsAtMs: round2(stillnessEndsAt),
    correctionCount: downs.filter((e) => e.key === 'Backspace').length,
    windowMs: round2(last - first),
  };
}

export interface StillnessVerdict {
  ok: boolean;
  /** The ceiling the check was made against. */
  ceilingMs: number;
  worstMs: number;
  /** Where the worst gap ended, relative to the first event. */
  worstAtMs: number;
  /** Gaps over the ceiling, counted: one long pause and thirty of them are different failures. */
  violations: number;
  /** Pointer events the verdict was computed from. Zero means the trace is empty, not that it was still. */
  samples: number;
}

/**
 * Did the pointer ever hold still longer than the profile allows?
 *
 * An empty trace is reported as a failure with its own reason. Treating "no events" as "no stillness" would
 * turn a broken recorder into a passing run, and a recorder that silently stopped is exactly the fault the
 * M0 spike found.
 */
export function stillnessVerdict(events: TraceEvent[], ceilingMs: number): StillnessVerdict {
  const moves = events.filter((e) => e.type === 'mousemove');
  if (moves.length < 2) {
    return { ok: false, ceilingMs, worstMs: 0, worstAtMs: 0, violations: 0, samples: moves.length };
  }
  let worst = 0;
  let worstAt = 0;
  let violations = 0;
  const first = moves[0].t;
  for (let i = 1; i < moves.length; i++) {
    const gap = moves[i].t - moves[i - 1].t;
    if (gap > worst) {
      worst = gap;
      worstAt = moves[i].t - first;
    }
    if (gap > ceilingMs) violations++;
  }
  return {
    ok: violations === 0,
    ceilingMs,
    worstMs: round2(worst),
    worstAtMs: round2(worstAt),
    violations,
    samples: moves.length,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
