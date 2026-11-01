import { describe, it, expect } from 'vitest';
import {
  areaOf,
  buildSnapshot,
  diffSnapshots,
  hash32,
  identityOf,
  mergeVisibility,
  perceiveNode,
  resolveTarget,
  sameBox,
  serializeOutline,
  type BuildOptions,
  type RawNode,
} from '../src/core/browser-use-perception.js';

/**
 * The perception layer exists because the survey found a real class of bug: an element index that is
 * looked up in a fresh map and clicked without checking it is the same element. These tests are
 * offline by construction — the inputs are hand-written records — so they assert the same thing on a
 * machine with no browser installed.
 */

function raw(over: Partial<RawNode> = {}): RawNode {
  return {
    backendId: '42',
    token: 't1',
    frameId: 'main',
    path: 'html>body>button[1]',
    tag: 'button',
    role: 'button',
    name: 'Save',
    text: 'Save',
    rect: { x: 10, y: 20, width: 80, height: 24 },
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
  snapshotId: 'snap-1',
  url: 'https://example.test/',
  title: 'fixture',
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  scroll: { x: 0, y: 0 },
  capturedAt: 1000,
};

describe('identity', () => {
  it('is stable for the same element and changes when the element changes', () => {
    expect(identityOf(raw())).toBe(identityOf(raw()));
    expect(identityOf(raw())).not.toBe(identityOf(raw({ name: 'Discard' })));
    expect(identityOf(raw())).not.toBe(identityOf(raw({ path: 'html>body>div>button[1]' })));
  });

  it('does not depend on the browser-assigned node id', () => {
    // This is the whole point: a recycled `backendNodeId` must not produce the same identity, and a
    // re-render that keeps the element must not produce a new one.
    expect(identityOf(raw({ backendId: '999' }))).toBe(identityOf(raw({ backendId: '1' })));
    // The same node id under a different lifetime token is a different element — the case the probe
    // caught when identity was built from position and name alone.
    expect(identityOf(raw({ token: 't2' }))).not.toBe(identityOf(raw({ token: 't1' })));
  });

  it('hashes deterministically', () => {
    expect(hash32('abc')).toBe(hash32('abc'));
    expect(hash32('abc')).not.toBe(hash32('abd'));
    expect(hash32('')).toHaveLength(8);
  });
});

describe('visibility keeps the disagreement instead of resolving it', () => {
  it('calls an aria-hidden element with a real box a conflict, and not visible', () => {
    const r = mergeVisibility(raw({ ariaHidden: true }));
    expect(r.visible).toBe(false);
    expect(r.conflicts.join(' ')).toMatch(/aria-hidden/);
  });

  it('reports a hit-test mismatch instead of silently allowing the click', () => {
    const r = mergeVisibility(raw({ hitTestSelf: false }));
    expect(r.interactable).toBe(false);
    expect(r.conflicts.join(' ')).toMatch(/hit-test/);
  });

  it('treats an obstructed element as not interactable even when everything else agrees', () => {
    expect(mergeVisibility(raw({ obstructed: true })).interactable).toBe(false);
  });

  it('flags a box with area that the style says is hidden', () => {
    expect(mergeVisibility(raw({ styleVisible: false })).conflicts.join(' ')).toMatch(/layout box has area/);
  });
});

describe('snapshot construction', () => {
  it('ranks interactable nodes first so a budget cut drops the least useful ones', () => {
    const snapshot = buildSnapshot(
      [
        raw({ backendId: '1', name: 'plain', interactive: false, tag: 'div', role: undefined }),
        raw({ backendId: '2', name: 'Save' }),
      ],
      base,
    );
    expect(snapshot.nodes[0].name).toBe('Save');
  });

  it('reports truncation instead of pretending the page fit', () => {
    const many = Array.from({ length: 12 }, (_, i) => raw({ backendId: String(i), path: `html>body>button[${i}]` }));
    const snapshot = buildSnapshot(many, { ...base, budget: 5 });
    expect(snapshot.nodes).toHaveLength(5);
    expect(snapshot.truncated).toBe(7);
  });
});

describe('the outline is a fixed-size action surface', () => {
  it('names each element with an identity the caller can hand back', () => {
    const snapshot = buildSnapshot([raw()], base);
    const outline = serializeOutline(snapshot);
    expect(outline.text).toContain(identityOf(raw()));
    expect(outline.text).toMatch(/button "Save".*@10,20 80x24/);
  });

  it('honours the character budget and says how much it dropped', () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      raw({ backendId: String(i), path: `html>body>button[${i}]`, name: 'x'.repeat(40) }),
    );
    const outline = serializeOutline(buildSnapshot(many, base), { maxChars: 900 });
    expect(outline.truncated).toBe(true);
    expect(outline.omitted).toBeGreaterThan(0);
    expect(outline.text).toMatch(/omitted by the 900 character budget/);
    expect(outline.text.length).toBeLessThan(1400);
  });

  it('carries viewport, dpr and scroll, because every coordinate below is meaningless without them', () => {
    const outline = serializeOutline(
      buildSnapshot([raw()], { ...base, deviceScaleFactor: 2, scroll: { x: 0, y: 240 } }),
    );
    expect(outline.text).toContain('dpr 2');
    expect(outline.text).toContain('scroll 0,240');
  });
});

