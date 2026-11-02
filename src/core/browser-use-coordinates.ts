/**
 * Coordinate spaces. One page, four number systems, and every bug in this area comes from mixing them
 * up without saying so.
 *
 * A `getBoundingClientRect()` box is in **CSS viewport** pixels: origin at the top-left of what the user
 * can currently see, unaffected by device pixel ratio. A CDP `Input.dispatchMouseEvent` point is also in
 * CSS viewport pixels — but a screenshot's pixels are **device** pixels, and a full-page screenshot is a
 * stitched image whose origin is the top of the *document*, not the viewport. Feed the first into the
 * second and clicks land offset by exactly the scroll position or by the DPR: on a 2× display the error is
 * invisible until someone plugs in a 1× monitor.
 *
 * So nothing here takes a bare number. Every conversion names the space it leaves and the space it enters,
 * and the record types carry the space they were measured in.
 */

import type { Rect, Snapshot } from './browser-use-perception.js';

export type CoordinateSpace =
  /** CSS pixels, origin at the current viewport top-left. What the collector and CDP input use. */
  | 'css-viewport'
  /** CSS pixels, origin at the top-left of the whole document. */
  | 'css-page'
  /** Physical pixels inside a screenshot image. Origin depends on which screenshot. */
  | 'image-device'
  /** CSS pixels local to one element's box, for points inside a widget. */
  | 'css-element';

export interface PointIn {
  x: number;
  y: number;
  space: CoordinateSpace;
  /** Which frame this point lives in. A point without a frame is a point to nothing. */
  frameId: string;
}

export interface ScreenshotGeometry {
  /** The kind of capture, because it decides where the origin is. */
  kind: 'viewport' | 'full-page' | 'element';
  /** Device pixel ratio at capture time. */
  deviceScaleFactor: number;
  /** Image size in device pixels, as the screenshot came back. */
  image: { width: number; height: number };
  /** Scroll position when the shot was taken — required for viewport shots, ignored for full-page. */
  scroll: { x: number; y: number };
  /** For `element` shots: the element's box in CSS viewport pixels. */
  origin?: Rect;
}

export interface FrameOffset {
  frameId: string;
  /** Offset of the frame's CSS viewport origin inside the top frame's CSS viewport. */
  x: number;
  y: number;
}

