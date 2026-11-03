import { describe, it, expect } from 'vitest';
import {
  deepestTextDepths,
  elementLine,
  elementRows,
  ownsCentre,
  ownsItsText,
  placeRect,
  selectNodes,
  summarizeRows,
} from '../src/core/browser-use-elements.js';
import { buildSnapshot, type BuildOptions, type RawNode } from '../src/core/browser-use-perception.js';

/**
 * The listing layer: what the read says about geometry, filtered without changing what the read says.
 *
 * Every assertion here is about a distinction the outline does not have to make. The outline can afford to
 * show only what a model can click; a coordinate listing is read by someone asking "what is at y=900" and
 * has to answer for the container, the text inside it, and the button the cookie banner is sitting on.
 */

const OPTIONS: BuildOptions = {
  snapshotId: 'snap-1',
  url: 'https://example.test/page',
  title: 'Listing',
  viewport: { width: 1000, height: 600 },
  deviceScaleFactor: 2,
  scroll: { x: 0, y: 100 },
  capturedAt: 1,
  budget: 100,
};

function raw(overrides: Partial<RawNode> & { backendId: string; path: string }): RawNode {
  return {
    token: `t-${overrides.backendId}`,
    frameId: 'main',
    tag: 'div',
    rect: { x: 0, y: 0, width: 100, height: 20 },
    inViewport: true,
    styleVisible: true,
    hitTestSelf: true,
    obstructed: false,
    depth: 2,
    interactive: false,
    boundaries: [],
    ...overrides,
  } as RawNode;
}

const ARTICLE = raw({
  backendId: 'pf-1',
  path: 'html>body>article',
  tag: 'article',
  role: 'article',
  text: 'The treaty was signed in 1919.',
  depth: 2,
  rect: { x: 40, y: 80, width: 800, height: 200 },
});
const PARAGRAPH = raw({
  backendId: 'pf-2',
  path: 'html>body>article>p',
  tag: 'p',
  text: 'The treaty was signed in 1919.',
  depth: 3,
  rect: { x: 48, y: 88, width: 784, height: 40 },
});
const SPAN = raw({
  backendId: 'pf-3',
  path: 'html>body>article>p>span',
  tag: 'span',
  text: 'The treaty was signed in 1919.',
  depth: 4,
  rect: { x: 48, y: 88, width: 300, height: 16 },
});
const BUTTON = raw({
  backendId: 'pf-4',
  path: 'html>body>article>button',
  tag: 'button',
  role: 'button',
  name: 'Accept',
  text: 'Accept',
  interactive: true,
  depth: 3,
  rect: { x: 48, y: 300, width: 120, height: 32 },
});
const COVERED = raw({
  backendId: 'pf-5',
  path: 'html>body>article>button[2]',
  tag: 'button',
  role: 'button',
  name: 'Dismiss',
  interactive: true,
  depth: 3,
  hitTestSelf: false,
  obstructed: true,
  rect: { x: 48, y: 360, width: 120, height: 32 },
});
const OFFSCREEN = raw({
  backendId: 'pf-6',
  path: 'html>body>footer',
  tag: 'footer',
  role: 'contentinfo',
  text: 'Contacts',
  inViewport: false,
  depth: 2,
  rect: { x: 0, y: 1400, width: 1000, height: 60 },
});
const HIDDEN = raw({
  backendId: 'pf-7',
  path: 'html>body>div[9]',
  tag: 'div',
  ariaHidden: true,
  text: 'decorative',
  depth: 2,
  rect: { x: 10, y: 10, width: 40, height: 40 },
});
const FIELD = raw({
  backendId: 'pf-8',
  path: 'html>body>form>input',
  tag: 'input',
  role: 'textbox',
  name: 'Search',
  value: 'treaty',
  interactive: true,
  depth: 4,
  rect: { x: 200, y: 40, width: 300, height: 24 },
});

const snapshot = buildSnapshot([ARTICLE, PARAGRAPH, SPAN, BUTTON, COVERED, OFFSCREEN, HIDDEN, FIELD], OPTIONS);