describe('diffing', () => {
  const before = buildSnapshot(
    [raw({ backendId: '1' }), raw({ backendId: '2', path: 'html>body>a[1]', tag: 'a', role: 'link' })],
    base,
  );

  it('sees an element that moved as moved, not as removed and added', () => {
    const after = buildSnapshot(
      [
        raw({ backendId: '1', rect: { x: 10, y: 400, width: 80, height: 24 } }),
        raw({ backendId: '2', path: 'html>body>a[1]', tag: 'a', role: 'link' }),
      ],
      base,
    );
    const diff = diffSnapshots(before, after);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.moved).toHaveLength(1);
    expect(diff.moved[0].from.y).toBe(20);
    expect(diff.moved[0].to.y).toBe(400);
  });

  it('sees a state change without a geometry change', () => {
    const after = buildSnapshot(
      [
        raw({ backendId: '1', disabled: true }),
        raw({ backendId: '2', path: 'html>body>a[1]', tag: 'a', role: 'link' }),
      ],
      base,
    );
    const diff = diffSnapshots(before, after);
    expect(diff.moved).toHaveLength(0);
    expect(diff.changed[0].fields).toContain('state');
  });
});

describe('target resolution — the bug this layer exists to prevent', () => {
  const node = perceiveNode(raw(), base);

  it('accepts a target that is unchanged', () => {
    const r = resolveTarget(
      { identity: node.identity, backendId: node.backendId, rect: node.rect },
      buildSnapshot([raw()], base),
    );
    expect(r.staleness).toBe('FRESH');
    expect(r.ok).toBe(true);
  });

  it('refuses a recycled node id rather than clicking the wrong element', () => {
    // Same backend id, different element: the identity no longer exists, and the id now belongs to a
    // link. browser-use would click it.
    const current = buildSnapshot(
      [raw({ backendId: '42', tag: 'a', role: 'link', name: 'Other', path: 'html>body>a[1]' })],
      base,
    );
    const r = resolveTarget({ identity: node.identity, backendId: '42' }, current);
    expect(r.ok).toBe(false);
    expect(r.staleness).toBe('ID_RECYCLED');
    expect(r.detail).toMatch(/would hit something else/);
  });

  it('reports an element that survived a re-render under a new node id as REPLACED', () => {
    const current = buildSnapshot([raw({ backendId: '777' })], base);
    const r = resolveTarget({ identity: node.identity, backendId: '42' }, current);
    expect(r.staleness).toBe('REPLACED');
    expect(r.ok).toBe(false);
  });

  it('returns the live box when the element moved', () => {
    const moved = raw({ rect: { x: 10, y: 900, width: 80, height: 24 } });
    const r = resolveTarget(
      { identity: node.identity, backendId: '42', rect: node.rect },
      buildSnapshot([moved], base),
    );
    expect(r.staleness).toBe('MOVED');
    expect(r.ok).toBe(true);
    expect(r.node?.rect.y).toBe(900);
  });

  it('says GONE when the element is not in the document at all', () => {
    const r = resolveTarget({ identity: node.identity, backendId: '42' }, buildSnapshot([], base));
    expect(r.staleness).toBe('GONE');
    expect(r.ok).toBe(false);
  });

  it('refuses a target that became obstructed between snapshots', () => {
    const r = resolveTarget(
      { identity: node.identity, backendId: '42' },
      buildSnapshot([raw({ obstructed: true })], base),
    );
    expect(r.staleness).toBe('CHANGED');
    expect(r.detail).toMatch(/obstructed|interactable/);
  });
});

describe('geometry helpers', () => {
  it('treats a negative-area box as zero rather than negative', () => {
    expect(areaOf({ x: 0, y: 0, width: -10, height: 20 })).toBe(0);
  });

  it('compares boxes with a tolerance, because layout rounds', () => {
    expect(sameBox({ x: 10, y: 20, width: 80, height: 24 }, { x: 10.4, y: 20.2, width: 79.9, height: 24.1 })).toBe(
      true,
    );
    expect(sameBox({ x: 10, y: 20, width: 80, height: 24 }, { x: 10, y: 22, width: 80, height: 24 })).toBe(false);
    // The tolerance is inclusive at 1 px: sub-pixel layout rounding is normal, a 2 px shift is a move.
    expect(sameBox({ x: 10, y: 20, width: 80, height: 24 }, { x: 10, y: 21, width: 80, height: 24 })).toBe(true);
  });
});
