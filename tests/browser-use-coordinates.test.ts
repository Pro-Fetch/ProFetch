import { describe, it, expect } from 'vitest';
import {
  annotationOverlay,
  boxInScreenshot,
  clickPoint,
  containsPoint,
  cssToDevice,
  deviceToCss,
  pageToViewport,
  revalidatePoint,
  toTopFrame,
  viewportToPage,
  whatIsAt,
  type AnnotationLabel,
  type ScreenshotGeometry,
} from '../src/core/browser-use-coordinates.js';
import { buildSnapshot, type BuildOptions, type RawNode, type Snapshot } from '../src/core/browser-use-perception.js';

/**
 * Coordinate work is where browser automation quietly loses a few pixels and ends up clicking the wrong
 * thing, so these tests are arithmetic against fixed numbers rather than tolerances: the whole point is
 * that a caller can predict the result.
 */

function raw(over: Partial<RawNode> = {}): RawNode {
  return {
    backendId: '1',
    token: 't1',
    frameId: 'main',
    path: 'html>body>button[1]',
    tag: 'button',
    role: 'button',
    name: 'Buy',
    text: 'Buy',
    rect: { x: 100, y: 200, width: 80, height: 24 },
    inViewport: true,
    styleVisible: true,
    hitTestSelf: true,
    obstructed: false,
    depth: 3,
    interactive: true,
    boundaries: [],
    ...over,
  };
}

const base: BuildOptions = {
  snapshotId: 's-1',
  url: 'https://shop.test/cart',
  title: 'Cart',
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
  scroll: { x: 0, y: 500 },
  capturedAt: 1000,
};

const snapshotOf = (nodes: RawNode[], over: Partial<BuildOptions> = {}): Snapshot =>
  buildSnapshot(nodes, { ...base, ...over, snapshotId: over.snapshotId ?? 's-1' });

describe('spaces', () => {
  it('round-trips between viewport and page coordinates', () => {
    const rect = { x: 10, y: 20, width: 100, height: 40 };
    const scroll = { x: 0, y: 500 };
    const page = viewportToPage(rect, scroll);
    expect(page).toEqual({ x: 10, y: 520, width: 100, height: 40 });
    expect(pageToViewport(page, scroll)).toEqual(rect);
  });

  it('scales to device pixels outward so no edge is cropped', () => {
    const rect = { x: 10.4, y: 20.6, width: 33.3, height: 12.1 };
    const device = cssToDevice(rect, 2);
    // floor(10.4*2)=20, floor(20.6*2)=41, ceil(43.7*2)=88, ceil(32.7*2)=66
    expect(device).toEqual({ x: 20, y: 41, width: 68, height: 25 });
    expect(device.x).toBeLessThanOrEqual(rect.x * 2);
    expect(device.y).toBeLessThanOrEqual(rect.y * 2);
    expect(device.x + device.width).toBeGreaterThanOrEqual((rect.x + rect.width) * 2);
    expect(device.y + device.height).toBeGreaterThanOrEqual((rect.y + rect.height) * 2);
  });

  it('treats a missing device scale factor as 1 instead of dividing by zero', () => {
    expect(cssToDevice({ x: 4, y: 8, width: 10, height: 10 }, 0)).toEqual({ x: 4, y: 8, width: 10, height: 10 });
    expect(deviceToCss({ x: 4, y: 8, width: 10, height: 10 }, 0)).toEqual({ x: 4, y: 8, width: 10, height: 10 });
  });

  it('inverts device scaling within a pixel', () => {
    const rect = { x: 12, y: 34, width: 56, height: 18 };
    const back = deviceToCss(cssToDevice(rect, 2), 2);
    expect(Math.abs(back.x - rect.x)).toBeLessThan(0.5);
    expect(Math.abs(back.width - rect.width)).toBeLessThan(0.5);
  });

  it('names the space a click point is expressed in', () => {
    const p = clickPoint({ x: 100, y: 200, width: 80, height: 24 }, 'iframe-pay');
    expect(p).toEqual({ x: 140, y: 212, space: 'css-viewport', frameId: 'iframe-pay' });
  });
});

