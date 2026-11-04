/**
 * ProHuman M0 spike — the three assumptions the whole design rests on, tested before any module is written.
 *
 *  1. A page-side recorder captures the events ProHuman *actually produced*, with `isTrusted` and
 *     `timeStamp`. Intent is not evidence: a driver that logs its own plan proves nothing about what the
 *     browser dispatched.
 *  2. A driver loop inside this process keeps the pointer moving while no MCP call is in flight — the
 *     resident-driver decision. If a loop only runs during a tool call, the pointer is dead still between
 *     calls and the premise of the pack is false.
 *  3. A minimum-jerk path along a curved trajectory produces measurable geometry: path length, curvature,
 *     a settle window before the click, and a non-trivial coefficient of variation between events.
 *
 * What this spike deliberately does NOT test: whether any site classifies the session as automated. That is
 * not a claim ProHuman makes and not a metric it optimises. See the pack's disclosure layer.
 *
 * Run: npx tsx scripts/prohuman-spike.mts [url]
 */

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const { openSession, closeSession, livePage, refresh } = await import('../src/core/browser-use-session.js');

const TARGET = process.argv[2] ?? 'https://example.com/';
const OUT = path.resolve('benchmarks/prohuman');

/** A seeded PRNG, so a spike run can be reproduced exactly when a number looks wrong. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x668e1ded) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = mulberry32(20261104);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Minimum-jerk normalised velocity profile: slow start, single peak, soft stop.
 * `steps: N` in Playwright is linear in *distance*, which reads as a machine; this is linear in nothing.
 */
function minJerk(t: number): number {
  return 10 * t ** 3 - 15 * t ** 4 + 6 * t ** 5;
}

/** A quadratic Bezier between two points, bowed perpendicular to the direction of travel. */
function bezierPoint(p0: { x: number; y: number }, p1: { x: number; y: number }, bow: number, t: number, sign: number) {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const len = Math.hypot(dx, dy) || 1;
  // Perpendicular unit vector, scaled by the bow. `sign` is chosen once per path: the side a hand leans to
  // is a property of the movement, not of the sample, and picking it per sample turns the curve into a zigzag.
  const nx = -dy / len;
  const ny = dx / len;
  const cx = (p0.x + p1.x) / 2 + nx * bow * sign;
  const cy = (p0.y + p1.y) / 2 + ny * bow * sign;
  const mt = 1 - t;
  return {
    x: mt * mt * p0.x + 2 * mt * t * cx + t * t * p1.x,
    y: mt * mt * p0.y + 2 * mt * t * cy + t * t * p1.y,
  };
}

type TraceEvent = {
  type: string;
  t: number;
  trusted: boolean;
  x: number | null;
  y: number | null;
  key: string | null;
  dy: number | null;
};

const pageUrl = (href: string): string => String(href).replace(/^https?:\/\/(\/?[^/]+).*$/, '$1');

const log: string[] = [];
function say(line: string): void {
  console.log(line);
  log.push(line);
}

function stats(values: number[]): { mean: number; sd: number; cv: number; p50: number; p95: number; max: number } {
  if (!values.length) return { mean: 0, sd: 0, cv: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
  return {
    mean,
    sd,
    cv: mean ? sd / mean : 0,
    p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
    p95: sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1],
    max: sorted[sorted.length - 1],
  };
}

/** Mean absolute turn angle along a polyline: 0 means a dead straight line, which no hand draws. */
function meanCurvature(points: Array<{ x: number; y: number }>): number {
  let sum = 0;
  let n = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const a = { x: points[i].x - points[i - 1].x, y: points[i].y - points[i - 1].y };
    const b = { x: points[i + 1].x - points[i].x, y: points[i + 1].y - points[i].y };
    const la = Math.hypot(a.x, a.y);
    const lb = Math.hypot(b.x, b.y);
    // Below this step length the angle is jitter, not a turn: a 2px settle movement can point anywhere,
    // and averaging it in made this spike report its own curved path as unmeasurable.
    if (la < 5 || lb < 5) continue;
    const dot = Math.max(-1, Math.min(1, (a.x * b.x + a.y * b.y) / (la * lb)));
    sum += Math.acos(dot);
    n++;
  }
  return n ? sum / n : 0;
}

