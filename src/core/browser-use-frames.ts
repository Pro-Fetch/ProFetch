/**
 * Frames: where the collector's numbers have to be moved before they mean anything.
 *
 * `getBoundingClientRect()` is always relative to the viewport of the document the script runs in. So a
 * button inside an iframe is reported at a coordinate inside *that* iframe, and a click at those numbers
 * in the top frame hits whatever is at that spot in the parent — usually nothing, sometimes the wrong
 * thing. Lifting a nested frame's boxes into the top frame is arithmetic, but the offset has to be
 * *measured*, and a cross-origin frame will refuse to give it.
 *
 * The refusal is the design, not a limitation to average away. `window.frameElement` throws for a
 * cross-origin parent, and this module turns that into `null` offsets, a warning naming the frame, and a
 * coordinate layer that will not guess. Silently treating an unmeasured frame as if it sat at 0,0 is how
 * an agent ends up clicking a header instead of a pay button.
 *
 * Playwright is not imported here. A frame is anything with `url()`, `name()` and `parentFrame()`, and the
 * collector is an injected function, so all of this is testable without a browser — which is the only
 * reason the cross-origin case is testable at all.
 */

import type { Rect, RawNode } from './browser-use-perception.js';

export interface FrameLike {
  url(): string;
  name(): string;
  parentFrame(): FrameLike | null;
}

export interface PageLike {
  frames(): FrameLike[];
}

/** Runs the collector inside one frame and returns what it reported. */
export type CollectorRunner = (
  frame: FrameLike,
) => Promise<{ nodes: RawNode[]; url: string; title: string; scanned?: number; capped?: boolean }>;

export interface FrameInfo {
  /**
   * Stable for as long as the frame keeps its position among its siblings. Ids are derived from the tree,
   * not from Playwright's ephemeral frame objects, because element identity hashes the frame id — an id
   * that changed at random would look like every element in the frame had been replaced.
   */
  frameId: string;
  parentFrameId: string | null;
  url: string;
  name: string;
  depth: number;
  /** `about:blank` and `about:srcdoc` inherit their parent; recording that keeps the URL honest. */
  inheritedUrl: boolean;
}

export interface FrameHop {
  frameId: string;
  /** Offset of this frame inside its parent's viewport, or null when the frame could not report it. */
  offset: { x: number; y: number } | null;
  /** Why the offset is missing, when it is. */
  reason: string;
}

export interface FrameCollection {
  frames: FrameInfo[];
  hops: Map<string, FrameHop>;
  /** Nodes from every frame, with `frameId` rewritten and `rect` lifted into the top frame. */
  nodes: RawNode[];
  /** Nodes that could not be lifted, with the reason. They are kept visible, not dropped. */
  unlifted: Array<{ frameId: string; count: number; reason: string }>;
  /** Cumulative offset per frame, or null when a hop on the way to it is unknown. */
  offsets: Map<string, { x: number; y: number } | null>;
  /**
   * What the in-page walks say about their own limits. A collector stops at a fixed number of stamped
   * elements, and a read that reached that ceiling has not seen the rest of the document — which is a fact
   * about the answer, not a detail of the implementation.
   */
  walk: { scanned: number; reported: number; capped: boolean };
  warnings: string[];
}

const TOP_FRAME_ID = 'main';

function isInternal(url: string): boolean {
  return url === '' || url === 'about:blank' || url.startsWith('about:srcdoc');
}

/**
 * Assign an id to every frame in the page.
 *
 * Sibling order is what makes an id stable: a frame keeps its identity while the page keeps the iframe in
 * the same place in the DOM. If a page reorders its iframes, the ids move, identities change, and any
 * target held from before stops resolving — the safe direction, and the one that gets reported.
 */
export function frameInfos(page: PageLike): FrameInfo[] {
  return infosFromArray(page.frames());
}

