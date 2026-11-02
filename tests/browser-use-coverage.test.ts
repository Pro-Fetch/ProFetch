import { describe, it, expect } from 'vitest';
import {
  classifyReveal,
  complete,
  coverageRatio,
  createLedger,
  describeLedger,
  planScan,
  recordSnapshot,
  revealCandidates,
  type Ledger,
} from '../src/core/browser-use-coverage.js';
import { buildSnapshot, type BuildOptions, type RawNode, type Snapshot } from '../src/core/browser-use-perception.js';

/**
 * The ledger is the honest answer to "have you looked at this page". These tests are arithmetic on
 * snapshots built by hand, because the claim worth testing is that an unread band is reported as unread —
 * which is easy to verify when the numbers are chosen rather than measured.
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
    url: 'https://shop.test/long-page',
    title: 'Long',
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    scroll: { x: 0, y: 0 },
    capturedAt: 1000,
    ...over,
  };
  return buildSnapshot(nodes, base);
}

const TOP = snap('s1', [raw({ backendId: '1', token: 't1', name: 'Top button' })]);

describe('bands', () => {
  it('divides the page into viewport-sized bands and marks only the read one', () => {
    const ledger = createLedger(TOP, { contentHeight: 3000 });
    expect(ledger.bands).toHaveLength(5); // ceil(3000 / 720)
    expect(ledger.bands[0].visitedAt).toBe(1000);
    expect(ledger.bands.slice(1).every((b) => b.visitedAt === null)).toBe(true);
    expect(coverageRatio(ledger)).toBeCloseTo(0.2, 5);
    expect(ledger.gaps.join(' ')).toContain('4 of 5 band(s) never visited');
  });

  it('refuses to call an unknown page height a percentage', () => {
    const ledger = createLedger(TOP, {});
    expect(ledger.contentHeight).toBeNull();
    expect(ledger.bands).toHaveLength(1);
    expect(coverageRatio(ledger)).toBe(1);
    expect(complete(ledger)).toBe(false);
    expect(ledger.gaps.join(' ')).toContain('floor, not a percentage');
  });

  it('grows when the page turns out to be taller than the host said', () => {
    let ledger = createLedger(TOP, { contentHeight: 1440 });
    expect(ledger.bands).toHaveLength(2);
    ledger = recordSnapshot(
      ledger,
      snap('s2', [raw({ backendId: '9', token: 't9', name: 'Way down' })], {
        scroll: { x: 0, y: 2600 },
        capturedAt: 2000,
      }),
    );
    expect(ledger.bands.length).toBeGreaterThan(3);
    const deepest = ledger.bands[ledger.bands.length - 1]!;
    expect(deepest.y).toBe(2880);
    expect(deepest.seenFrom).toBe(2880);
    expect(deepest.seenTo).toBe(3320);
    // The measured bottom clamps the last band to the page, so this read did finish it.
    expect(deepest.visitedAt).toBe(2000);
    // A read that saw only the lower half of a band must not report that band as visited.
    const partial = ledger.bands.find((b) => b.y === 2160)!;
    expect(partial.seenFrom).toBe(2600);
    expect(partial.seenTo).toBe(2880);
    expect(partial.visitedAt).toBeNull();
    expect(coverageRatio(ledger)).toBeLessThan(1);
    expect(ledger.contentHeight).toBe(3320);
  });

  it('books a new identity to the band being looked at, and never counts it twice', () => {
    let ledger = createLedger(TOP, { contentHeight: 2000 });
    expect(ledger.identities.size).toBe(1);
    const deep = snap(
      's2',
      [raw({ backendId: '1', token: 't1', name: 'Top button' }), raw({ backendId: '2', token: 't2', name: 'New one' })],
      {
        scroll: { x: 0, y: 800 },
        capturedAt: 2000,
      },
    );
    ledger = recordSnapshot(ledger, deep);
    // The top button was already known; only the second identity is new.
    expect(ledger.identities.size).toBe(2);
    const band2 = ledger.bands.find((b) => b.y === 720)!;
    expect(band2.newIdentities).toBe(1);
    expect(ledger.bands[0].newIdentities).toBe(1);
    // Reading the same snapshot again must not invent coverage or identities.
    const again = recordSnapshot(ledger, deep);
    expect(again.identities.size).toBe(2);
    expect(again.bands.find((b) => b.y === 720)!.newIdentities).toBe(1);
  });

  it('will not mix coverage from two documents', () => {
    const ledger = createLedger(TOP, { contentHeight: 2000 });
    const other = snap('s2', [raw({ backendId: '5', token: 't5' })], { url: 'https://shop.test/checkout' });
    expect(() => recordSnapshot(ledger, other)).toThrow(/different document/);
    expect(() => recordSnapshot(ledger, other)).toThrow(/new ledger/);
  });

  it('counts budget omissions across the run rather than only the last read', () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      raw({ backendId: `${i}`, token: `t${i}`, name: `B${i}`, path: `html>body>button[${i + 1}]` }),
    );
    let ledger = createLedger(snap('s1', many, { budget: 2 }), { contentHeight: 1000 });
    expect(ledger.omittedByBudget).toBe(4);
    ledger = recordSnapshot(ledger, snap('s2', many, { budget: 3, capturedAt: 1500 }));
    expect(ledger.omittedByBudget).toBe(7);
    expect(ledger.gaps.join(' ')).toContain('dropped from the latest snapshot');
  });
});

describe('frames', () => {
  it('reports a declared frame that never produced a node', () => {
    const ledger = createLedger(TOP, {
      declaredFrames: [{ frameId: 'main', positionKnown: true }, { frameId: 'iframe-pay' }],
    });
    expect(ledger.frames.find((f) => f.frameId === 'main')!.observed).toBe(true);
    expect(ledger.frames.find((f) => f.frameId === 'iframe-pay')!.observed).toBe(false);
    expect(ledger.gaps.join(' ')).toContain('frame(s) never read: iframe-pay');
    expect(complete(ledger)).toBe(false);
  });

  it('records a frame that showed up without being declared', () => {
    const inside = snap('s1', [raw({ backendId: '7', token: 't7', frameId: 'main>0' })]);
    const ledger = createLedger(inside, { contentHeight: 800 });
    const frame = ledger.frames.find((f) => f.frameId === 'main>0');
    expect(frame).toBeTruthy();
    expect(frame!.reason).toContain('without being declared');
    expect(frame!.positionKnown).toBe(false);
    expect(ledger.gaps.join(' ')).toContain('read but not positioned');
  });

  it('accumulates node counts per frame over several reads', () => {
    let ledger = createLedger(snap('s1', [raw({ frameId: 'main>0', backendId: '1', token: 't1' })]), {
      contentHeight: 800,
    });
    ledger = recordSnapshot(
      ledger,
      snap('s2', [raw({ frameId: 'main>0', backendId: '2', token: 't2', path: 'html>body>button[2]' })], {
        capturedAt: 1500,
      }),
    );
    expect(ledger.frames.find((f) => f.frameId === 'main>0')!.nodesSeen).toBe(2);
  });
});

describe('scan planning', () => {
  const tall = (): Ledger => createLedger(TOP, { contentHeight: 2000 }); // bands at 0, 720, 1440, 2160(ceil→3 bands? 2000/720 = 2.78 → 3)

  it('plans nothing when the page height is unknown', () => {
    const ledger = createLedger(TOP, {});
    const plan = planScan(ledger);
    expect(plan.scrolls).toEqual([]);
    expect(plan.reason).toContain('page height unknown');
  });

  it('aims each step at the top of a band, clamped to where the page can actually scroll', () => {
    const ledger = tall();
    expect(ledger.bands).toHaveLength(3);
    const plan = planScan(ledger, { maxSteps: 8 });
    expect(plan.scrolls).toEqual([720, 1280]); // 1440 clamps to maxScroll = 2000 - 720
    expect(new Set(plan.scrolls).size).toBe(plan.scrolls.length);
    expect(plan.reason).toContain('max scroll 1280');
    expect(plan.remaining).toBe(0);
  });

  it('stops at the budget and says that is why', () => {
    const ledger = tall();
    const spent: Ledger = { ...ledger, budget: { maxSteps: 2, stepsSpent: 2 } };
    const plan = planScan(spent, { maxSteps: 4 });
    expect(plan.scrolls).toEqual([]);
    expect(plan.reason).toContain('out of scan budget');
    expect(plan.remaining).toBe(2);
  });

  it('has nothing to plan once every band has been read', () => {
    let ledger = tall();
    for (const y of [0, 540, 1080, 1440, 1600]) {
      ledger = recordSnapshot(
        ledger,
        snap(`s${y}`, [raw({ backendId: String(y), token: `t${y}` })], { scroll: { x: 0, y }, capturedAt: 1000 + y }),
      );
    }
    const plan = planScan(ledger);
    expect(plan.scrolls).toEqual([]);
    expect(plan.reason).toContain('every band has been visited');
    expect(coverageRatio(ledger)).toBe(1);
  });

  it('reports the cost of each read against the scan budget', () => {
    let ledger = tall();
    const before = ledger.budget.stepsSpent;
    ledger = recordSnapshot(
      ledger,
      snap('s2', [raw({ backendId: '2', token: 't2' })], { scroll: { x: 0, y: 540 }, capturedAt: 1500 }),
    );
    expect(ledger.budget.stepsSpent).toBe(before + 1);
  });
});

describe('description', () => {
  it('fits the budget and reports what it dropped', () => {
    const ledger = createLedger(TOP, {
      contentHeight: 5000,
      declaredFrames: [{ frameId: 'main', positionKnown: true }, { frameId: 'ad' }],
    });
    const tight = describeLedger(ledger, 100);
    expect(tight.text.length).toBeLessThanOrEqual(100);
    expect(tight.omitted.length).toBeGreaterThan(0);
    const roomy = describeLedger(ledger, 2000);
    expect(roomy.text).toContain('bands 1/7');
    expect(roomy.text).toContain('gap:');
    expect(roomy.omitted).toHaveLength(0);
  });
});

describe('state discovery', () => {
  const node = (over: Partial<RawNode> = {}): RawNode => raw({ backendId: '3', token: 't3', ...over });
  const perceived = (over: Partial<RawNode> = {}) => buildSnapshot([node(over)], baseOf(over)).nodes[0];
  const baseOf = (_over: Partial<RawNode>): BuildOptions => ({
    snapshotId: 'x',
    url: 'https://shop.test/long-page',
    title: 't',
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    scroll: { x: 0, y: 0 },
    capturedAt: 1,
  });

  it('offers a disclosure and says how to undo it', () => {
    const r = classifyReveal(perceived({ tag: 'details', role: '', name: 'Details', text: 'Details' }), 'expand');
    expect(r.safety).toBe('SAFE_REVERSIBLE');
    expect(r.restore).toBe('collapse it again');
  });

  it('refuses to treat a label that destroys as a reversible disclosure', () => {
    const r = classifyReveal(perceived({ name: 'Delete item', text: 'Delete item', expanded: true }), 'expand');
    expect(r.safety).toBe('REFUSED');
    expect(r.reason).toContain('Delete item');
  });

  it('refuses navigation and submission, and says what cannot be undone', () => {
    const link = classifyReveal(perceived({ tag: 'a', role: 'link', name: 'Next page', href: '/next' }), 'navigate');
    expect(link.safety).toBe('REFUSED');
    expect(link.restore).toBe('not reversible without a back navigation');
    const submit = classifyReveal(perceived({ name: 'Send now', text: 'Send now' }), 'submit');
    expect(submit.safety).toBe('REFUSED');
  });

  it('escalates a click that might be wired to a request', () => {
    const r = classifyReveal(perceived({ name: 'Show more', text: 'Show more' }), 'click-toggle');
    expect(r.safety).toBe('NEEDS_CONFIRMATION');
  });

  it('escalates what it does not recognise instead of guessing', () => {
    const r = classifyReveal(perceived({ tag: 'div', role: '', name: 'Mystery', text: 'Mystery' }), 'unknown');
    expect(r.safety).toBe('NEEDS_CONFIRMATION');
    expect(r.reason).toContain('not recognised');
  });

  it('lists candidates only for elements that are not currently contributing', () => {
    const snapshot = snap('s1', [
      raw({ backendId: '1', token: 't1', name: 'Visible now' }),
      raw({ backendId: '2', token: 't2', name: 'Down the page', inViewport: false, path: 'html>body>button[2]' }),
      raw({ backendId: '3', token: 't3', name: 'Hidden panel', styleVisible: false, path: 'html>body>button[3]' }),
      raw({
        backendId: '4',
        token: 't4',
        name: 'Plain text',
        tag: 'span',
        role: '',
        interactive: false,
        inViewport: false,
        path: 'html>body>span[1]',
      }),
    ]);
    const candidates = revealCandidates(snapshot);
    const labels = candidates.map((c) => c.label);
    expect(labels).toContain('Down the page');
    expect(labels).toContain('Hidden panel');
    expect(labels).not.toContain('Visible now');
    expect(labels).not.toContain('Plain text');
  });

  it('classifies an off-screen anchor as a refused navigation', () => {
    const snapshot = snap('s1', [
      raw({
        backendId: '5',
        token: 't5',
        tag: 'a',
        role: 'link',
        name: 'Checkout',
        href: '/checkout',
        inViewport: false,
      }),
    ]);
    const [candidate] = revealCandidates(snapshot);
    expect(candidate.kind).toBe('navigate');
    expect(candidate.safety).toBe('REFUSED');
  });

  it('classifies a collapsed disclosure ahead of its own label', () => {
    const snapshot = snap('s1', [
      raw({
        backendId: '6',
        token: 't6',
        tag: 'details',
        role: '',
        name: 'Shipping details',
        text: 'Shipping details',
        inViewport: false,
        expanded: true,
      }),
    ]);
    const [candidate] = revealCandidates(snapshot);
    expect(candidate.kind).toBe('expand');
    expect(candidate.safety).toBe('SAFE_REVERSIBLE');
  });

  it('caps the list it hands back', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      raw({ backendId: `${i}`, token: `t${i}`, name: `B${i}`, inViewport: i > 3, path: `html>body>button[${i + 1}]` }),
    );
    // Four of the twenty are off-screen, and the cap is what is being tested, not the fixture size.
    expect(revealCandidates(snap('s1', many), 3)).toHaveLength(3);
    expect(revealCandidates(snap('s1', many), 12)).toHaveLength(4);
  });
});

describe('collapsed disclosures', () => {
  const details = (over: Partial<RawNode> = {}): RawNode =>
    raw({
      backendId: '20',
      token: 't20',
      tag: 'details',
      role: '',
      name: 'Shipping',
      text: 'Shipping',
      path: 'html>body>details[1]',
      ...over,
    });

  it('offers a closed disclosure that is perfectly visible', () => {
    const snapshot = snap('s1', [details({ expanded: false })]);
    const [candidate] = revealCandidates(snapshot);
    expect(candidate.kind).toBe('expand');
    expect(candidate.safety).toBe('SAFE_REVERSIBLE');
    expect(candidate.label).toBe('Shipping');
  });

  it('leaves an open disclosure alone — it is already contributing', () => {
    const snapshot = snap('s1', [details({ expanded: true })]);
    expect(revealCandidates(snapshot)).toHaveLength(0);
  });

  it('does not mistake an element with no expansion state for a closed disclosure', () => {
    const snapshot = snap('s1', [raw({ backendId: '21', token: 't21', name: 'Ordinary button' })]);
    expect(snapshot.nodes[0].state.expanded).toBeUndefined();
    expect(revealCandidates(snapshot)).toHaveLength(0);
  });
});
