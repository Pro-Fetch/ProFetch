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

afterAll(async () => {
  await closeAll();
});

describe.skipIf(!LIVE)('a driver on a real page', () => {
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

    const status = payload(await callTool('pro_human_status', { driver_id: driverId }));
    expect(status.running).toBe(true);
    expect(status.stats.drifts).toBeGreaterThan(1);
    expect(status.pointer_last_moved_ms_ago).toBeLessThanOrEqual(1200);

    const report = payload(await callTool('pro_human_report', { driver_id: driverId }));
    expect(report.measured.trusted_ratio ?? report.measured.trustedRatio).toBe(1);
    expect(report.measured.pointerEvents).toBeGreaterThan(3);

    const verdict = payload(await callTool('pro_human_verify', { driver_id: driverId }));
    expect(verdict.ok, JSON.stringify(verdict)).toBe(true);
    expect(verdict.verdict.samples).toBeGreaterThan(2);

    await callTool('pro_human_stop', { driver_id: driverId, reason: 'test finished' });
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

    const report = payload(await callTool('pro_human_report', { driver_id: driverId }));
    expect(report.measured.pathPx).toBeGreaterThan(0);
    expect(report.measured.curvatureRad).toBeGreaterThan(0);

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
