import { describe, it, expect } from 'vitest';
import '../src/loader.js';
import { callTool } from '../src/router.js';
import { allTools } from '../src/core/tool.js';
import { isToolVisibleInProfile } from '../src/core/profile.js';
import { identityOf } from '../src/core/browser-use-perception.js';
import type { ToolResult } from '../src/core/types.js';

/**
 * The `browser_use` pack, tested through the router rather than by importing its modules.
 *
 * That distinction matters: these tools exist so a model can ask a question through MCP, and the
 * interesting failures are in the plumbing — a JSON argument that is not parsed, an error returned as a
 * success, a tool visible in a profile that should not show it. Calling them by name exercises all of that.
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

const NODES = JSON.stringify([
  {
    backendId: 'pf-1',
    token: 't1',
    frameId: 'main',
    path: 'html>body>div>button[1]',
    tag: 'button',
    role: 'button',
    name: 'Add to cart',
    text: 'Add to cart',
    rect: { x: 100, y: 200, width: 120, height: 32 },
    inViewport: true,
    styleVisible: true,
    hitTestSelf: true,
    obstructed: false,
    depth: 4,
    interactive: true,
    boundaries: [],
  },
]);

const META = JSON.stringify({
  title: 'Cart',
  lang: '',
  hasViewportMeta: false,
  doctype: 'html',
  horizontalOverflow: 0,
  duplicateIdCount: 0,
  images: 3,
  imagesWithoutAlt: 2,
  frameCount: 0,
});

describe('the pack is registered and gated', () => {
  const tools = allTools().filter((t) => t.category === 'browser_use');

  it('registers a tool per capability area, each with a description worth reading', () => {
    expect(tools.length).toBeGreaterThanOrEqual(13);
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
    for (const tool of tools) {
      expect(tool.name.startsWith('pro_browser_use_')).toBe(true);
      expect(tool.description.length).toBeGreaterThan(60);
      expect(tool.inputSchema).toBeTruthy();
    }
  });

  it('is invisible to the small profiles and present in full', () => {
    const sample = tools[0]!;
    expect(isToolVisibleInProfile(sample, 'full')).toBe(true);
    expect(isToolVisibleInProfile(sample, 'standard')).toBe(false);
    expect(isToolVisibleInProfile(sample, 'minimal')).toBe(false);
    // `smart` advertises only meta-tools; the pack must not leak in through the back door.
    expect(isToolVisibleInProfile(sample, 'smart')).toBe(false);
  });
});

describe('browsers and capability questions', () => {
  it('reports what this host has, without pretending a browser was launched', async () => {
    const result = await callTool('pro_browser_use_browsers_detect', {});
    expect(result.isError).toBeFalsy();
    const body = payload(result);
    expect(['windows', 'macos', 'linux']).toContain(body.os);
    expect(Array.isArray(body.found)).toBe(true);
    for (const entry of body.found as Array<Record<string, unknown>>) {
      expect(typeof entry.product).toBe('string');
      expect(Array.isArray(entry.protocols)).toBe(true);
    }
  });

  it('answers the BiDi accessibility question with a refusal, not a shrug', async () => {
    const result = await callTool('pro_browser_use_capabilities_check', {
      product: 'firefox',
      capabilities: JSON.stringify(['accessibilityTree', 'hitTesting']),
    });
    const body = payload(result);
    const answers = body.answers as Array<Record<string, unknown>>;
    expect(answers).toHaveLength(2);
    for (const answer of answers) {
      expect(answer.yes).toBe(false);
      expect(String(answer.reason).length).toBeGreaterThan(10);
    }
    expect(body.missing).toEqual(['accessibilityTree', 'hitTesting']);
  });

  it('refuses an unknown capability instead of silently filtering it away', async () => {
    const result = await callTool('pro_browser_use_capabilities_check', {
      product: 'chrome',
      capabilities: JSON.stringify(['telekinesis']),
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/noma'lum capability/);
  });

  it('lists the products it does know when one is misspelled', async () => {
    const result = await callTool('pro_browser_use_capabilities_check', {
      product: 'corge',
      capabilities: JSON.stringify(['domRead']),
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/chrome/);
  });

  it('lists only rows that were actually run, with the step that ran them', async () => {
    const result = await callTool('pro_browser_use_capabilities_verified', {});
    const body = payload(result);
    const rows = body.rows as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.evidence_present).toBe(true); // a claim whose run log is gone is not verified
      expect(typeof row.probe_step).toBe('string');
    }
  });

  it('accepts loopback for attachment and refuses a public debugger', async () => {
    const ok = await callTool('pro_browser_use_browsers_attach_validate', { endpoint: 'http://127.0.0.1:9222' });
    expect(payload(ok).ok).toBe(true);
    const denied = await callTool('pro_browser_use_browsers_attach_validate', {
      endpoint: 'https://attacker.example/devtools',
    });
    expect(payload(denied).ok).toBe(false);
    expect(String(payload(denied).reason)).toMatch(/public|refus/i);
  });

  it('plans a launch without starting a browser, and keeps the profile inside the given root', async () => {
    const result = await callTool('pro_browser_use_browsers_launch_plan', { product: 'chrome' });
    const body = payload(result);
    expect(body.ok).toBe(true);
    expect(String(body.user_data_dir)).toContain('pro-fetch-chrome');
    expect(Array.isArray(body.args)).toBe(true);
  });
});

describe('coordinates and pixels', () => {
  it('maps a CSS box into a viewport capture at two times the ratio', async () => {
    const result = await callTool('pro_browser_use_coords_convert', {
      rect: JSON.stringify({ x: 100, y: 200, width: 120, height: 32 }),
      to: 'screenshot',
      device_scale_factor: 2,
      capture: JSON.stringify({
        kind: 'viewport',
        deviceScaleFactor: 2,
        image: { width: 2560, height: 1600 },
        scroll: { x: 0, y: 0 },
      }),
    });
    const body = payload(result);
    expect(body.ok).toBe(true);
    expect(body.image_box).toEqual({ x: 200, y: 400, width: 240, height: 64 });
  });

  it('refuses to place a nested frame box without a measured offset', async () => {
    const result = await callTool('pro_browser_use_coords_convert', {
      rect: JSON.stringify({ x: 10, y: 20, width: 100, height: 30 }),
      to: 'css-page',
      frame_id: 'main>0',
      frame_offsets: '[]',
      scroll: JSON.stringify({ x: 0, y: 0 }),
    });
    expect(payload(result).ok).toBe(false);
    expect(String(payload(result).reason)).toMatch(/0,0/);
  });

  it('adds the scroll offset for a full-page capture and not for a viewport one', async () => {
    const full = await callTool('pro_browser_use_coords_convert', {
      rect: JSON.stringify({ x: 100, y: 200, width: 120, height: 32 }),
      to: 'screenshot',
      capture: JSON.stringify({
        kind: 'full-page',
        deviceScaleFactor: 1,
        image: { width: 1280, height: 4000 },
        scroll: { x: 0, y: 500 },
      }),
    });
    expect(payload(full).image_box).toEqual({ x: 100, y: 700, width: 120, height: 32 });
  });

  it('diffs two PNGs and separates a real change from an unusable pair', async () => {
    const sharp = (await import('sharp')).default;
    const flat = await sharp({
      create: { width: 8, height: 8, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } },
    })
      .png()
      .toBuffer();
    const changed = await sharp({
      create: { width: 8, height: 8, channels: 4, background: { r: 10, g: 20, b: 200, alpha: 1 } },
    })
      .png()
      .toBuffer();
    const same = await callTool('pro_browser_use_visual_diff', {
      before_base64: flat.toString('base64'),
      after_base64: flat.toString('base64'),
    });
    expect(payload(same).changedPixels).toBe(0);
    const different = await callTool('pro_browser_use_visual_diff', {
      before_base64: flat.toString('base64'),
      after_base64: changed.toString('base64'),
    });
    expect(payload(different).changedPixels).toBe(64);
    const smaller = await sharp({
      create: { width: 4, height: 4, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } },
    })
      .png()
      .toBuffer();
    const mismatched = await callTool('pro_browser_use_visual_diff', {
      before_base64: flat.toString('base64'),
      after_base64: smaller.toString('base64'),
    });
    expect(payload(mismatched).comparable).toBe(false);
    expect(String(payload(mismatched).summary)).toMatch(/not comparable/);
  });

  it('annotates a capture and reports the pixels it wrote', async () => {
    const sharp = (await import('sharp')).default;
    const base = await sharp({
      create: { width: 40, height: 40, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
    })
      .png()
      .toBuffer();
    const result = await callTool('pro_browser_use_visual_annotate', {
      image_base64: base.toString('base64'),
      boxes: JSON.stringify([{ rect: { x: 4, y: 6, width: 20, height: 12 }, index: 3 }]),
      thickness: 1,
      label_scale: 1,
    });
    const body = payload(result);
    expect(body.ok).toBe(true);
    expect(Number(body.pixels_written)).toBeGreaterThan(0);
    expect(typeof body.image_png_base64).toBe('string');
    // The returned image must decode and keep its size.
    const round = await sharp(Buffer.from(String(body.image_png_base64), 'base64')).metadata();
    expect(round.width).toBe(40);
    expect(round.height).toBe(40);
  });
});

describe('decisions about acting', () => {
  const node = (JSON.parse(NODES) as Record<string, unknown>[])[0] as never;
  // The identity is the engine's own hash; deriving it here keeps the assertions about the tool's
  // decision rather than about a value copied out of a run log.
  const identity = identityOf(node);

  it('allows a click on a healthy element and hands back the point to use', async () => {
    const result = await callTool('pro_browser_use_action_preflight', {
      action: 'click',
      nodes: NODES,
      identity,
      backend_id: 'pf-1',
      token: 't1',
    });
    const body = payload(result);
    expect(body.decision).toBe('ALLOW');
    expect(body.point).toMatchObject({ x: 160, y: 216, space: 'css-viewport', frameId: 'main' });
  });

  it('refuses to type into a button and says what kind of control it is', async () => {
    const result = await callTool('pro_browser_use_action_preflight', {
      action: 'type',
      nodes: NODES,
      identity,
      backend_id: 'pf-1',
      token: 't1',
      value: 'hello',
    });
    expect(payload(result).decision).toBe('REFUSE');
    expect(String(payload(result).reason)).toMatch(/button/);
  });

  it('refuses a destructive label before anything runs', async () => {
    const nodes = JSON.stringify([
      {
        backendId: 'pf-2',
        token: 't2',
        frameId: 'main',
        path: 'html>body>button[2]',
        tag: 'button',
        role: 'button',
        name: 'Delete account',
        text: 'Delete account',
        rect: { x: 10, y: 10, width: 200, height: 40 },
        inViewport: true,
        styleVisible: true,
        hitTestSelf: true,
        obstructed: false,
        depth: 3,
        interactive: true,
        boundaries: [],
      },
    ]);
    const destructive = identityOf(JSON.parse(nodes)[0]);
    const result = await callTool('pro_browser_use_action_preflight', {
      action: 'click',
      nodes,
      identity: destructive,
      backend_id: 'pf-2',
      token: 't2',
    });
    expect(payload(result).decision).toBe('REFUSE');
    expect(String(payload(result).reason)).toContain('Delete account');
  });

  it('refuses an identity the caller has invented', async () => {
    const probe = await callTool('pro_browser_use_action_preflight', {
      action: 'click',
      nodes: NODES,
      identity: 'ffffffff',
      backend_id: 'pf-1',
    });
    expect(payload(probe).decision).toBe('REFUSE');
    expect(String(payload(probe).reason)).toMatch(/not in the node list/);
  });

  it('classifies a destructive label as refused and a hover as reversible', async () => {
    const destructive = await callTool('pro_browser_use_state_classify', {
      kind: 'expand',
      node: JSON.stringify({
        tag: 'details',
        role: '',
        name: 'Delete item',
        text: 'Delete item',
        inViewport: true,
        visible: true,
      }),
    });
    expect(payload(destructive).safety).toBe('REFUSED');
    const hover = await callTool('pro_browser_use_state_classify', {
      kind: 'hover',
      node: JSON.stringify({ tag: 'span', role: '', name: 'Row', text: 'Row', inViewport: true, visible: true }),
    });
    expect(payload(hover).safety).toBe('SAFE_REVERSIBLE');
  });

  it('separates a degraded page from a blocking one, in both directions', async () => {
    const degraded = await callTool('pro_browser_use_health_diagnose', {
      nodes: NODES,
      meta: META,
      url: 'https://shop.test/cart',
    });
    const body = payload(degraded);
    const kinds = (body.findings as Array<Record<string, unknown>>).map((f) => f.kind);
    // One named, reachable button is not a blocking problem. Missing alt text and a missing lang are
    // degraded ones, and a tool that called this "blocking" would be crying about a styled page.
    expect(body.blocking).toBe(0);
    expect(Number(body.degraded)).toBeGreaterThanOrEqual(2);
    expect(kinds).toContain('images-without-alt');
    expect(kinds).toContain('no-lang');

    const nameless = JSON.stringify([
      {
        backendId: 'pf-9',
        token: 't9',
        frameId: 'main',
        path: 'html>body>button[9]',
        tag: 'button',
        role: 'button',
        name: '',
        text: '',
        rect: { x: 10, y: 10, width: 60, height: 30 },
        inViewport: true,
        styleVisible: true,
        hitTestSelf: true,
        obstructed: false,
        depth: 3,
        interactive: true,
        boundaries: [],
      },
    ]);
    const blocking = payload(
      await callTool('pro_browser_use_health_diagnose', {
        nodes: nameless,
        meta: JSON.stringify({
          title: 'x',
          lang: 'en',
          hasViewportMeta: true,
          doctype: 'html',
          horizontalOverflow: 0,
          duplicateIdCount: 0,
          images: 0,
          imagesWithoutAlt: 0,
          frameCount: 0,
        }),
        url: 'https://shop.test/x',
      }),
    );
    expect(Number(blocking.blocking)).toBeGreaterThanOrEqual(1);
    expect((blocking.findings as Array<Record<string, unknown>>).map((f) => f.kind)).toContain('unnamed-controls');

    const bad = await callTool('pro_browser_use_health_diagnose', { nodes: NODES, meta: 'not json' });
    expect(bad.isError).toBe(true);
  });
});