describe('screenshots', () => {
  const rect = { x: 100, y: 200, width: 80, height: 24 };
  const viewportShot: ScreenshotGeometry = {
    kind: 'viewport',
    deviceScaleFactor: 2,
    image: { width: 2560, height: 1600 },
    scroll: { x: 0, y: 500 },
  };
  const fullShot: ScreenshotGeometry = {
    kind: 'full-page',
    deviceScaleFactor: 2,
    image: { width: 2560, height: 6000 },
    scroll: { x: 0, y: 500 },
  };
  const elementShot: ScreenshotGeometry = {
    kind: 'element',
    deviceScaleFactor: 1,
    image: { width: 80, height: 24 },
    scroll: { x: 0, y: 500 },
    origin: { x: 90, y: 180, width: 100, height: 50 },
  };

  it('leaves a viewport shot at the viewport origin and scales it', () => {
    expect(boxInScreenshot(rect, viewportShot)).toEqual({ x: 200, y: 400, width: 160, height: 48 });
  });

  it('adds the scroll offset only for a full-page shot, whose origin is the document', () => {
    expect(boxInScreenshot(rect, fullShot)).toEqual({ x: 200, y: 1400, width: 160, height: 48 });
  });

  it('subtracts the element origin for an element shot', () => {
    expect(boxInScreenshot(rect, elementShot)).toEqual({ x: 10, y: 20, width: 80, height: 24 });
  });

  it('clamps a negative element-space box to the image instead of drawing outside it', () => {
    const partly = { ...rect, x: 60, y: 140 };
    const box = boxInScreenshot(partly, elementShot);
    expect(box.x).toBe(0);
    expect(box.y).toBe(0);
  });
});

describe('hit testing against a snapshot', () => {
  it('prefers the deepest box under the point', () => {
    const s = snapshotOf([
      raw({
        backendId: '1',
        token: 't1',
        path: 'html',
        tag: 'html',
        role: '',
        name: '',
        text: '',
        depth: 0,
        rect: { x: 0, y: 0, width: 1280, height: 800 },
        interactive: false,
      }),
      raw({ backendId: '2', token: 't2', path: 'html>body>button[1]', depth: 3, name: 'Buy', text: 'Buy' }),
    ]);
    const v = whatIsAt(s, { x: 140, y: 212 });
    expect(v.ok).toBe(true);
    expect(v.at?.name).toBe('Buy');
    expect(v.stack.map((n) => n.depth)).toEqual([3, 0]);
  });

  it('refuses a point that nothing covers any more', () => {
    const s = snapshotOf([raw()]);
    const v = whatIsAt(s, { x: 10, y: 10 });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/nothing in the latest snapshot covers/);
    expect(v.stack).toHaveLength(0);
  });

  it('refuses a point whose element is obstructed', () => {
    const s = snapshotOf([raw({ obstructed: true })]);
    const v = whatIsAt(s, { x: 140, y: 212 });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/under something else/);
  });

  it('includes a boundary point but rejects one pixel outside', () => {
    const s = snapshotOf([raw()]);
    expect(containsPoint({ x: 100, y: 200, width: 80, height: 24 }, { x: 180, y: 224 })).toBe(true);
    expect(whatIsAt(s, { x: 181, y: 224 }).ok).toBe(false);
  });

  it('separates a non-interactable topmost element from a covered one', () => {
    const s = snapshotOf([raw({ role: '', name: '', text: 'Total: $49', tag: 'span', interactive: false })]);
    const v = whatIsAt(s, { x: 140, y: 212 });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/not interactable/);
  });
});

