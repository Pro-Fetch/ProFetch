import { describe, it, expect } from 'vitest';
import {
  applySnapshot,
  createWorldModel,
  documentSignatureOf,
  knownIdentities,
  resolveInModel,
  summarizeModel,
  type WorldInput,
} from '../src/core/browser-use-world.js';
import { buildSnapshot, type BuildOptions, type RawNode, type Snapshot } from '../src/core/browser-use-perception.js';

/**
 * The world model is the part of the engine that is allowed to be wrong, so these tests are the part
 * that is not. Everything here is offline — hand-written records — which is what makes the two
 * dangerous cases (a re-rendered element, a navigation) reproducible on a machine with no browser.
 */

function raw(over: Partial<RawNode> = {}): RawNode {
  return {
    backendId: '1',
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

function snap(id: string, nodes: RawNode[], over: Partial<BuildOptions> = {}): Snapshot {
  const base: BuildOptions = {
    snapshotId: id,
    url: 'https://shop.test/cart',
    title: 'Cart',
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    scroll: { x: 0, y: 0 },
    capturedAt: 1000,
    ...over,
  };
  return buildSnapshot(nodes, base);
}

const input = (over: Partial<WorldInput> = {}): WorldInput => ({ tabId: 'tab-1', ...over });

const cart = [
  raw({
    backendId: '1',
    token: 't1',
    path: 'html>body',
    tag: 'body',
    role: '',
    name: '',
    text: '',
    depth: 1,
    interactive: false,
  }),
  raw({ backendId: '2', token: 't2', path: 'html>body>button[1]', name: 'Add to cart', text: 'Add to cart' }),
  raw({
    backendId: '3',
    token: 't3',
    path: 'html>body>span[1]',
    tag: 'span',
    role: '',
    name: '',
    text: '$49.00',
    interactive: false,
  }),
];

describe('versioning', () => {
  it('starts at v1 and never mutates the model it was given', () => {
    const first = createWorldModel(snap('s1', cart), input());
    const before = { version: first.version, latest: first.latest.id, size: first.nodes.size };
    const { model } = applySnapshot(first, snap('s2', cart, { capturedAt: 1100 }), input());

    expect(first.version).toBe(before.version);
    expect(first.latest.id).toBe(before.latest);
    expect(first.nodes.size).toBe(before.size);
    expect(model.version).toBe(2);
    expect(model.latest.id).toBe('s2');
  });

  it('keeps a monotonic version across several updates', () => {
    let m = createWorldModel(snap('s1', cart), input());
    const versions: number[] = [];
    for (let i = 2; i <= 5; i++) {
      m = applySnapshot(m, snap(`s${i}`, cart, { capturedAt: 1000 + i * 100 }), input()).model;
      versions.push(m.version);
    }
    expect(versions).toEqual([2, 3, 4, 5]);
    // The ledger starts with the snapshot the model was built from — v1 is the version everything else is
    // a diff against, so dropping it would leave the oldest entry unexplainable.
    expect(m.history.map((h) => h.version)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('incremental updates', () => {
  it('reports an added element as an addition and not as a new document', () => {
    const m = createWorldModel(snap('s1', cart), input());
    const { model, transition, delta } = applySnapshot(
      m,
      snap('s2', [
        ...cart,
        raw({ backendId: '4', token: 't4', path: 'html>body>button[2]', name: 'Checkout', text: 'Checkout' }),
      ]),
      input(),
    );
    expect(transition.kind).toBe('MUTATED');
    expect(delta.added.map((n) => n.name)).toEqual(['Checkout']);
    expect(delta.removed).toHaveLength(0);
    expect(model.nodes.size).toBe(4);
  });

  it('calls a pure scroll a scroll, not a mutation', () => {
    const m = createWorldModel(snap('s1', cart), input());
    const { transition, delta } = applySnapshot(m, snap('s2', cart, { scroll: { x: 0, y: 600 } }), input());
    expect(transition.kind).toBe('SCROLLED');
    expect(delta.added).toHaveLength(0);
    expect(delta.removed).toHaveLength(0);
  });

  it('calls a viewport change a resize', () => {
    const m = createWorldModel(snap('s1', cart), input());
    const { transition } = applySnapshot(m, snap('s2', cart, { viewport: { width: 800, height: 600 } }), input());
    expect(transition.kind).toBe('RESIZED');
    expect(transition.summary).toContain('1280x800');
    expect(transition.summary).toContain('800x600');
  });

  it('sees a re-labelled button as the same element with different words', () => {
    const m = createWorldModel(snap('s1', cart), input());
    const relabelled = cart.map((n) => (n.path.endsWith('button[1]') ? { ...n, name: 'In cart', text: 'In cart' } : n));
    const { delta, transition } = applySnapshot(m, snap('s2', relabelled), input());

    // Identity includes the label on purpose, so the identity did change. What must not happen is the
    // model describing a label edit as one element dying and another being born.
    expect(delta.relabelled).toHaveLength(1);
    expect(delta.relabelled[0].fields).toEqual(['name', 'text']);
    expect(delta.relabelled[0].fromLabel).toBe('Add to cart');
    expect(delta.relabelled[0].toLabel).toBe('In cart');
    expect(delta.added).toHaveLength(0);
    expect(delta.removed).toHaveLength(0);
    expect(transition.kind).toBe('MUTATED');
    expect(transition.summary).toContain('⟲1');
  });

  it('answers the old identity of a re-labelled element with the new one, and refuses to act', () => {
    const m = createWorldModel(snap('s1', cart), input());
    const oldButton = [...m.nodes.values()].find((n) => n.name === 'Add to cart')!;
    const relabelled = cart.map((n) => (n.path.endsWith('button[1]') ? { ...n, name: 'In cart', text: 'In cart' } : n));
    const { model } = applySnapshot(m, snap('s2', relabelled), input());

    const r = resolveInModel(model, {
      identity: oldButton.identity,
      backendId: oldButton.backendId,
      token: oldButton.token,
    });
    expect(r.ok).toBe(false);
    expect(r.staleness).toBe('CHANGED');
    expect(r.remembered).toBe(true);
    expect(r.replacement).toBeTruthy();
    expect(r.detail).toContain('In cart');
    expect(r.detail).toContain('Add to cart');
    // The replacement is a working reference: the same element, new identity, still clickable.
    const again = resolveInModel(model, {
      identity: r.replacement!,
      backendId: oldButton.backendId,
      token: oldButton.token,
    });
    expect(again.ok).toBe(true);
    expect(again.staleness).toBe('FRESH');
  });

  it('pairs a label change only with the same DOM node, never with a look-alike', () => {
    const m = createWorldModel(snap('s1', cart), input());
    // The button is gone; a *different* element (new token) appears with the same tag, path and words.
    const swapped = cart
      .filter((n) => !n.path.endsWith('button[1]'))
      .concat([
        raw({ backendId: '9', token: 't9', path: 'html>body>button[1]', name: 'Add to cart', text: 'Add to cart' }),
      ]);
    const { delta } = applySnapshot(m, snap('s2', swapped), input());
    expect(delta.relabelled).toHaveLength(0);
    expect(delta.added).toHaveLength(1);
    expect(delta.removed).toHaveLength(1);
  });
});

describe('documents', () => {
  it('voids every identity of the previous document on navigation', () => {
    const m = createWorldModel(snap('s1', cart), input());
    const held = [...m.nodes.keys()];
    const checkout = snap(
      's2',
      [
        raw({
          backendId: '1',
          token: 'c1',
          path: 'html>body',
          tag: 'body',
          role: '',
          name: '',
          text: '',
          depth: 1,
          interactive: false,
        }),
        raw({
          backendId: '2',
          token: 'c2',
          path: 'html>body>h1[1]',
          tag: 'h1',
          role: '',
          name: '',
          text: 'Checkout',
          interactive: false,
        }),
      ],
      { url: 'https://shop.test/checkout', title: 'Checkout' },
    );
    const { model, transition, delta } = applySnapshot(m, checkout, input());
    expect(transition.kind).toBe('NAVIGATED');
    expect(delta.removed).toHaveLength(3);
    expect(model.nodes.size).toBe(2);
    for (const identity of held) {
      const r = resolveInModel(model, { identity, backendId: '2' });
      expect(r.ok).toBe(false);
      expect(r.staleness).toBe('NAVIGATED');
      expect(r.remembered).toBe(true);
    }
  });

  it('does not confuse an identical element in a new document with the old one', () => {
    // Same tag, same role, same words, same box, same structural path — only the document differs. A
    // backend-id lookup would find this node and click it.
    const m = createWorldModel(snap('s1', cart), input());
    const oldButton = [...m.nodes.values()].find((n) => n.name === 'Add to cart')!;
    const nextDocument = snap(
      's2',
      [
        raw({
          backendId: '2',
          token: 'fresh',
          path: oldButton.path,
          name: 'Add to cart',
          text: 'Add to cart',
          rect: oldButton.rect,
        }),
      ],
      { url: 'https://shop.test/other' },
    );
    const { model } = applySnapshot(m, nextDocument, input());
    const r = resolveInModel(model, {
      identity: oldButton.identity,
      backendId: oldButton.backendId,
      token: oldButton.token,
    });
    expect(r.ok).toBe(false);
    expect(r.staleness).toBe('NAVIGATED');
    expect(model.nodes.has(oldButton.identity)).toBe(false);
  });

  it('treats a rebuild at the same url as a new document', () => {
    const m = createWorldModel(snap('s1', cart), input());
    const remounted = snap(
      's2',
      cart.map((n, i) => raw({ ...n, token: `r${i}`, backendId: `${i + 10}` })),
    );
    const { transition } = applySnapshot(m, remounted, input());
    expect(transition.kind).toBe('NAVIGATED');
    expect(transition.summary).toMatch(/not one of 3 identities survived/);
  });

  it('keeps a document — and its identities — across a fragment change', () => {
    const m = createWorldModel(snap('s1', cart), input());
    const button = [...m.nodes.values()].find((n) => n.name === 'Add to cart')!;
    expect(documentSignatureOf(snap('a', cart, { url: 'https://shop.test/cart#top' }))).toBe(
      documentSignatureOf(snap('b', cart, { url: 'https://shop.test/cart#bottom' })),
    );
    const { model, transition } = applySnapshot(m, snap('s2', cart, { url: 'https://shop.test/cart#bottom' }), input());
    expect(transition.kind).toBe('FRAGMENT');
    const r = resolveInModel(model, {
      identity: button.identity,
      backendId: button.backendId,
      token: button.token,
      rect: button.rect,
    });
    expect(r.ok).toBe(true);
    expect(r.staleness).toBe('FRESH');
  });

  it('rejects a reference that never belonged to this tab', () => {
    const m = createWorldModel(snap('s1', cart), input());
    const r = resolveInModel(m, { identity: 'deadbeef', backendId: '99' });
    expect(r.ok).toBe(false);
    expect(r.staleness).toBe('GONE');
    expect(r.remembered).toBe(false);
    expect(r.detail).toContain('never in the model');
  });
});

describe('coverage', () => {
  it('reports an unknown page height instead of implying full coverage', () => {
    const m = createWorldModel(snap('s1', cart), input());
    expect(m.coverage.contentHeight).toBeNull();
    expect(m.coverage.viewportCoverage).toBeNull();
    expect(m.coverage.gaps.join(' ')).toContain('page height unknown');
  });

  it('widens the seen region as the page is scrolled, and never past 1', () => {
    let m = createWorldModel(snap('s1', cart), input({ contentHeight: 2000 }));
    expect(m.coverage.viewportCoverage).toBeCloseTo(0.4, 5);
    m = applySnapshot(m, snap('s2', cart, { scroll: { x: 0, y: 1200 }, capturedAt: 1100 }), input()).model;
    expect(m.coverage.scrollSeen).toEqual({ minY: 0, maxY: 1200, samples: 2 });
    expect(m.coverage.viewportCoverage).toBeCloseTo(1, 5);
    m = applySnapshot(m, snap('s3', cart, { scroll: { x: 0, y: 900 }, capturedAt: 1200 }), input()).model;
    expect(m.coverage.viewportCoverage).toBeLessThanOrEqual(1);
    expect(m.coverage.contentHeight).toBe(2000);
  });

  it('carries the count of nodes the budget dropped', () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      raw({ backendId: `${i}`, token: `t${i}`, path: `html>body>button[${i + 1}]`, name: `B${i}` }),
    );
    const m = createWorldModel(snap('s1', many, { budget: 2 }), input());
    expect(m.latest.truncated).toBe(4);
    expect(m.coverage.omittedByBudget).toBe(4);
    expect(m.coverage.gaps.join(' ')).toContain('4 nodes left out');
    // A small budget must not make the model claim it knows more than the snapshot was allowed to hold.
    expect(m.coverage.identitiesInLatest).toBe(2);
  });

  it('names a declared frame that produced nothing', () => {
    const m = createWorldModel(snap('s1', cart), input({ declaredFrames: ['main', 'iframe-pay'] }));
    expect(m.coverage.frames.map((f) => f.frameId)).toEqual(['main']);
    expect(m.coverage.framesUnobserved).toEqual(['iframe-pay']);
    expect(m.coverage.gaps.join(' ')).toContain('iframe-pay');
  });

  it('records boundaries so shadow DOM and frames are not silently flattened', () => {
    const inside = cart.map((n) => ({ ...n, frameId: 'iframe-pay', boundaries: ['iframe#pay'] }));
    const m = createWorldModel(snap('s1', inside), input({ declaredFrames: ['iframe-pay'] }));
    expect(m.coverage.frames[0].boundaries).toEqual(['iframe#pay']);
    expect(m.coverage.framesUnobserved).toEqual([]);
  });
});

describe('bounds', () => {
  it('caps history and keeps the most recent versions', () => {
    let m = createWorldModel(snap('s1', cart), input({ historyLimit: 3 }));
    for (let i = 2; i <= 6; i++)
      m = applySnapshot(m, snap(`s${i}`, cart, { capturedAt: 1000 + i * 100 }), input()).model;
    expect(m.history).toHaveLength(3);
    expect(m.history.map((h) => h.version)).toEqual([4, 5, 6]);
  });

  it('caps the identity map and counts what it dropped', () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      raw({ backendId: `${i}`, token: `t${i}`, path: `html>body>button[${i + 1}]`, name: `B${i}` }),
    );
    let m = createWorldModel(snap('s1', many.slice(0, 4)), input({ nodeLimit: 5 }));
    m = applySnapshot(m, snap('s2', many), input()).model;
    expect(m.evicted).toBeGreaterThan(0);
    expect(m.nodes.size).toBeLessThanOrEqual(5);
    expect(m.delta.changed.some((c) => c.identity === '(model limit)')).toBe(true);
    expect(summarizeModel(m).text).toContain('evicted');
  });

  it('caps the transition log', () => {
    let m = createWorldModel(snap('s1', cart), input({ transitionLimit: 2 }));
    for (let i = 2; i <= 6; i++)
      m = applySnapshot(m, snap(`s${i}`, cart, { capturedAt: 1000 + i * 100 }), input()).model;
    expect(m.transitions).toHaveLength(2);
    expect(m.transitions.map((t) => t.version)).toEqual([5, 6]);
  });
});

describe('summary', () => {
  it('fits the budget and names what it left out', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      raw({ backendId: `${i}`, token: `t${i}`, path: `html>body>button[${i + 1}]`, name: `B${i}` }),
    );
    const m = createWorldModel(snap('s1', many, { budget: 2 }), input({ declaredFrames: ['main', 'ad-frame'] }));
    const tight = summarizeModel(m, 120);
    expect(tight.text.length).toBeLessThanOrEqual(120);
    expect(tight.omitted.length).toBeGreaterThan(0);
    expect(tight.omitted.join(' ')).toMatch(/omitted by budget|gap/);
    const roomy = summarizeModel(m, 2000);
    expect(roomy.omitted).toHaveLength(0);
    expect(roomy.text).toContain('tab tab-1 · v1');
  });

  it('exposes the identities the model still holds', () => {
    const m = createWorldModel(snap('s1', cart), input());
    expect(knownIdentities(m)).toHaveLength(3);
    expect(knownIdentities(m)).toEqual([...m.nodes.keys()]);
  });
});
