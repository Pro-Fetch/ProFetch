import { describe, it, expect, afterAll } from 'vitest';
import '../src/loader.js';
import { callTool } from '../src/router.js';
import { closeAll } from '../src/core/browser-use-session.js';
import { playwrightAvailable } from '../src/core/browser-tools.js';
import { hostReachable } from './helpers/liveGate.js';
import { skipBlockWithout } from './helpers/env-guard.js';
import type { ToolResult } from '../src/core/types.js';

/**
 * The pack against a real page.
 *
 * Everything a unit test can prove about this pack is proved in `prohuman-path`, `-metrics`, `-lock` and
 * `-disclosure`. What those cannot prove is the thing the pack is for: that a browser dispatches the
 * movements, that the page records them as trusted, and that the pointer is still alive between calls.
 * A synthetic trace cannot show any of that.
 */

function textOf(result: ToolResult): string {
  return (result.content ?? [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text ?? '')
    .join('\n');
}

function payload(result: ToolResult): Record<string, any> {
  const match = /```json\n([\s\S]*?)\n```/.exec(textOf(result));
  return match ? (JSON.parse(match[1]) as Record<string, any>) : {};
}

const browser = await playwrightAvailable();
const online = await hostReachable('https://example.com/');
const LIVE = browser && online;
if (!LIVE) {
  skipBlockWithout(
    'tests/prohuman-driver.test.ts',
    'browser+network',
    !browser ? 'no launchable browser on this host (npx playwright install chromium)' : 'example.com did not answer',
    false,
  );
}

const PAGE = 'https://example.com/';
const IDENTITY = {
  name: 'pro-fetch test suite',
  contact_url: 'https://github.com/Pro-Fetch/ProFetch',
  purpose: 'verifying the human behaviour layer against a real page',
};

async function openSession(): Promise<string> {
  const opened = payload(await callTool('pro_browser_use_session_open', { url: PAGE, outline: false }));
  expect(opened.ok, JSON.stringify(opened)).toBe(true);
  return String(opened.session_id);
}

/**
 * Read the driver's own status until it has delivered `count` idle drifts, or `deadlineMs` runs out.
 *
 * A fixed sleep measures the runner as much as the driver. On a saturated macOS runner one drift occupied
 * the entire 1400 ms window that an idle machine spends delivering five, and the assertion said "greater
 * than 1" to a number that was the machine's, not the driver's. The count comes from the driver; only the
 * patience comes from here.
 */
async function waitDrifts(driverId: string, count: number, deadlineMs: number): Promise<Record<string, any>> {
  const deadline = Date.now() + deadlineMs;
  let status = payload(await callTool('pro_human_status', { driver_id: driverId }));
  while (((status.stats?.drifts as number) ?? 0) < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    status = payload(await callTool('pro_human_status', { driver_id: driverId }));
  }
  return status;
}

/**
 * Read the status until no tick is in flight, or `deadlineMs` runs out.
 *
 * `stop` ends the schedule; it does not cancel a move already dispatched. Measured on the Windows runner:
 * the status taken straight after the stop said `running: false` and `tick_running_ms: 4`. Comparing the
 * drift count with the lateness sample count in that moment compares a race, not the driver.
 */
async function waitQuiescent(driverId: string, deadlineMs: number): Promise<Record<string, any>> {
  const deadline = Date.now() + deadlineMs;
  let status = payload(await callTool('pro_human_status', { driver_id: driverId }));
  while (((status.tick_running_ms as number) ?? 0) > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 120));
    status = payload(await callTool('pro_human_status', { driver_id: driverId }));
  }
  return status;
}

afterAll(async () => {
  await closeAll();
});