describe('filters', () => {
  it('lists everything only when the caller asked for everything', () => {
    expect(selectNodes(snapshot, { filter: 'all' })).toHaveLength(8);
    expect(selectNodes(snapshot, { filter: 'visible' })).toHaveLength(7);
    expect(selectNodes(snapshot, { filter: 'visible' }).map((n) => n.backendId)).not.toContain('pf-7');
  });

  it('keeps a button the page is covering, and says so, instead of quietly dropping it', () => {
    // An interactable-only list would lose the Dismiss button entirely, which is exactly the element a
    // reader trying to understand why nothing could be clicked needs to see.
    const listed = selectNodes(snapshot, { filter: 'all' }).find((n) => n.backendId === 'pf-5')!;
    expect(listed.interactable).toBe(false);
    expect(listed.obstructed).toBe(true);
    expect(listed.conflicts).toContain('another element is on top of it');
  });

  it('separates a control from a reachable control', () => {
    expect(
      selectNodes(snapshot, { filter: 'interactive' })
        .map((n) => n.backendId)
        .sort(),
    ).toEqual(['pf-4', 'pf-5', 'pf-8']);
    expect(
      selectNodes(snapshot, { filter: 'interactable' })
        .map((n) => n.backendId)
        .sort(),
    ).toEqual(['pf-4', 'pf-8']);
  });

  it('attributes a shared sentence to the deepest element holding it', () => {
    const depths = deepestTextDepths(snapshot.nodes);
    const by = (id: string) => snapshot.nodes.find((n) => n.backendId === id)!;
    expect(ownsItsText(by('pf-3'), depths)).toBe(true);
    expect(ownsItsText(by('pf-2'), depths)).toBe(false);
    expect(ownsItsText(by('pf-1'), depths)).toBe(false);
    expect(selectNodes(snapshot, { filter: 'text' }).map((n) => n.backendId)).toContain('pf-3');
    expect(selectNodes(snapshot, { filter: 'text' }).map((n) => n.backendId)).not.toContain('pf-1');
  });

  it('narrows by tag, role, name and region without changing the ordering rule', () => {
    expect(selectNodes(snapshot, { filter: 'all', tag: 'BUTTON' })).toHaveLength(2);
    expect(selectNodes(snapshot, { filter: 'all', role: 'button' })).toHaveLength(2);
    expect(
      selectNodes(snapshot, { filter: 'all', nameIncludes: 'treaty' })
        .map((n) => n.backendId)
        .sort(),
    ).toEqual(['pf-1', 'pf-2', 'pf-3', 'pf-8']);
    const region = selectNodes(snapshot, { filter: 'visible', region: { x: 0, y: 280, width: 200, height: 120 } });
    expect(region.map((n) => n.backendId).sort()).toEqual(['pf-4', 'pf-5']);
  });

  it('orders by depth then path, so a listing can be walked top-down', () => {
    const ids = selectNodes(snapshot, { filter: 'all' }).map((n) => n.backendId);
    expect(ids.indexOf('pf-1')).toBeLessThan(ids.indexOf('pf-2'));
    expect(ids.indexOf('pf-2')).toBeLessThan(ids.indexOf('pf-3'));
  });
});

describe('coordinate spaces on rows', () => {
  it('adds the scroll the read was taken at for a page-space box', () => {
    const placed = placeRect({ x: 10, y: 20, width: 30, height: 40 }, 'css-page', snapshot);
    expect(placed).toEqual({ x: 10, y: 120, width: 30, height: 40 });
  });

  it('multiplies by the device pixel ratio and rounds outward, from the origin of the capture named', () => {
    // Outward on both edges: rounding a box inward cuts a pixel off the element the caller is about to crop.
    const box = { x: 10.4, y: 20.2, width: 30.5, height: 40.5 };
    const fromViewport = placeRect(box, 'image-viewport-device', snapshot);
    expect(fromViewport).toEqual({ x: 20, y: 40, width: 62, height: 82 });
    const fromDocument = placeRect(box, 'image-page-device', snapshot);
    // The read was taken 100 px down the page, so a full-page shot's pixel row is 200 lower than the
    // viewport shot's. One name for both would have made one of these two answers wrong.
    expect(fromDocument).toEqual({ x: 20, y: 240, width: 62, height: 82 });
  });

  it('carries the space it was written in, so a mixed list is impossible to misread', () => {
    const rows = elementRows(selectNodes(snapshot, { filter: 'interactable' }), snapshot, {
      space: 'image-page-device',
    });
    expect(rows.every((r) => r.space === 'image-page-device')).toBe(true);
    expect(rows.every((r) => r.rect.y >= 80)).toBe(true);
  });

  it('names the point a click would use and whether that point is the element’s own', () => {
    const rows = elementRows(selectNodes(snapshot, { filter: 'all' }), snapshot);
    const button = rows.find((r) => r.backend_id === 'pf-4')!;
    expect(button.centre).toEqual({ x: 108, y: 316 });
    expect(button.owns_centre).toBe(true);
    const covered = rows.find((r) => r.backend_id === 'pf-5')!;
    expect(covered.owns_centre).toBe(false);
    expect(ownsCentre(snapshot.nodes.find((n) => n.backendId === 'pf-5')!)).toBe(false);
  });
});

describe('the shape of an answer', () => {
  it('summarises what a list would otherwise make the reader count', () => {
    const rows = elementRows(selectNodes(snapshot, { filter: 'visible' }), snapshot);
    const stats = summarizeRows(rows, 'visible');
    expect(stats.matched).toBe(7);
    expect(stats.clickable).toBe(2);
    expect(stats.covered).toBe(1);
    expect(stats.off_viewport).toBe(1);
    expect(stats.by_tag[0]!.count).toBeGreaterThanOrEqual(1);
  });

  it('writes a line that contains the number, the box and the centre', () => {
    const rows = elementRows(selectNodes(snapshot, { filter: 'interactable' }), snapshot);
    const line = elementLine(rows[0]!);
    expect(line).toContain('#1');
    expect(line).toContain('button[button] "Accept"');
    expect(line).toMatch(/48,300 120x32/);
    expect(line).toMatch(/c=108,316/);
  });

  it('flags the rows that a reader must not trust as clickable', () => {
    const rows = elementRows(selectNodes(snapshot, { filter: 'all' }), snapshot);
    const covered = elementLine(rows.find((r) => r.backend_id === 'pf-5')!);
    expect(covered).toContain('(covered,no-centre)');
    const offscreen = elementLine(rows.find((r) => r.backend_id === 'pf-6')!);
    expect(offscreen).toContain('off-screen');
  });
});
