import { describe, it, expect, afterAll } from 'vitest';
import '../src/loader.js';
import { callTool } from '../src/router.js';
import { closeAll } from '../src/core/browser-use-session.js';
import { playwrightAvailable } from '../src/core/browser-tools.js';
import { hostReachable } from './helpers/liveGate.js';
import { skipBlockWithout } from './helpers/env-guard.js';
import type { ToolResult } from '../src/core/types.js';

/**
 * The session half of the pack, against a real browser and a real page.
 *
 * These tests catch what offline ones cannot: a session that opens but never reads, an identity that
 * stops resolving, a page judged navigated when it was only re-read. They need the network because the
 * SSRF guard refuses every non-http(s) scheme — `data:` and `about:` included — and that refusal is
 * asserted below rather than worked around.
 *
 * The assertions are invariants, not the shape of one site: example.com has changed its layout more than
 * once, and a test that expected its link to sit inside a 720-pixel viewport would fail while the engine
 * kept working correctly.
 */

function text(result: ToolResult): string {
  return (result.content ?? [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text ?? '')
    .join('\n');
}

function payload(result: ToolResult): Record<string, unknown> {
  const match = /```json\n([\s\S]*?)\n```/.exec(text(result));
  return match ? (JSON.parse(match[1]) as Record<string, unknown>) : {};
}

const browser = await playwrightAvailable();
const online = await hostReachable('https://example.com/');
const LIVE = browser && online;
if (!LIVE) {
  skipBlockWithout(
    'tests/browser-use-session.test.ts',
    'browser+network',
    !browser ? 'no launchable browser on this host (npx playwright install chromium)' : 'example.com did not answer',
    false,
  );
}
const PAGE = 'https://example.com/';

async function openSession(): Promise<string> {
  const opened = payload(await callTool('pro_browser_use_session_open', { url: PAGE, outline: false }));
  expect(opened.ok, JSON.stringify(opened)).toBe(true);
  return String(opened.session_id);
}

// 180s per test rather than the 60s default: every case drives a real Chromium through launch, work and
// teardown, and under a full parallel run this file measured about five times slower than the same tests
// alone (184s for 15 tests). The allowance excuses wall-clock only — an assertion that genuinely fails
// still fails the build.
describe.skipIf(!LIVE)('a live session', { timeout: 180_000 }, () => {
  afterAll(async () => {
    await closeAll();
  });

  it('opens a page, reads it once, and owns a temporary profile', async () => {
    const opened = payload(await callTool('pro_browser_use_session_open', { url: PAGE }));
    expect(String(opened.session_id)).toMatch(/^bu-/);
    expect(opened.product).toBeTruthy();
    expect(Number(opened.nodes_in_latest)).toBeGreaterThan(0);
    expect(String(opened.url)).toBe(PAGE);
    expect(String(opened.profile)).toContain('temporary');
    expect(String(opened.document)).toMatch(/^[0-9a-f]{8}$/);

    const status = payload(await callTool('pro_browser_use_session_status', { session_id: String(opened.session_id) }));
    expect(status.model_version).toBe(1);
    // Coverage may be incomplete on a page taller than the viewport; it has to say so, not look finished.
    expect(String(status.coverage)).toMatch(/band|coverage/i);
  });

  it('re-reads the same document without declaring a navigation', async () => {
    const session = await openSession();
    const first = payload(await callTool('pro_browser_use_snapshot', { session_id: session, outline: false }));
    const second = payload(await callTool('pro_browser_use_snapshot', { session_id: session, outline: false }));

    expect(Number(first.version)).toBe(2);
    expect(Number(second.version)).toBe(3);
    expect(second.document).toBe(first.document);
    expect((second.transition as Record<string, unknown>).kind).not.toBe('NAVIGATED');
    // A page nobody touched must not invent changes. If this fires, identity is unstable.
    const delta = second.delta as Record<string, unknown>;
    expect(delta.added).toEqual([]);
    expect(delta.removed).toEqual([]);
    expect(delta.relabelled).toEqual([]);
  });

  it('reports identifiers that can be re-checked, and answers honestly about the rest', async () => {
    const session = await openSession();
    const snapshot = payload(await callTool('pro_browser_use_snapshot', { session_id: session, outline: false }));
    const sample = (snapshot.sample ?? []) as Array<Record<string, unknown>>;
    expect(sample.length, 'the snapshot carried no node identifiers').toBeGreaterThan(0);
    const node = sample.find((n) => n.interactable === true) ?? sample[0]!;
    expect(String(node.identity)).toMatch(/^[0-9a-f]{8}$/);

    const checked = payload(
      await callTool('pro_browser_use_element_check', {
        session_id: session,
        identity: String(node.identity),
        backend_id: String(node.backend_id),
        token: String(node.token),
      }),
    );
    if (node.interactable === true) {
      expect(checked.staleness, JSON.stringify(checked)).toBe('FRESH');
      expect(checked.actionable).toBe(true);
      return;
    }
    // Nothing in the sample was clickable. The answer must say which kind of node it is and why it is
    // not reachable — never imply a change the engine has no evidence for.
    //
    // The forbidden list used to include `hit-test at the centre`, one of the engine's honest reasons
    // for an on-screen node being unclickable (browser-use-perception.ts). That made the assertion
    // depend on what the page happened to look like: on Linux the sample's first node reported a
    // different cause and the job passed, on Windows runners it reported the hit-test and the same
    // commit failed twice. What must never appear is a claim that the element changed or vanished —
    // the staleness words below are the actual lie.
    expect(checked.staleness).toBe('CHANGED');
    expect(String(checked.reason)).toMatch(
      /is not an interactive element|not reachable right now|outside the viewport/,
    );
    expect(String(checked.reason)).not.toMatch(/no longer|was removed|replaced/);
  });

  it('refuses a target the guard blocks, before starting a browser', async () => {
    for (const url of ['http://127.0.0.1:9/admin', 'http://169.254.169.254/latest/meta-data/', 'file:///etc/passwd']) {
      const result = payload(await callTool('pro_browser_use_session_open', { url }));
      expect(result.ok, url).toBe(false);
      expect(String(result.error).length, url).toBeGreaterThan(10);
      expect(String(result.hint) + String(result.error), url).toMatch(/loopback|private|protokol|Ruxsat|refus/i);
    }
  });

  it('lists an open session and closes it', async () => {
    const session = await openSession();
    const list = payload(await callTool('pro_browser_use_sessions_list', {}));
    const ids = (list.sessions as Array<Record<string, unknown>>).map((s) => String(s.session_id ?? ''));
    expect(ids).toContain(session);

    const closed = payload(await callTool('pro_browser_use_session_close', { session_id: session }));
    expect(closed.ok).toBe(true);
    const after = payload(await callTool('pro_browser_use_sessions_list', {}));
    expect(
      (after.sessions as Array<unknown>).map((s) => String((s as Record<string, unknown>).session_id)),
    ).not.toContain(session);
  });

  it('scans to full coverage and the ledger agrees', async () => {
    const session = await openSession();
    const scanned = payload(await callTool('pro_browser_use_scan', { session_id: session, max_steps: 10 }));
    expect(scanned.ok, JSON.stringify(scanned)).toBe(true);
    expect(scanned.complete).toBe(true);
    expect(Number(scanned.visited)).toBe(Number(scanned.bands));
    expect(Array.isArray(scanned.only_found_by_scrolling)).toBe(true);

    const coverage = payload(await callTool('pro_browser_use_coverage', { session_id: session }));
    expect(coverage.complete).toBe(true);
    expect(coverage.ratio).toBe(1);
    expect((coverage.bands as Array<Record<string, unknown>>).every((b) => b.visited === true)).toBe(true);
  });

  it('scrolls to the very top when asked for position 0', async () => {
    const session = await openSession();
    await callTool('pro_browser_use_scroll', { session_id: session, to_y: 400 });
    const back = payload(await callTool('pro_browser_use_scroll', { session_id: session, to_y: 0 }));
    // A numeric helper with a floor of 1 turned this into "scroll to 1px", which is invisible to the eye
    // and fatal to a page whose top element sits at y 0.
    expect(back.scroll_y, JSON.stringify(back)).toBe(0);
    expect(back.ok).toBe(true);
  });

  it('captures the viewport at the size it reports', async () => {
    const session = await openSession();
    const captured = await callTool('pro_browser_use_screenshot', { session_id: session, kind: 'viewport' });
    const shot = payload(captured);
    expect(shot.ok).toBe(true);
    // The bytes are their own content item, so a big capture cannot be truncated into invalid JSON.
    const base64 = String(captured.content?.[1]?.text ?? '');
    const image = (shot.geometry as Record<string, unknown>).image as { width: number; height: number };
    expect(image.width).toBeGreaterThan(0);
    const sharp = (await import('sharp')).default;
    const meta = await sharp(Buffer.from(base64, 'base64')).metadata();
    expect(meta.width).toBe(image.width);
    expect(meta.height).toBe(image.height);
  });

  it('renders reading-order text and answers a region query', async () => {
    const session = await openSession();
    const read = payload(await callTool('pro_browser_use_read', { session_id: session }));
    expect(read.ok).toBe(true);
    expect(Number(read.lines)).toBeGreaterThan(0);
    expect(String(read.text)).toMatch(/[A-Za-z]/);

    const snapshot = payload(await callTool('pro_browser_use_snapshot', { session_id: session, outline: false }));
    expect(Number(snapshot.nodes)).toBeGreaterThan(0);
    const region = payload(
      await callTool('pro_browser_use_region', {
        session_id: session,
        rect: JSON.stringify({ x: 0, y: 0, width: 1280, height: 720 }),
      }),
    );
    expect(region.ok).toBe(true);
    expect(Array.isArray(region.elements)).toBe(true);

    const hit = payload(await callTool('pro_browser_use_hit_test', { session_id: session, x: 5, y: 5 }));
    expect(hit.ok).toBe(true);
    expect(Array.isArray(hit.stack)).toBe(true);

    const frames = payload(await callTool('pro_browser_use_frames', { session_id: session }));
    const list = frames.frames as Array<Record<string, unknown>>;
    expect(list.some((f) => f.frame_id === 'main')).toBe(true);
  });

  it('outlines, reports history, extracts records and resizes with all three numbers agreeing', async () => {
    const session = await openSession();
    await callTool('pro_browser_use_snapshot', { session_id: session, outline: false });

    const outline = payload(await callTool('pro_browser_use_outline', { session_id: session }));
    expect(outline.ok).toBe(true);
    expect(Number(outline.version)).toBe(2);
    expect(typeof outline.outline).toBe('string');

    const history = payload(await callTool('pro_browser_use_history', { session_id: session }));
    expect(history.ok).toBe(true);
    const entries = history.history as Array<Record<string, unknown>>;
    expect(entries.length).toBeGreaterThanOrEqual(2);
    const kinds = (history.transitions as Array<Record<string, unknown>>).map((t) => t.kind);
    expect(kinds).toContain('INITIAL');
    // A re-read of an untouched page must not be reported as a navigation.
    expect(kinds).not.toContain('NAVIGATED');

    const extracted = payload(await callTool('pro_browser_use_extract', { session_id: session }));
    expect(extracted.ok).toBe(true);
    expect(Array.isArray(extracted.records)).toBe(true);

    const resized = payload(await callTool('pro_browser_use_resize', { session_id: session, width: 500, height: 800 }));
    expect(resized.ok).toBe(true);
    expect(resized.consistent, JSON.stringify(resized)).toBe(true);
    expect((resized.inner as Record<string, unknown>).width).toBe(500);
    expect((resized.capture as Record<string, unknown>).width).toBe(500);
  });

  it('refuses a guarded navigation without breaking the session', async () => {
    const session = await openSession();
    const result = payload(
      await callTool('pro_browser_use_navigate', { session_id: session, to: 'http://127.0.0.1:9/x' }),
    );
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/Ruxsat|loopback|private|not allowed|bloklandi|SSRF/i);
    // A refusal is not a crash: the session still answers.
    const status = payload(await callTool('pro_browser_use_session_status', { session_id: session }));
    expect(status.ok).toBe(true);
  });

  it('refuses an action on an identity it never held, without touching the page', async () => {
    const session = await openSession();
    const before = payload(await callTool('pro_browser_use_session_status', { session_id: session }));
    const result = payload(
      await callTool('pro_browser_use_act', {
        session_id: session,
        action: 'click',
        identity: 'deadbeef',
        backend_id: 'pf-1',
      }),
    );
    expect(result.status).toBe('REFUSED');
    expect(String(result.reason)).toMatch(/GONE|NAVIGATED|never in the model/);
    const after = payload(await callTool('pro_browser_use_session_status', { session_id: session }));
    // A refusal is not an action: the model did not move.
    expect(after.model_version).toBe(before.model_version);
  });
});

describe('a browser that is not here', () => {
  it('refuses with the list of what is installed, instead of failing in a launch', async () => {
    // The same path a host without any browser would take: selection cannot satisfy the request, so the
    // answer names the products that do exist. Runs identically whether or not a browser is installed.
    const result = payload(await callTool('pro_browser_use_session_open', { url: PAGE, product: 'konqueror' }));
    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/no browser|not installed|installed/i);
    expect(String(result.error).length).toBeGreaterThan(20);
  });
});

describe('the guard is not bypassed by scheme tricks', () => {
  it('refuses data:, about: and javascript: targets', async () => {
    for (const url of ['data:text/html,hi', 'about:blank', 'javascript:alert(1)']) {
      const result = payload(await callTool('pro_browser_use_session_open', { url }));
      expect(result.ok, url).toBe(false);
      expect(String(result.error), url).toMatch(/protokol|scheme|Ruxsat/i);
    }
  });

  it('needs a session id that exists', async () => {
    const missing = await callTool('pro_browser_use_session_status', { session_id: 'bu-nope' });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/bu-nope/);
  });
});
