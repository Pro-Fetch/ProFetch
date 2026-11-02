import { describe, it, expect } from 'vitest';
import {
  collectAllFrames,
  describeFrames,
  frameInfos,
  liftRect,
  resolveOffsets,
  type FrameLike,
  type HopResult,
} from '../src/core/browser-use-frames.js';
import type { RawNode } from '../src/core/browser-use-perception.js';

/**
 * Frames are the part of perception that cannot be faked with a fixture of one document, and the
 * cross-origin case cannot be produced locally without a second domain. Both are handled here with
 * injected frames and injected measurements, so the behaviour that matters — refusing to guess a
 * position — is testable on a machine with no network.
 */

class FakeFrame implements FrameLike {
  constructor(
    private readonly _url: string,
    private readonly _name: string,
    private _parent: FakeFrame | null = null,
  ) {}
  url(): string {
    return this._url;
  }
  name(): string {
    return this._name;
  }
  parentFrame(): FrameLike | null {
    return this._parent;
  }
}

function node(over: Partial<RawNode> = {}): RawNode {
  return {
    backendId: 'pf-1',
    token: 't1',
    frameId: 'main',
    path: 'html>body>button[1]',
    tag: 'button',
    role: 'button',
    name: 'Pay',
    text: 'Pay',
    rect: { x: 10, y: 20, width: 100, height: 30 },
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

describe('frame identity', () => {
  it('names the top frame and numbers children by their position among siblings', () => {
    const top = new FakeFrame('https://shop.test/cart', '');
    const a = new FakeFrame('https://shop.test/pay', 'pay', top);
    const b = new FakeFrame('https://shop.test/chat', 'chat', top);
    const deep = new FakeFrame('https://shop.test/nested', 'nested', b);
    const infos = frameInfos({ frames: () => [top, a, b, deep] });
    expect(infos.map((f) => f.frameId)).toEqual(['main', 'main>0', 'main>1', 'main>1>0']);
    expect(infos.map((f) => f.depth)).toEqual([0, 1, 1, 2]);
    expect(infos.find((f) => f.frameId === 'main')!.parentFrameId).toBeNull();
    expect(infos.find((f) => f.frameId === 'main>1>0')!.parentFrameId).toBe('main>1');
  });

  it('records that an inherited url is not a real origin', () => {
    const top = new FakeFrame('https://shop.test/cart', '');
    const srcdoc = new FakeFrame('about:srcdoc', '', top);
    const blank = new FakeFrame('about:blank', '', top);
    const foreign = new FakeFrame('https://other.test/widget', '', top);
    const infos = frameInfos({ frames: () => [top, srcdoc, blank, foreign] });
    expect(infos.filter((f) => f.inheritedUrl).map((f) => f.frameId)).toEqual(['main>0', 'main>1']);
    expect(infos.find((f) => f.frameId === 'main>2')!.inheritedUrl).toBe(false);
  });
});

describe('offsets', () => {
  const frames = [
    { frameId: 'main', parentFrameId: null, url: 'https://shop.test/', name: '', depth: 0, inheritedUrl: false },
    { frameId: 'main>0', parentFrameId: 'main', url: 'https://shop.test/a', name: 'a', depth: 1, inheritedUrl: false },
    {
      frameId: 'main>0>0',
      parentFrameId: 'main>0',
      url: 'https://shop.test/b',
      name: 'b',
      depth: 2,
      inheritedUrl: false,
    },
    { frameId: 'main>1', parentFrameId: 'main', url: 'https://other.test/c', name: 'c', depth: 1, inheritedUrl: false },
  ];

  it('accumulates down the chain instead of using one hop', () => {
    const measured = new Map<string, HopResult>([
      ['main', { ok: true, x: 0, y: 0 }],
      ['main>0', { ok: true, x: 40, y: 100 }],
      ['main>0>0', { ok: true, x: 10, y: 20 }],
    ]);
    const offsets = resolveOffsets(frames, measured);
    expect(offsets.get('main>0')).toEqual({ x: 40, y: 100 });
    expect(offsets.get('main>0>0')).toEqual({ x: 50, y: 120 });
  });

  it('nulls a whole subtree when one hop on the way to it is unmeasurable', () => {
    const measured = new Map<string, HopResult>([
      ['main', { ok: true, x: 0, y: 0 }],
      ['main>0', { ok: false, reason: 'cross origin' }],
      ['main>0>0', { ok: true, x: 10, y: 20 }],
      ['main>1', { ok: false, reason: 'cross origin' }],
    ]);
    const offsets = resolveOffsets(frames, measured);
    expect(offsets.get('main>0')).toBeNull();
    expect(offsets.get('main>0>0')).toBeNull();
    expect(offsets.get('main>1')).toBeNull();
  });

  it('lifts a rect by the offset and rounds it back to two decimals', () => {
    expect(liftRect({ x: 10.005, y: 20, width: 100, height: 30 }, { x: 40, y: 100 })).toEqual({
      x: 50.01,
      y: 120,
      width: 100,
      height: 30,
    });
  });
});

describe('collection', () => {
  it('rewrites frame ids and lifts nodes out of a reachable iframe', async () => {
    const top = new FakeFrame('https://shop.test/cart', '');
    const inner = new FakeFrame('https://shop.test/pay', 'pay', top);
    const perFrame = new Map<FrameLike, { nodes: RawNode[]; url: string; title: string }>([
      [top, { nodes: [node({ token: 't1', name: 'Back' })], url: 'https://shop.test/cart', title: 'Cart' }],
      [inner, { nodes: [node({ token: 't2', name: 'Pay' })], url: 'https://shop.test/pay', title: 'Pay' }],
    ]);
    const hops = new Map<FrameLike, HopResult>([
      [top, { ok: true, x: 0, y: 0 }],
      [inner, { ok: true, x: 0, y: 300 }],
    ]);
    const c = await collectAllFrames(
      { frames: () => [top, inner] },
      async (f) => perFrame.get(f)!,
      async (f) => hops.get(f)!,
    );

    expect(c.nodes).toHaveLength(2);
    const pay = c.nodes.find((n) => n.name === 'Pay')!;
    expect(pay.frameId).toBe('main>0');
    expect(pay.rect).toEqual({ x: 10, y: 320, width: 100, height: 30 });
    // The token is the node's own, so identity moves with the frame id and not with the layout.
    expect(pay.token).toBe('t2');
    expect(pay.boundaries).toEqual(['iframe main>0 (https://shop.test/pay)']);
    expect(c.unlifted).toEqual([]);
    expect(c.warnings).toEqual([]);
    expect(describeFrames(c)).toContain('2 frames');
  });

  it('keeps a cross-origin frame visible instead of quietly dropping its coordinates', async () => {
    const top = new FakeFrame('https://shop.test/cart', '');
    const foreign = new FakeFrame('https://other.test/widget', 'widget', top);
    const perFrame = new Map<FrameLike, { nodes: RawNode[]; url: string; title: string }>([
      [top, { nodes: [node()], url: 'https://shop.test/cart', title: 'Cart' }],
      [
        foreign,
        {
          nodes: [node({ token: 't9', name: 'Third-party pay' }), node({ token: 't8', name: 'Third-party cancel' })],
          url: 'https://other.test/widget',
          title: 'Widget',
        },
      ],
    ]);
    const hops = new Map<FrameLike, HopResult>([
      [top, { ok: true, x: 0, y: 0 }],
      [
        foreign,
        {
          ok: false,
          reason: "Failed to read the 'frameElement' property on 'Window': permission denied",
        },
      ],
    ]);
    const c = await collectAllFrames(
      { frames: () => [top, foreign] },
      async (f) => perFrame.get(f)!,
      async (f) => hops.get(f)!,
    );

    expect(c.nodes).toHaveLength(1);
    expect(c.nodes[0].frameId).toBe('main');
    expect(c.unlifted).toHaveLength(1);
    expect(c.unlifted[0]).toMatchObject({ frameId: 'main>0', count: 2 });
    expect(c.unlifted[0].reason).toMatch(/cannot report its position/);
    expect(c.warnings.join(' ')).toMatch(/other.test\/widget/);
    expect(describeFrames(c)).toContain('2 node(s) not lifted');
    // The offset is null, so nothing downstream can treat 0,0 as if it had been measured.
    expect(c.offsets.get('main>0')).toBeNull();
  });

  it('says plainly when there are no frames to worry about', async () => {
    const top = new FakeFrame('https://shop.test/cart', '');
    const c = await collectAllFrames(
      { frames: () => [top] },
      async () => ({ nodes: [node()], url: 'https://shop.test/cart', title: 'Cart' }),
      async () => ({ ok: true, x: 0, y: 0 }),
    );
    expect(describeFrames(c)).toBe('single frame, no boundaries crossed');
    expect(c.frames).toHaveLength(1);
  });

  it('does not let an unreadable parent poison the top frame', async () => {
    const top = new FakeFrame('https://shop.test/cart', '');
    const inner = new FakeFrame('https://other.test/x', 'x', top);
    const c = await collectAllFrames(
      { frames: () => [top, inner] },
      async (f) => ({ nodes: [node({ token: f === top ? 't1' : 't2' })], url: f.url(), title: 't' }),
      async (f) => (f === top ? { ok: true, x: 0, y: 0 } : { ok: false, reason: 'cross origin' }),
    );
    expect(c.nodes).toHaveLength(1);
    expect(c.nodes[0].frameId).toBe('main');
    expect(c.offsets.get('main')).toEqual({ x: 0, y: 0 });
  });
});