/** The centre of a box, in whatever space the box was expressed in. */
export function centreOf(rect: Rect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

export function areaOfRect(rect: Rect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

/** Does the box hold the point? Edges count, because a 1-pixel target should still be hittable. */
export function containsPoint(rect: Rect, point: { x: number; y: number }): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}

export function viewportToPage(rect: Rect, scroll: { x: number; y: number }): Rect {
  return { x: rect.x + scroll.x, y: rect.y + scroll.y, width: rect.width, height: rect.height };
}

export function pageToViewport(rect: Rect, scroll: { x: number; y: number }): Rect {
  return { x: rect.x - scroll.x, y: rect.y - scroll.y, width: rect.width, height: rect.height };
}

/** CSS → device pixels. Rounded outward so a sub-pixel edge is never cropped out of the image. */
export function cssToDevice(rect: Rect, dpr: number): Rect {
  const f = dpr || 1;
  const x = Math.floor(rect.x * f);
  const y = Math.floor(rect.y * f);
  const right = Math.ceil((rect.x + rect.width) * f);
  const bottom = Math.ceil((rect.y + rect.height) * f);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

export function deviceToCss(rect: Rect, dpr: number): Rect {
  const f = dpr || 1;
  return { x: rect.x / f, y: rect.y / f, width: rect.width / f, height: rect.height / f };
}

/**
 * Where does a CSS viewport box land inside a screenshot?
 *
 * The three capture kinds have three different origins, which is the whole reason this function exists:
 * a viewport shot starts at the current scroll position, a full-page shot starts at the document, and an
 * element shot starts at the element.
 */
export function boxInScreenshot(rect: Rect, shot: ScreenshotGeometry): Rect {
  const inCss =
    shot.kind === 'full-page'
      ? { ...viewportToPage(rect, shot.scroll) }
      : shot.kind === 'element' && shot.origin
        ? { x: rect.x - shot.origin.x, y: rect.y - shot.origin.y, width: rect.width, height: rect.height }
        : { ...rect };
  const device = cssToDevice(inCss, shot.deviceScaleFactor);
  if (shot.kind !== 'element') return device;
  return { ...device, x: Math.max(0, device.x), y: Math.max(0, device.y) };
}

/** The point that should be clicked, in the space CDP and Playwright input expect. */
export function clickPoint(rect: Rect, frameId = 'main'): PointIn {
  const c = centreOf(rect);
  return { x: c.x, y: c.y, space: 'css-viewport', frameId };
}

/**
 * Is a stored point still where it claims to be?
 *
 * A click at coordinates is a claim about the present, not about the snapshot it came from. Between the
 * two, an overlay can appear, an accordion can close, a sticky header can slide over the target. This
 * re-checks the claim against the newest snapshot before anyone acts on it.
 */
export interface PointVerdict {
  ok: boolean;
  /** The element the point now belongs to, if the snapshot has one. */
  at?: { identity: string; role: string; name: string; tag: string };
  /** Deepest-first list of every box under the point, so the reader sees the stack. */
  stack: Array<{ identity: string; role: string; name: string; tag: string; depth: number }>;
  reason: string;
}

export function whatIsAt(snapshot: Snapshot, point: { x: number; y: number }, frameId = 'main'): PointVerdict {
  const hits = snapshot.nodes
    .filter((n) => n.frameId === frameId && containsPoint(n.rect, point))
    .sort((a, b) => b.depth - a.depth || areaOfRect(a.rect) - areaOfRect(b.rect));
  const stack = hits.map((n) => ({ identity: n.identity, role: n.role, name: n.name, tag: n.tag, depth: n.depth }));
  const top = hits[0];
  if (!top) {
    return {
      ok: false,
      stack,
      reason: `nothing in the latest snapshot covers ${point.x},${point.y} — the box moved or the element is gone`,
    };
  }
  const covered = hits.find((n) => n.obstructed);
  if (covered) {
    return {
      ok: false,
      at: { identity: covered.identity, role: covered.role, name: covered.name, tag: covered.tag },
      stack,
      reason: `${covered.role || covered.tag} "${covered.name}" is under something else at this point`,
    };
  }
  return {
    ok: top.interactable,
    at: { identity: top.identity, role: top.role, name: top.name, tag: top.tag },
    stack,
    reason: top.interactable
      ? `topmost element at the point is ${top.role || top.tag} "${top.name}"`
      : `the point lands on ${top.role || top.tag} "${top.name}", which is not interactable${top.conflicts.length ? `: ${top.conflicts.join('; ')}` : ''}`,
  };
}

/**
 * Does the point still belong to the element it was taken from?
 *
 * The failure this prevents is the expensive kind: coordinates computed against snapshot v3 used after
 * the page scrolled or a menu opened, clicking a neighbour that has since slid into place. Identity is
 * re-checked too, because a point over the same *place* is not a point at the same *thing*.
 */
export function revalidatePoint(
  snapshot: Snapshot,
  expected: { identity: string; rect: Rect; frameId?: string; point?: { x: number; y: number } },
): PointVerdict & { identityMatches: boolean; drift: { x: number; y: number } } {
  const frameId = expected.frameId ?? 'main';
  const point = expected.point ?? centreOf(expected.rect);
  const verdict = whatIsAt(snapshot, point, frameId);
  const still = snapshot.nodes.find((n) => n.identity === expected.identity);
  if (!still) {
    return { ...verdict, ok: false, identityMatches: false, drift: { x: 0, y: 0 } };
  }
  const identityMatches = !!verdict.at && verdict.at.identity === still.identity;
  const dx = still.rect.x - expected.rect.x;
  const dy = still.rect.y - expected.rect.y;
  if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
    return {
      ...verdict,
      ok: identityMatches && verdict.ok,
      identityMatches,
      drift: { x: dx, y: dy },
      reason: `the box moved by ${Math.round(dx)},${Math.round(dy)} px; ${verdict.reason}`,
    };
  }
  return { ...verdict, identityMatches, drift: { x: 0, y: 0 } };
}

/**
 * Put a frame's coordinates into the top frame.
 *
 * The collector reports every node in its own frame's viewport space — that is what `getBoundingClientRect`
 * gives. Without the frame's offset a point inside an iframe is silently a point in the parent. When the
 * offset has not been measured, callers get `null` and must go measure it rather than assume zero.
 */
export function toTopFrame(rect: Rect, offsets: FrameOffset[], frameId: string): Rect | null {
  if (frameId === 'main') return rect;
  const off = offsets.find((o) => o.frameId === frameId);
  if (!off) return null;
  return { x: rect.x + off.x, y: rect.y + off.y, width: rect.width, height: rect.height };
}

export interface AnnotationLabel {
  identity: string;
  text: string;
  rect: Rect;
  /** Index shown in the image; matches the number in the outline the model was given. */
  index: number;
}

/**
 * An SVG overlay that puts the outline's numbers on a screenshot.
 *
 * Returned as markup rather than pixels because the caller owns the image: this way the same overlay works
 * on a viewport shot, a full-page shot and a decoded canvas, and it stays testable without a decoder. The
 * label is flipped above the box when there is no room below it, and a box thinner than a label gets the
 * label drawn beside it instead of inside it.
 */
export function annotationOverlay(
  labels: AnnotationLabel[],
  image: { width: number; height: number },
  dpr = 1,
): string {
  const font = Math.max(11, Math.round(12 / (dpr || 1)));
  const stroke = Math.max(1, Math.round(2 / (dpr || 1)));
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${image.width}" height="${image.height}" viewBox="0 0 ${image.width} ${image.height}">`,
    `<style>text{font:600 ${font}px ui-monospace,monospace;paint-order:stroke;stroke:#000;stroke-width:${font * 0.35}px;fill:#fff}.box{fill:none;stroke:#00e5ff;stroke-width:${stroke}}</style>`,
  ];
  for (const label of labels) {
    const box = {
      x: Math.round(label.rect.x * (dpr || 1)),
      y: Math.round(label.rect.y * (dpr || 1)),
      w: Math.max(1, Math.round(label.rect.width * (dpr || 1))),
      h: Math.max(1, Math.round(label.rect.height * (dpr || 1))),
    };
    const tag = `${label.index}`;
    const textW = Math.round((tag.length + 1) * font * 0.62);
    const below = box.y + box.h + font + stroke;
    // Prefer below the box; flip above when there is no room; clamp either way, because a label that
    // falls off the image annotates nothing. The box itself is *not* clamped — it must stay where the
    // element is, even when the element hangs out of the capture.
    const labelY = Math.round(
      Math.min(Math.max(below <= image.height ? below : box.y - font / 2, font), image.height - 2),
    );
    const labelX = Math.min(Math.max(0, box.x), Math.max(0, image.width - textW));
    parts.push(`<rect class="box" x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}"/>`);
    parts.push(`<text x="${labelX + 2}" y="${labelY}">${tag} ${escapeXml(label.text).slice(0, 48)}</text>`);
  }
  parts.push('</svg>');
  return parts.join('');
}

function escapeXml(s: string): string {
  return s.replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c] ?? c,
  );
}