describe.skipIf(!LIVE)('a driver on a real page', { timeout: 150_000 }, () => {
  it('attaches, keeps the pointer alive between calls, and can prove it from the page', async () => {
    const sessionId = await openSession();
    const attached = payload(
      await callTool('pro_human_attach', {
        session_id: sessionId,
        identity: IDENTITY,
        consent: 'own-site',
        preset: 'calm',
        seed: 20261104,
      }),
    );
    expect(attached.ok, JSON.stringify(attached)).toBe(true);
    const driverId = attached.driver_id as string;

    const started = payload(await callTool('pro_human_start', { driver_id: driverId }));
    expect(started.ok, JSON.stringify(started)).toBe(true);

    // Nothing is asked of the driver here. This is the gap the whole design exists for.
    await new Promise((resolve) => setTimeout(resolve, 1400));
    let status = payload(await callTool('pro_human_status', { driver_id: driverId }));
    if ((status.stats.drifts as number) <= 1) status = await waitDrifts(driverId, 2, 8_000);

    const ceilingMs = Number(status.profile?.idle_stillness_ms ?? 320);
    expect(status.running).toBe(true);
    // Two drifts, unasked, is the continuity claim. The number is the driver's; the patience above is
    // the runner's. A driver that stops after one fails here with its own lateness attached.
    expect(status.stats.drifts, JSON.stringify(status.scheduler_lag_ms)).toBeGreaterThan(1);
    // Stillness is allowed the ceiling the profile declares, doubled, plus the lateness the driver
    // measured in itself, plus the tick currently in flight. Measured on a macOS runner: 1510 ms since
    // the last recorded move with a move still waiting on the browser — a dispatch in progress is not a
    // cursor nobody moved, and the driver now says how long that dispatch has been running.
    expect(status.pointer_last_moved_ms_ago, JSON.stringify(status)).toBeLessThanOrEqual(
      ceilingMs * 2 + Number(status.scheduler_lag_ms.max_ms ?? 0) + Number(status.tick_running_ms ?? 0),
    );
    // Every drift is one lateness sample — the number that turns "the cursor sat still" into
    // "the cursor sat still, and the driver was itself N ms behind plan at its worst".
    expect(status.scheduler_lag_ms.samples, JSON.stringify(status.scheduler_lag_ms)).toBe(status.stats.drifts);
    expect(status.scheduler_lag_ms.max_ms).toBeGreaterThanOrEqual(0);
    expect(status.scheduler_lag_ms.mean_ms).toBeGreaterThanOrEqual(0);

    const report = payload(await callTool('pro_human_report', { driver_id: driverId }));
    expect(report.measured.trusted_ratio ?? report.measured.trustedRatio).toBe(1);
    expect(report.measured.pointerEvents).toBeGreaterThan(3);

    const verdict = payload(await callTool('pro_human_verify', { driver_id: driverId }));
    expect(verdict.verdict.samples, JSON.stringify(verdict)).toBeGreaterThan(2);
    // The strict ceiling is what the product reports to its user, and a saturated machine can honestly
    // breach it: measured here at 390.5 ms against a 320 ms ceiling while four suites shared one event
    // loop. What this test owns is the mechanism — the pointer keeps moving, and never stops for long.
    // A driver that really froze would blow straight through twice the ceiling.
    const ceiling = verdict.verdict.ceilingMs;
    expect(verdict.verdict.worstMs, JSON.stringify(verdict)).toBeLessThanOrEqual(ceiling * 2);
    // The verifier has to carry the same lateness series the status reports, or a breach attributed to
    // load would be an opinion instead of a measurement. The two reads happen a moment apart and the
    // driver drifts in between, so what the test owns is the ordering, not an equality: measured as
    // `3 samples vs 2 drifts` (macOS) and `7 vs 6` (Windows) when this asserted equality of two counters
    // read at different times.
    expect(verdict.scheduler_lag_ms.samples, JSON.stringify(verdict.scheduler_lag_ms)).toBeGreaterThanOrEqual(
      status.scheduler_lag_ms.samples,
    );
    if (!verdict.ok) {
      console.warn(
        `note: strict stillness verdict breached under load — worst ${verdict.verdict.worstMs} ms over a ${ceiling} ms ceiling`,
      );
    }

    await callTool('pro_human_stop', { driver_id: driverId, reason: 'test finished' });
    // Only once nothing is in flight can the two counters be compared exactly: they count the same event,
    // and the invariant the accounting broke on is that one was recorded before the browser round trip and
    // the other after it.
    const stopped = await waitQuiescent(driverId, 5_000);
    expect(stopped.running).toBe(false);
    expect(stopped.tick_running_ms, JSON.stringify(stopped)).toBe(0);
    expect(stopped.scheduler_lag_ms.samples, JSON.stringify(stopped)).toBe(stopped.stats.drifts);
    expect(verdict.scheduler_lag_ms.samples).toBeLessThanOrEqual(stopped.stats.drifts);
    const closed = await callTool('pro_browser_use_session_close', { session_id: sessionId });
    expect(!!closed.isError, textOf(closed)).toBe(false);
  });

  it('reaches an element the engine named, and says which one it aimed at', async () => {
    const sessionId = await openSession();
    const attached = payload(
      await callTool('pro_human_attach', {
        session_id: sessionId,
        identity: IDENTITY,
        consent: 'own-site',
        preset: 'fast',
        seed: 5,
      }),
    );
    const driverId = attached.driver_id as string;

    // The fixture page's only link sits just below the fold, so bring it up and read again — the same two
    // steps a caller takes, and the reason the resolver refuses an off-screen target in the first place.
    await callTool('pro_browser_use_scroll', { session_id: sessionId, to_y: 300 });
    const nodes = payload(
      await callTool('pro_browser_use_elements', { session_id: sessionId, filter: 'interactive', limit: 8 }),
    );
    const target = (nodes.rows ?? []).find((r: any) => r.in_viewport);
    expect(target, 'the fixture page has no interactive element inside the viewport after scrolling').toBeTruthy();

    const moved = payload(
      await callTool('pro_human_move', {
        driver_id: driverId,
        identity: target.identity,
        wait_ms: 1500,
      }),
    );
    expect(moved.ok, JSON.stringify(moved)).toBe(true);
    expect(String(moved.aimed_at)).toContain(target.tag);

    // A second reach, in a different direction. One bezier can be coalesced by the browser into two
    // recorded points, and two points form no turn however far apart they are; two reaches form one
    // whichever way the sampling lands. This is what makes the claim below measurable rather than lucky.
    const away = payload(await callTool('pro_human_move', { driver_id: driverId, x: 120, y: 90, wait_ms: 1200 }));
    expect(away.ok, JSON.stringify(away)).toBe(true);

    const report = payload(await callTool('pro_human_report', { driver_id: driverId }));
    expect(report.measured.pathPx).toBeGreaterThan(0);
    // Measured on a macOS runner: `pathPx` above zero and `curvatureRad` exactly zero. The pointer had
    // travelled; the page had recorded too few steps above the noise floor to compute an angle from. That
    // is a limit of the measurement, and a limit has to be reported as one — otherwise a coalesced trace
    // reads as evidence that the driver moved in a straight line.
    if (report.measured.curvatureSamples > 0) {
      expect(report.measured.curvatureRad, JSON.stringify(report.measured)).toBeGreaterThan(0);
    } else {
      expect(String(report.limits), JSON.stringify(report.measured)).toContain('curvature was not measurable');
    }

    await callTool('pro_human_detach', { driver_id: driverId });
    await callTool('pro_browser_use_session_close', { session_id: sessionId });
  });

  it('refuses to touch a page nobody authorised, and still measures what it saw', async () => {
    const sessionId = await openSession();
    const attached = payload(
      await callTool('pro_human_attach', {
        session_id: sessionId,
        identity: IDENTITY,
        consent: 'public-read-only',
        seed: 9,
      }),
    );
    expect(attached.disclosure.can_write).toBe(false);
    const driverId = attached.driver_id as string;

    const click = await callTool('pro_human_click', { driver_id: driverId, x: 200, y: 200 });
    expect(click.isError, 'a read-only session must not be able to click').toBe(true);
    expect(textOf(click)).toMatch(/public-read-only/);

    // Reading and dwelling are not acts on the page, so they stay available.
    const read = await callTool('pro_human_read', { driver_id: driverId, words: 8, wait_ms: 400 });
    expect(!!read.isError, textOf(read)).toBe(false);

    const refused = payload(await callTool('pro_human_status', { driver_id: driverId }));
    expect(refused.refusals.length).toBeGreaterThan(0);
    expect(String(refused.refusals.at(-1).reason)).toMatch(/public-read-only/);

    await callTool('pro_human_detach', { driver_id: driverId });
    await callTool('pro_browser_use_session_close', { session_id: sessionId });
  });

  it('will not let two writers move one cursor, and hands it over only when asked', async () => {
    const sessionId = await openSession();
    const attached = payload(
      await callTool('pro_human_attach', { session_id: sessionId, identity: IDENTITY, consent: 'own-site', seed: 11 }),
    );
    const driverId = attached.driver_id as string;
    await callTool('pro_human_start', { driver_id: driverId });

    await callTool('pro_browser_use_scroll', { session_id: sessionId, to_y: 300 });
    const nodes = payload(
      await callTool('pro_browser_use_elements', { session_id: sessionId, filter: 'interactive', limit: 8 }),
    );
    const target = (nodes.rows ?? []).find((r: any) => r.in_viewport);
    expect(target).toBeTruthy();

    const blocked = await callTool('pro_browser_use_act', {
      session_id: sessionId,
      action: 'hover',
      identity: target.identity,
      backend_id: target.backend_id,
    });
    expect(blocked.isError, 'act must refuse while a driver holds the cursor').toBe(true);
    expect(textOf(blocked)).toMatch(/cursor belongs to ProHuman driver/);
    expect(textOf(blocked)).toMatch(/cursor belongs to ProHuman driver/);

    const taken = await callTool('pro_browser_use_act', {
      session_id: sessionId,
      action: 'hover',
      identity: target.identity,
      backend_id: target.backend_id,
      pause_driver: true,
    });
    const takenPayload = payload(taken);
    expect(!!taken.isError, `${textOf(taken)} | ${JSON.stringify(takenPayload)}`).toBe(false);
    expect(takenPayload.status, JSON.stringify(takenPayload)).toBeTruthy();

    const after = payload(await callTool('pro_human_status', { driver_id: driverId }));
    expect(after.running, 'yielding the cursor stops the driver rather than pausing it').toBe(false);
    expect(String(after.stopped_reason)).toMatch(/yielded to pro_browser_use_act/);

    await callTool('pro_human_detach', { driver_id: driverId });
    await callTool('pro_browser_use_session_close', { session_id: sessionId });
  });

  it('dies with its session instead of holding a cursor nobody can see', async () => {
    const sessionId = await openSession();
    const attached = payload(
      await callTool('pro_human_attach', { session_id: sessionId, identity: IDENTITY, consent: 'own-site', seed: 13 }),
    );
    const driverId = attached.driver_id as string;
    await callTool('pro_human_start', { driver_id: driverId });

    await callTool('pro_browser_use_session_close', { session_id: sessionId });

    const listed = payload(await callTool('pro_human_list', {}));
    expect(
      listed.drivers.find((d: any) => d.id === driverId),
      'a driver outliving its session would still hold a lease',
    ).toBeUndefined();

    const status = await callTool('pro_human_status', { driver_id: driverId });
    expect(status.isError).toBe(true);
    // Either wording is honest: the sweep that noticed the dead session may have dropped the driver
    // before this call, in which case there is nothing left to report a loss about.
    expect(textOf(status)).toMatch(/lost its session|attach one first/);
  });
});