function pathLength(points: Array<{ x: number; y: number }>): number {
  let total = 0;
  for (let i = 1; i < points.length; i++)
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return total;
}

const session = await openSession({ url: TARGET, headless: true, viewport: { width: 1280, height: 800 } });
say(`# ProHuman M0 spike — ${new Date().toISOString()}`);
say(`target: ${TARGET} · session ${session.id}`);
// `livePage` is deliberately typed to the few methods the session bridge uses. ProHuman needs the input
// primitives too, and the honest way to say that is a local structural type at the seam — this spike is
// where the assumption gets tested, not where it gets asserted.
type HumanPage = {
  evaluate<T>(script: string): Promise<T>;
  addInitScript(script: { content: string } | string): Promise<void>;
  mouse: {
    move(x: number, y: number): Promise<void>;
    down(options?: { button?: string; clickCount?: number }): Promise<void>;
    up(options?: { button?: string; clickCount?: number }): Promise<void>;
    click(x: number, y: number): Promise<void>;
    wheel(dx: number, dy: number): Promise<void>;
  };
  keyboard: {
    down(key: string): Promise<void>;
    up(key: string): Promise<void>;
    press(key: string): Promise<void>;
    type(text: string, options?: { delay?: number }): Promise<void>;
  };
};
const page = livePage(session) as unknown as HumanPage;
await refresh(session, { budget: 200 });

// 1 · The recorder lives in the page and reports what the browser dispatched, not what we meant to do.
// It is a string, not a function: tsx annotates transpiled functions with a `__name` helper that does not
// exist inside the page, and the evaluate would throw before the recorder ever attached.
const RECORDER_SCRIPT = `(function () {
  window.__pfTrace = [];
  var push = function (e) {
    window.__pfTrace.push({
      type: e.type,
      t: e.timeStamp,
      trusted: e.isTrusted,
      x: typeof e.clientX === 'number' ? Math.round(e.clientX * 100) / 100 : null,
      y: typeof e.clientY === 'number' ? Math.round(e.clientY * 100) / 100 : null,
      key: typeof e.key === 'string' ? e.key : null,
      dy: typeof e.deltaY === 'number' ? e.deltaY : null,
    });
  };
  ['mousemove','mousedown','mouseup','click','keydown','keyup','wheel','blur','focus'].forEach(function (kind) {
    window.addEventListener(kind, push, { capture: true, passive: true });
  });
  return true;
})()`;
await page.evaluate(RECORDER_SCRIPT);
// The click below navigates, and the navigation destroys the document the recorder was installed in.
// Re-arming it for every future document is the only way the trace survives its own action — a lesson the
// spike found by failing, not by being told.
await page.addInitScript(RECORDER_SCRIPT);

const TARGET_SCRIPT = `(function () {
  var link = document.querySelector('a');
  if (!link) return null;
  var r = link.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
})()`;
const target = (await page.evaluate(TARGET_SCRIPT)) as { x: number; y: number; w: number; h: number } | null;
say(`pointer target: ${target ? `${target.x},${target.y} ${target.w}x${target.h}` : 'no link found'}`);

// 2 · A human-ish path: curved, minimum-jerk, sampled at a rate the browser will report as many events.
const start = { x: 80, y: 640 };
const bow = 40 + rnd() * 90;
const bowSign = rnd() < 0.5 ? -1 : 1;
const samples = 34;
const sentPoints: Array<{ x: number; y: number }> = [];
const sentTimes: number[] = [];
let lastT = performance.now();
for (let i = 0; i <= samples; i++) {
  const t = i / samples;
  const eased = minJerk(t);
  const p = bezierPoint(start, target ?? { x: 600, y: 300 }, bow, eased, bowSign);
  await page.mouse.move(p.x, p.y);
  const now = performance.now();
  sentPoints.push(p);
  sentTimes.push(now - lastT);
  lastT = now;
  await sleep(6 + Math.round(rnd() * 12));
}
say(`sent path: ${sentPoints.length} samples, ${Math.round(pathLength(sentPoints))} px, bow ${Math.round(bow)} px`);