function infosFromArray(frames: FrameLike[]): FrameInfo[] {
  const indexInParent = new Map<FrameLike, number>();
  const siblings = new Map<FrameLike, FrameLike[]>();
  for (const frame of frames) {
    const parent = frame.parentFrame();
    if (!parent) continue;
    const list = siblings.get(parent) ?? [];
    list.push(frame);
    siblings.set(parent, list);
  }
  for (const list of siblings.values()) list.forEach((frame, i) => indexInParent.set(frame, i));

  const ids = new Map<FrameLike, string>();
  const idOf = (frame: FrameLike): string => {
    const cached = ids.get(frame);
    if (cached) return cached;
    const parent = frame.parentFrame();
    const id = parent ? `${idOf(parent)}>${indexInParent.get(frame) ?? 0}` : TOP_FRAME_ID;
    ids.set(frame, id);
    return id;
  };

  return frames.map((frame) => {
    const parent = frame.parentFrame();
    return {
      frameId: idOf(frame),
      parentFrameId: parent ? idOf(parent) : null,
      url: frame.url(),
      name: frame.name(),
      depth: parent ? depthOf(parent) + 1 : 0,
      inheritedUrl: parent !== null && isInternal(frame.url()),
    };
  });
}

/** Depth by walking parents, because a frame's own index says nothing about nesting. */
function depthOf(frame: FrameLike): number {
  let depth = 0;
  let current = frame.parentFrame();
  while (current) {
    depth++;
    current = current.parentFrame();
  }
  return depth;
}

/**
 * The script that measures one frame's offset inside its parent.
 *
 * Plain JavaScript, evaluated inside the frame: `window.frameElement` is the iframe element in the parent
 * document, and reading it across origins throws — which is the only honest way to discover that the
 * offset cannot be known from here.
 */
export const HOP_SCRIPT = `(() => {
  try {
    const el = window.frameElement;
    if (!el) return { ok: true, x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    return { ok: true, x: Math.round(r.left * 100) / 100, y: Math.round(r.top * 100) / 100 };
  } catch (error) {
    return { ok: false, reason: String((error && error.message) || error) };
  }
})()`;

export interface HopResult {
  ok: boolean;
  x?: number;
  y?: number;
  reason?: string;
}

/** Cumulative offsets for every frame, walking the chain so a nested frame adds up. */
export function resolveOffsets(
  frames: FrameInfo[],
  measured: Map<string, HopResult>,
): Map<string, { x: number; y: number } | null> {
  const byId = new Map(frames.map((f) => [f.frameId, f]));
  const offsets = new Map<string, { x: number; y: number } | null>();
  const resolve = (frameId: string): { x: number; y: number } | null => {
    if (offsets.has(frameId)) return offsets.get(frameId) ?? null;
    const frame = byId.get(frameId);
    if (!frame) return null;
    if (!frame.parentFrameId) {
      offsets.set(frameId, { x: 0, y: 0 });
      return { x: 0, y: 0 };
    }
    const parentOffset = resolve(frame.parentFrameId);
    const hop = measured.get(frameId);
    if (!hop?.ok || typeof hop.x !== 'number' || typeof hop.y !== 'number' || parentOffset === null) {
      offsets.set(frameId, null);
      return null;
    }
    // The hop is measured in the parent's viewport, so the parent's own scroll is already inside it.
    const value = { x: parentOffset.x + hop.x, y: parentOffset.y + hop.y };
    offsets.set(frameId, value);
    return value;
  };
  for (const frame of frames) resolve(frame.frameId);
  return offsets;
}

export function liftRect(rect: Rect, offset: { x: number; y: number }): Rect {
  return {
    x: Math.round((rect.x + offset.x) * 100) / 100,
    y: Math.round((rect.y + offset.y) * 100) / 100,
    width: rect.width,
    height: rect.height,
  };
}

