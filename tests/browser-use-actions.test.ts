import { describe, it, expect } from 'vitest';
import {
  performAction,
  preflight,
  verifyAction,
  withVerification,
  type Action,
  type ActionPolicy,
} from '../src/core/browser-use-actions.js';
import { buildSnapshot, type BuildOptions, type RawNode, type Snapshot } from '../src/core/browser-use-perception.js';
import { createWorldModel, applySnapshot, type WorldModel } from '../src/core/browser-use-world.js';

/**
 * An action engine is easiest to test on the decisions it refuses. These fixtures are hand-built so every
 * refusal can be traced to one condition, and the live probe (`npm run probe:browser-use`) repeats the
 * allowed path against a real browser, where the value and the click have to actually land.
 */

function raw(over: Partial<RawNode> = {}): RawNode {
  return {
    backendId: '1',
    token: 't1',
    frameId: 'main',
    path: 'html>body>button[1]',
    tag: 'button',
    role: 'button',
    name: 'Continue',
    text: 'Continue',
    rect: { x: 100, y: 100, width: 120, height: 40 },
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

const options: BuildOptions = {
  snapshotId: 'a-1',
  url: 'https://shop.test/checkout',
  title: 'Checkout',
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
  scroll: { x: 0, y: 0 },
  capturedAt: 1000,
};

const snap = (nodes: RawNode[], over: Partial<BuildOptions> = {}): Snapshot =>
  buildSnapshot(nodes, { ...options, ...over });

function world(
  nodes: RawNode[],
  over: Partial<BuildOptions> = {},
): { model: WorldModel; snapshot: Snapshot; node: RawNode } {
  const snapshot = snap(nodes, over);
  const model = createWorldModel(snapshot, { tabId: 'tab-1' });
  return { model, snapshot, node: nodes[0]! };
}

function targetOf(snapshot: Snapshot, name: string) {
  const node = snapshot.nodes.find((n) => n.name === name)!;
  return { identity: node.identity, backendId: node.backendId, token: node.token, rect: node.rect };
}

const action = (kind: Action['kind'], snapshot: Snapshot, name: string, value?: string | boolean): Action => ({
  kind,
  target: targetOf(snapshot, name),
  ...(value === undefined ? {} : { value }),
});

describe('preflight — what stops an action', () => {
  it('allows a healthy click and hands back the point to use', () => {
    const { model, snapshot } = world([raw()]);
    const p = preflight(action('click', snapshot, 'Continue'), model, snapshot);
    expect(p.decision).toBe('ALLOW');
    expect(p.point).toMatchObject({ x: 160, y: 120, space: 'css-viewport', frameId: 'main' });
    expect(p.reason).toContain('resolves');
  });

  it('refuses an element the model no longer believes in', () => {
    const { model, snapshot } = world([raw({ token: 't1' })]);
    const replaced = snapshot.nodes.map((n) => ({ ...n, token: 'other', identity: 'deadbeef' }));
    const next = snap([raw({ token: 'zzz' })], { snapshotId: 'a-2' });
    const { model: moved } = { model: applySnapshot(model, next, { tabId: 'tab-1' }).model };
    const stale = preflight(
      { kind: 'click', target: { identity: replaced[0]!.identity, backendId: '1', token: 't1' } },
      moved,
      next,
    );
    expect(stale.decision).toBe('REFUSE');
    expect(stale.reason).toMatch(/GONE|REPLACED|NAVIGATED|never in the model/);
  });

  it('refuses a disabled control', () => {
    const { model, snapshot } = world([raw({ disabled: true })]);
    const p = preflight(action('click', snapshot, 'Continue'), model, snapshot);
    expect(p.decision).toBe('REFUSE');
    expect(p.reason).toContain('disabled');
  });

  it('refuses an element that something is covering', () => {
    const { model, snapshot } = world([raw({ obstructed: true, hitTestSelf: false })]);
    const p = preflight(action('click', snapshot, 'Continue'), model, snapshot);
    expect(p.decision).toBe('REFUSE');
    expect(p.reason).toMatch(/on top of/);
  });

  it('asks for a scroll first when the element is outside the read viewport', () => {
    const { model, snapshot } = world([
      raw({
        name: 'Down below',
        text: 'Down below',
        inViewport: false,
        rect: { x: 10, y: 2600, width: 100, height: 40 },
      }),
    ]);
    const p = preflight(action('click', snapshot, 'Down below'), model, snapshot);
    expect(p.decision).toBe('SCROLL_FIRST');
    expect(p.scrollHint!.y).toBeGreaterThan(2000);
    expect(p.scrollHint!.y).toBeLessThan(2600);
  });

  it('refuses when the point no longer belongs to the element', () => {
    // A deeper element occupies the same centre, so the geometry check finds a different owner.
    const { model, snapshot } = world([
      raw({ backendId: '1', token: 't1', name: 'Wanted', text: 'Wanted', depth: 2, path: 'html>body>div>button[1]' }),
      raw({
        backendId: '2',
        token: 't2',
        name: 'Cover',
        text: 'Cover',
        depth: 6,
        path: 'html>body>div>div>span[1]',
        tag: 'span',
        role: '',
        interactive: false,
      }),
    ]);
    const p = preflight({ kind: 'click', target: targetOf(snapshot, 'Wanted') }, model, snapshot);
    expect(p.decision).toBe('REFUSE');
    expect(p.reason).toMatch(/no longer belongs/);
  });
});

describe('preflight — policy', () => {
  it('refuses every changing action in a read-only process but still allows reveals', () => {
    const { model, snapshot } = world([raw()]);
    const policy: ActionPolicy = { readOnly: true };
    expect(preflight(action('click', snapshot, 'Continue'), model, snapshot, policy).decision).toBe('REFUSE');
    expect(preflight(action('type', snapshot, 'Continue', 'x'), model, snapshot, policy).decision).toBe('REFUSE');
    const hover = preflight(action('hover', snapshot, 'Continue'), model, snapshot, policy);
    expect(hover.decision).toBe('ALLOW');
    expect(hover.reason).toContain('nothing on the page is changed');
  });

  it('refuses a verb that changes something off the page', () => {
    const { model, snapshot } = world([raw({ name: 'Delete account', text: 'Delete account' })]);
    const p = preflight(action('click', snapshot, 'Delete account'), model, snapshot);
    expect(p.decision).toBe('REFUSE');
    expect(p.reason).toContain('Delete account');
  });

  it('escalates a submitting control instead of acting on it, and acts once confirmed', () => {
    const { model, snapshot } = world([raw({ name: 'Sign in', text: 'Sign in' })]);
    const a = action('click', snapshot, 'Sign in');
    expect(preflight(a, model, snapshot).decision).toBe('NEEDS_CONFIRMATION');
    expect(preflight(a, model, snapshot, { confirmed: true }).decision).toBe('ALLOW');
  });

  it('escalates a download, print or share', () => {
    const { model, snapshot } = world([raw({ name: 'Download invoice', text: 'Download invoice' })]);
    const p = preflight(action('click', snapshot, 'Download invoice'), model, snapshot);
    expect(p.decision).toBe('NEEDS_CONFIRMATION');
    expect(p.reason).toMatch(/download/i);
  });

  it('honours a caller that disallowed reveals', () => {
    const { model, snapshot } = world([raw()]);
    const p = preflight(action('hover', snapshot, 'Continue'), model, snapshot, { allowReveal: false });
    expect(p.decision).toBe('REFUSE');
  });
});

describe('preflight — values', () => {
  it('refuses to type into something that is not a text control', () => {
    const { model, snapshot } = world([raw()]);
    const p = preflight(action('type', snapshot, 'Continue', 'hello'), model, snapshot);
    expect(p.decision).toBe('REFUSE');
    expect(p.reason).toMatch(/typing belongs to a text control/);
  });

  it('refuses an empty type and an absurdly long one', () => {
    const { model, snapshot } = world([
      raw({ tag: 'input', role: 'textbox', name: 'Coupon', text: '', placeholder: 'Coupon' }),
    ]);
    expect(preflight(action('type', snapshot, 'Coupon', ''), model, snapshot).reason).toMatch(/non-empty string/);
    expect(preflight(action('type', snapshot, 'Coupon', 'x'.repeat(2500)), model, snapshot).reason).toMatch(/payload/);
    expect(preflight(action('type', snapshot, 'Coupon', 'SAVE20'), model, snapshot).decision).toBe('ALLOW');
  });

  it('refuses to check a control that is not a checkbox', () => {
    const { model, snapshot } = world([raw()]);
    const p = preflight(action('check', snapshot, 'Continue', true), model, snapshot);
    expect(p.decision).toBe('REFUSE');
    expect(p.reason).toMatch(/not a checkbox/);
  });

  it('accepts a real checkbox and a select with an option', () => {
    const { model, snapshot } = world([
      raw({
        backendId: '1',
        token: 't1',
        tag: 'input',
        role: 'checkbox',
        name: 'Gift wrap',
        text: '',
        path: 'html>body>input[1]',
        rect: { x: 40, y: 60, width: 24, height: 24 },
      }),
      raw({
        backendId: '2',
        token: 't2',
        tag: 'select',
        role: 'combobox',
        name: 'Size',
        text: '',
        path: 'html>body>select[1]',
        rect: { x: 40, y: 120, width: 160, height: 32 },
      }),
    ]);
    expect(preflight(action('check', snapshot, 'Gift wrap', true), model, snapshot).decision).toBe('ALLOW');
    expect(preflight(action('select', snapshot, 'Size', 'Large'), model, snapshot).decision).toBe('ALLOW');
    expect(preflight(action('select', snapshot, 'Size'), model, snapshot).reason).toMatch(/needs an option/);
  });
});

describe('performAction', () => {
  it('never calls the executor for a refused action', async () => {
    const { model, snapshot } = world([raw({ name: 'Delete account', text: 'Delete account' })]);
    let called = 0;
    const out = await performAction(action('click', snapshot, 'Delete account'), model, snapshot, async () => {
      called++;
    });
    expect(out.outcome.status).toBe('REFUSED');
    expect(called).toBe(0);
  });

  it('executes when allowed and reports itself as unverified, not as a success', async () => {
    const { model, snapshot } = world([raw()]);
    let seen: { x?: number; y?: number } = {};
    const out = await performAction(action('click', snapshot, 'Continue'), model, snapshot, async (_a, p) => {
      seen = { x: p.point?.x, y: p.point?.y };
    });
    expect(out.outcome.status).toBe('EXECUTED_UNVERIFIED');
    expect(seen).toEqual({ x: 160, y: 120 });
  });

  it('turns an executor error into FAILED with the message kept', async () => {
    const { model, snapshot } = world([raw()]);
    const out = await performAction(action('click', snapshot, 'Continue'), model, snapshot, async () => {
      throw new Error('the tab closed mid-click');
    });
    expect(out.outcome.status).toBe('FAILED');
    expect(out.outcome.error).toContain('tab closed');
  });

  it('treats a scroll-first answer as a refusal to act', async () => {
    const { model, snapshot } = world([
      raw({ name: 'Far', text: 'Far', inViewport: false, rect: { x: 0, y: 3000, width: 80, height: 30 } }),
    ]);
    let called = 0;
    const out = await performAction(action('click', snapshot, 'Far'), model, snapshot, async () => {
      called++;
    });
    expect(out.outcome.status).toBe('REFUSED');
    expect(out.preflight.decision).toBe('SCROLL_FIRST');
    expect(called).toBe(0);
  });
});

describe('verifyAction', () => {
  const field = (value: string): RawNode =>
    raw({
      backendId: '5',
      token: 't5',
      tag: 'input',
      role: 'textbox',
      name: 'Coupon',
      text: '',
      placeholder: 'Coupon',
      value,
    });

  it('confirms typing by reading the value back from the page', () => {
    const before = snap([field('')]);
    const after = snap([field('SAVE20')], { snapshotId: 'a-2' });
    const v = verifyAction(
      { kind: 'type', target: targetOf(before, 'Coupon'), value: 'SAVE20' },
      before,
      after,
      before.nodes[0]!.identity,
    );
    expect(v.status).toBe('VERIFIED');
    expect(v.evidence).toContain('SAVE20');
  });

  it('says NOT_VERIFIED when the control still holds what it held before', () => {
    const before = snap([field('OLD')]);
    const after = snap([field('OLD')], { snapshotId: 'a-2' });
    const v = verifyAction(
      { kind: 'type', target: targetOf(before, 'Coupon'), value: 'SAVE20' },
      before,
      after,
      before.nodes[0]!.identity,
    );
    expect(v.status).toBe('NOT_VERIFIED');
    expect(v.evidence).toContain('still holds');
  });

  it('confirms a checkbox by its state flag', () => {
    const before = snap([
      raw({
        backendId: '6',
        token: 't6',
        tag: 'input',
        role: 'checkbox',
        name: 'Gift',
        text: '',
        checked: false,
        path: 'html>body>input[1]',
      }),
    ]);
    const after = snap(
      [
        raw({
          backendId: '6',
          token: 't6',
          tag: 'input',
          role: 'checkbox',
          name: 'Gift',
          text: '',
          checked: true,
          path: 'html>body>input[1]',
        }),
      ],
      { snapshotId: 'a-2' },
    );
    const id = before.nodes[0]!.identity;
    expect(
      verifyAction({ kind: 'check', target: { identity: id, backendId: '6' }, value: true }, before, after, id).status,
    ).toBe('VERIFIED');
    expect(
      verifyAction({ kind: 'uncheck', target: { identity: id, backendId: '6' }, value: false }, before, after, id)
        .status,
    ).toBe('NOT_VERIFIED');
  });

  it('counts a click that changed nothing as not verified', () => {
    const before = snap([raw()]);
    const after = snap([raw()], { snapshotId: 'a-2' });
    const v = verifyAction(
      { kind: 'click', target: targetOf(before, 'Continue') },
      before,
      after,
      before.nodes[0]!.identity,
    );
    expect(v.status).toBe('NOT_VERIFIED');
    expect(v.evidence).toMatch(/no difference at all/i);
  });

  it('accepts a click that changed a label, added a node or moved something', () => {
    const before = snap([raw({ name: 'Add to cart', text: 'Add to cart', backendId: '1', token: 't1' })]);
    const relabelled = snap([raw({ name: 'In cart', text: 'In cart', backendId: '1', token: 't1' })], {
      snapshotId: 'a-2',
    });
    const v = verifyAction(
      { kind: 'click', target: targetOf(before, 'Add to cart') },
      before,
      relabelled,
      before.nodes[0]!.identity,
    );
    expect(v.status).toBe('VERIFIED');
    expect(v.evidence).toMatch(/same DOM node \(token t1\)/);
    expect(v.evidence).toMatch(/In cart/);
    expect(v.evidence).toMatch(/Add to cart/);
  });

  it('recognises a click that navigated away', () => {
    const before = snap([raw()]);
    const after = snap([raw({ backendId: '9', token: 't9', name: 'Thanks', text: 'Thanks' })], {
      snapshotId: 'a-2',
      url: 'https://shop.test/done',
    });
    const v = verifyAction(
      { kind: 'click', target: targetOf(before, 'Continue') },
      before,
      after,
      before.nodes[0]!.identity,
    );
    expect(v.status).toBe('VERIFIED');
    expect(v.evidence).toMatch(/document changed/);
  });

  it('measures a scroll against the reported position', () => {
    const before = snap([raw()]);
    const after = snap([raw()], { snapshotId: 'a-2', scroll: { x: 0, y: 400 } });
    expect(
      verifyAction(
        { kind: 'scroll-to', target: targetOf(before, 'Continue') },
        before,
        after,
        before.nodes[0]!.identity,
      ).status,
    ).toBe('VERIFIED');
    expect(
      verifyAction(
        { kind: 'scroll-to', target: targetOf(before, 'Continue') },
        before,
        snap([raw()], { snapshotId: 'a-3' }),
        before.nodes[0]!.identity,
      ).status,
    ).toBe('NOT_VERIFIED');
  });

  it('does not claim a hover did something when nothing appeared', () => {
    const before = snap([raw()]);
    const after = snap([raw()], { snapshotId: 'a-2' });
    const v = verifyAction(
      { kind: 'hover', target: targetOf(before, 'Continue') },
      before,
      after,
      before.nodes[0]!.identity,
    );
    expect(v.status).toBe('NOT_VERIFIED');
    expect(v.evidence).toContain('nothing appeared');
  });
});

describe('withVerification', () => {
  it('promotes an unverified execution only when the read agrees', async () => {
    const { model, snapshot } = world([raw()]);
    const { outcome } = await performAction(action('click', snapshot, 'Continue'), model, snapshot, async () => {});
    expect(withVerification(outcome, { status: 'VERIFIED', evidence: 'a node appeared' }).status).toBe(
      'SUCCEEDED_VERIFIED',
    );
    expect(withVerification(outcome, { status: 'NOT_VERIFIED', evidence: 'nothing changed' }).status).toBe(
      'EXECUTED_BUT_NOT_VERIFIED',
    );
    expect(withVerification(outcome, { status: 'UNKNOWN', evidence: 'cannot tell' }).status).toBe(
      'EXECUTED_UNVERIFIED',
    );
  });

  it('leaves a refusal untouched — a refused action has nothing to verify', async () => {
    const { model, snapshot } = world([raw({ name: 'Delete account', text: 'Delete account' })]);
    const { outcome } = await performAction(action('click', snapshot, 'Delete account'), model, snapshot, async () => {
      throw new Error('must not run');
    });
    const after = withVerification(outcome, { status: 'VERIFIED', evidence: 'pretend' });
    expect(after.status).toBe('REFUSED');
  });
});

describe('purity', () => {
  it('does not change the model or the snapshot it was given', async () => {
    const { model, snapshot } = world([raw()]);
    const version = model.version;
    const size = model.nodes.size;
    const nodes = snapshot.nodes.length;
    preflight(action('click', snapshot, 'Continue'), model, snapshot);
    expect(model.version).toBe(version);
    expect(model.nodes.size).toBe(size);
    expect(snapshot.nodes).toHaveLength(nodes);
  });
});