const TRACE_READ = `(function () {
  var out = [];
  if (!window.__pfTrace) return out;
  for (var i = 0; i < window.__pfTrace.length; i++) out.push(window.__pfTrace[i]);
  return out;
})()`;

// 3 · Settle: a hand stops for a moment before it clicks; a machine does not need to.
for (let i = 0; i < 4; i++) {
  await page.mouse.move((target?.x ?? 600) + (rnd() - 0.5) * 2, (target?.y ?? 300) + (rnd() - 0.5) * 2);
  await sleep(18 + Math.round(rnd() * 40));
}
const pathTrace = (await page.evaluate(TRACE_READ)) as TraceEvent[];
await page.mouse.down();
await sleep(45 + Math.round(rnd() * 60));
await page.mouse.up();

// 4 · Typing with cadence, a mistake, and a correction.
await page.keyboard.type('ProHuman spike: the quick brown fox ', { delay: 0 });
// The line above is the control: a single API call, no per-key rhythm. Now the real one:
const text = 'jumps over the lazy dog.';
for (const ch of text) {
  await page.keyboard.down(ch === ' ' ? 'Space' : ch);
  const hold = 55 + Math.round(rnd() * 70);
  await sleep(hold);
  await page.keyboard.up(ch === ' ' ? 'Space' : ch);
  const gap = ch === ' ' ? 90 + Math.round(rnd() * 90) : 45 + Math.round(rnd() * 80);
  await sleep(gap);
}
await page.keyboard.press('Backspace');
await page.keyboard.type('.', { delay: 0 });

// 5 · Scroll in bursts with pauses, not one jump.
for (let i = 0; i < 4; i++) {
  await page.mouse.wheel(0, 60 + Math.round(rnd() * 180));
  await sleep(90 + Math.round(rnd() * 260));
}

// 6 · The resident-loop assumption: a fidget loop must keep producing events while nothing else runs.
const beforeIdle = (await page.evaluate('window.__pfTrace.length')) as number;
const loopStop = Date.now() + 2500;
let fidgets = 0;
(async () => {
  while (Date.now() < loopStop) {
    const jitter = 2 + rnd() * 3;
    await page.mouse.move((target?.x ?? 600) + jitter, (target?.y ?? 300) - jitter);
    fidgets++;
    await sleep(40 + Math.round(rnd() * 120));
  }
})();
// Nothing else happens here on purpose: this is the gap between two MCP calls.
await sleep(2600);
const afterIdle = (await page.evaluate('window.__pfTrace.length')) as number;
say(
  `resident loop: ${afterIdle - beforeIdle} event(s) recorded while no call was in flight, ${fidgets} fidget(s) sent`,
);

// The click navigated; the new document has its own recorder and its own trace.
const postNavTrace = (await page.evaluate(TRACE_READ)) as TraceEvent[];
say(
  `after the click the page is ${pageUrl(await page.evaluate('String(document.location.href)'))} — ${postNavTrace.length} event(s) recorded in the new document`,
);

// 7 · Read the trace back and measure it.
const trace = [...pathTrace, ...postNavTrace];

// Two documents, two measurements. Stitching them into one polyline is the mistake this spike made first:
// the navigation jump reads as a 1.4 rad turn, which is an artefact of the join and not a property of any
// path a pointer took. Geometry belongs to the document the pointer actually moved in.
const geometryOf = (events: TraceEvent[]) => {
  const pts = events
    .filter((e) => e.type === 'mousemove')
    .filter((e) => typeof e.x === 'number' && typeof e.y === 'number')
    .map((e) => ({ x: e.x as number, y: e.y as number, t: e.t }));
  const deltas: number[] = [];
  for (let i = 1; i < pts.length; i++) deltas.push(pts[i].t - pts[i - 1].t);
  return {
    points: pts.length,
    px: pathLength(pts),
    curvature: meanCurvature(pts),
    deltas: stats(deltas),
    stillness: deltas.length ? Math.max(...deltas) : 0,
  };
};

const pathDoc = geometryOf(pathTrace);
const postDoc = geometryOf(postNavTrace);
const trustedOf = (events: TraceEvent[]) =>
  events.length ? events.filter((e) => e.trusted).length / events.length : 0;