/**
 * Collect every frame of a page into one node list.
 *
 * `runCollector` measures inside a frame and `runHop` reads the offset script — both injected, so the
 * cross-origin case is testable with a fake frame that refuses, instead of needing a site that would
 * really put a foreign iframe on the page.
 */
export async function collectAllFrames(
  page: PageLike,
  runCollector: CollectorRunner,
  runHop: (frame: FrameLike) => Promise<HopResult>,
): Promise<FrameCollection> {
  const frames = page.frames();
  const infos = infosFromArray(frames);
  const infoByIndex = infos.map((info, i) => ({ info, frame: frames[i]! }));
  const measured = new Map<string, HopResult>();
  const hops = new Map<string, FrameHop>();
  const warnings: string[] = [];

  for (const { info, frame } of infoByIndex) {
    if (!info.parentFrameId) {
      measured.set(info.frameId, { ok: true, x: 0, y: 0 });
      hops.set(info.frameId, { frameId: info.frameId, offset: { x: 0, y: 0 }, reason: 'top frame' });
      continue;
    }
    const hop = await runHop(frame);
    measured.set(info.frameId, hop);
    if (hop.ok) {
      hops.set(info.frameId, {
        frameId: info.frameId,
        offset: { x: hop.x ?? 0, y: hop.y ?? 0 },
        reason: 'measured from inside the frame',
      });
    } else {
      const reason = `frame ${info.frameId} (${info.url || 'no url'}) cannot report its position: ${hop.reason ?? 'unknown'}`;
      hops.set(info.frameId, { frameId: info.frameId, offset: null, reason });
      warnings.push(reason);
    }
  }

  const offsets = resolveOffsets(infos, measured);
  const nodes: RawNode[] = [];
  const unlifted: FrameCollection['unlifted'] = [];
  let scanned = 0;
  let reported = 0;
  let capped = false;
  for (const { info, frame } of infoByIndex) {
    const collected = await runCollector(frame);
    // Counted before the lift decision below: the walk happened either way, and a frame whose nodes could
    // not be placed would otherwise vanish from the totals as if it had never been read.
    scanned += collected.scanned ?? collected.nodes.length;
    reported += collected.nodes.length;
    capped = capped || collected.capped === true;
    const offset = offsets.get(info.frameId) ?? null;
    if (collected.nodes.length && offset === null && info.frameId !== TOP_FRAME_ID) {
      unlifted.push({
        frameId: info.frameId,
        count: collected.nodes.length,
        reason: hops.get(info.frameId)?.reason ?? 'offset unknown',
      });
      continue;
    }
    const use = offset ?? { x: 0, y: 0 };
    const boundary = info.parentFrameId ? [`iframe ${info.frameId} (${collected.url || info.url || 'inherited'})`] : [];
    for (const node of collected.nodes) {
      nodes.push({
        ...node,
        frameId: info.frameId,
        rect: liftRect(node.rect, use),
        // A node's own boundaries plus the frames above it: an agent needs to know that a click here
        // crosses a frame boundary before it decides the point is reachable.
        boundaries: [...boundary, ...node.boundaries],
      });
    }
  }

  return { frames: infos, hops, nodes, unlifted, offsets, walk: { scanned, reported, capped }, warnings };
}

/** A short human-readable account of the frame layer, for a tool answer. */
export function describeFrames(collection: FrameCollection): string {
  const nested = collection.frames.filter((f) => f.parentFrameId);
  if (!nested.length) return 'single frame, no boundaries crossed';
  const lifted = collection.frames
    .filter((f) => f.parentFrameId)
    .map((f) => {
      const off = collection.offsets.get(f.frameId);
      return `${f.frameId}@${off ? `${Math.round(off.x)},${Math.round(off.y)}` : 'offset unknown'}`;
    })
    .join(', ');
  const dropped = collection.unlifted.reduce((n, u) => n + u.count, 0);
  return `${collection.frames.length} frames (${lifted})${dropped ? `, ${dropped} node(s) not lifted` : ''}`;
}