describe('revalidation', () => {
  it('passes when the element is where it was', () => {
    const s = snapshotOf([raw()]);
    const node = s.nodes[0];
    const v = revalidatePoint(s, { identity: node.identity, rect: node.rect });
    expect(v.ok).toBe(true);
    expect(v.identityMatches).toBe(true);
    expect(v.drift).toEqual({ x: 0, y: 0 });
  });

  it('reports the drift when the box moved and re-aims the verdict', () => {
    const before = snapshotOf([raw()]);
    const node = before.nodes[0];
    const after = snapshotOf([raw({ rect: { x: 100, y: 480, width: 80, height: 24 } })], { snapshotId: 's-2' });
    const v = revalidatePoint(after, { identity: node.identity, rect: node.rect });
    expect(v.drift).toEqual({ x: 0, y: 280 });
    expect(v.reason).toMatch(/moved by 0,280 px/);
    // The old centre is now empty space, so acting on the remembered point must fail.
    expect(v.ok).toBe(false);
  });

  it('fails when the identity is gone, even if a look-alike sits there', () => {
    const before = snapshotOf([raw({ token: 't1' })]);
    const node = before.nodes[0];
    const after = snapshotOf([raw({ token: 'different' })], { snapshotId: 's-2' });
    const v = revalidatePoint(after, { identity: node.identity, rect: node.rect });
    expect(v.ok).toBe(false);
    expect(v.identityMatches).toBe(false);
    expect(v.at?.name).toBe('Buy');
  });

  it('accepts a point that was recomputed against the new box', () => {
    const before = snapshotOf([raw()]);
    const node = before.nodes[0];
    const moved = raw({ rect: { x: 100, y: 480, width: 80, height: 24 } });
    const after = snapshotOf([moved], { snapshotId: 's-2' });
    const v = revalidatePoint(after, { identity: after.nodes[0].identity, rect: node.rect, point: { x: 140, y: 492 } });
    expect(v.ok).toBe(true);
    expect(v.drift).toEqual({ x: 0, y: 280 });
  });
});

describe('frames', () => {
  it('leaves main-frame boxes alone', () => {
    expect(toTopFrame({ x: 10, y: 20, width: 5, height: 5 }, [], 'main')).toEqual({
      x: 10,
      y: 20,
      width: 5,
      height: 5,
    });
  });

  it('shifts a nested frame by its measured offset', () => {
    const offsets = [{ frameId: 'iframe-pay', x: 40, y: 300 }];
    expect(toTopFrame({ x: 10, y: 20, width: 5, height: 5 }, offsets, 'iframe-pay')).toEqual({
      x: 50,
      y: 320,
      width: 5,
      height: 5,
    });
  });

  it('returns null rather than assuming an unmeasured frame sits at the origin', () => {
    expect(toTopFrame({ x: 10, y: 20, width: 5, height: 5 }, [], 'iframe-pay')).toBeNull();
  });

  it('keeps frame coordinates out of a main-frame hit test', () => {
    const s = snapshotOf([raw({ frameId: 'iframe-pay' })]);
    expect(whatIsAt(s, { x: 140, y: 212 }, 'main').ok).toBe(false);
    expect(whatIsAt(s, { x: 140, y: 212 }, 'iframe-pay').ok).toBe(true);
  });
});

describe('annotation overlay', () => {
  const labels: AnnotationLabel[] = [
    { identity: 'a', text: 'button "Buy"', rect: { x: 100, y: 200, width: 80, height: 24 }, index: 1 },
    { identity: 'b', text: 'link <script>x</script>', rect: { x: 10, y: 1580, width: 60, height: 20 }, index: 2 },
  ];
  const image = { width: 2560, height: 1600 };

  it('is well-formed SVG sized to the image and scaled by the device ratio', () => {
    const svg = annotationOverlay(labels, image, 2);
    expect(svg.startsWith('<svg ')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg).toContain('viewBox="0 0 2560 1600"');
    expect(svg).toContain('<rect class="box" x="200" y="400" width="160" height="48"');
  });

  it('numbers each label with the outline index the model was given', () => {
    const svg = annotationOverlay(labels, image, 2);
    expect(svg).toContain('>1 button');
    expect(svg).toContain('>2 link');
  });

  it('escapes markup coming from the page', () => {
    const svg = annotationOverlay(labels, image, 2);
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });

  it('moves a label above the box when the bottom of the image is too close', () => {
    const svg = annotationOverlay(labels, image, 2);
    const y = Number(/<text x="\d+" y="(\d+)">2 /.exec(svg)?.[1] ?? -1);
    // box y 3160 is already outside a 1600-tall image; the label must be clamped inside it.
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThanOrEqual(1600);
  });

  it('produces nothing but the shell for an empty label list', () => {
    const svg = annotationOverlay([], image, 1);
    expect((svg.match(/<rect/g) ?? []).length).toBe(0);
    expect(svg).toContain('</svg>');
  });
});