const trustedRatio = trustedOf(trace);

const keyDown = postNavTrace.filter((e) => e.type === 'keydown');
const holds: number[] = [];
for (const down of keyDown) {
  const up = postNavTrace.find((e) => e.type === 'keyup' && e.t > down.t && e.key === down.key);
  if (up) holds.push(up.t - down.t);
}
const wheelEvents = postNavTrace.filter((e) => e.type === 'wheel');

// Stillness across the whole session, pointer events only — including the gap while the keyboard was busy.
const allMoveTimes = trace.filter((e) => e.type === 'mousemove').map((e) => e.t);
const stillnessGaps: number[] = [];
for (let i = 1; i < allMoveTimes.length; i++) stillnessGaps.push(allMoveTimes[i] - allMoveTimes[i - 1]);
const worstStillness = stillnessGaps.length ? Math.max(...stillnessGaps) : 0;

say('');
say('## measured from the page, not from the driver');
say(`events recorded: ${trace.length} · isTrusted ratio ${trustedRatio.toFixed(3)}`);
say(
  `document 1 (the path): ${pathDoc.points} pointer events · ${Math.round(pathDoc.px)} px · ` +
    `mean curvature ${(pathDoc.curvature * 1000).toFixed(1)} mrad · inter-event CV ${pathDoc.deltas.cv.toFixed(2)}`,
);
say(
  `document 2 (after the click): ${postDoc.points} pointer events · ${keyDown.length} keydown · ${wheelEvents.length} wheel`,
);
const hstat = stats(holds);
say(`key holds: n=${holds.length} · mean ${hstat.mean.toFixed(1)} ms · CV ${hstat.cv.toFixed(2)}`);
say(`longest pointer stillness, whole session: ${worstStillness.toFixed(0)} ms`);

const pathIsCurved = pathDoc.curvature > 0.005 && pathDoc.curvature < 0.6;
const assumptions = [
  ['trusted events reach the page recorder', trustedRatio === 1],
  ['the pointer moved while no call was in flight', afterIdle - beforeIdle > 5],
  ['the path is curved, not a straight interpolation', pathIsCurved],
  ['the timing is not a metronome', pathDoc.deltas.cv > 0.2],
];
say('');
for (const [name, ok] of assumptions) say(`${ok ? 'HOLDS' : 'FAILS '}: ${name}`);
const failed = assumptions.filter((a) => !a[1]);
say(
  failed.length === 0
    ? 'VERDICT: all four assumptions hold on a live page. The pack may be built on this design.'
    : `VERDICT: ${failed.length} assumption(s) did not hold — the design must change before any module is written.`,
);
say(
  worstStillness > 1500
    ? `NOTE: the pointer sat still for ${worstStillness.toFixed(0)} ms while the keyboard was busy. A fidget loop that only runs between calls is not enough — it has to run concurrently with typing and scrolling.`
    : 'NOTE: no long pointer stillness observed during this run.',
);

await mkdir(OUT, { recursive: true });
const file = path.join(OUT, `spike-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await writeFile(
  file,
  JSON.stringify(
    {
      target: TARGET,
      session: session.id,
      counts: { events: trace.length, keydown: keyDown.length, wheel: wheelEvents.length },
      trustedRatio,
      document1Path: {
        pointerEvents: pathDoc.points,
        px: Math.round(pathDoc.px),
        curvatureMeanRad: pathDoc.curvature,
        interEventCv: pathDoc.deltas.cv,
        bow: Math.round(bow),
      },
      document2AfterClick: { pointerEvents: postDoc.points, keydown: keyDown.length, wheel: wheelEvents.length },
      stillnessMaxMs: worstStillness,
      keyHoldMs: hstat,
      residentLoop: { eventsWhileIdle: afterIdle - beforeIdle, fidgetsSent: fidgets },
      sentSamples: sentPoints.length,
    },
    null,
    2,
  ) + '\n',
  'utf8',
);
say(`wrote ${path.relative(process.cwd(), file)}`);
await writeFile(path.join(OUT, 'spike-log.md'), log.join('\n') + '\n', 'utf8');

await closeSession(session.id);
say('session closed');
