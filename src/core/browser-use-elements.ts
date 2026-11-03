/**
 * Element listing: the read as a table of boxes, instead of as an action surface.
 *
 * The outline answers "what can I do here", so it drops everything uninteractable and stops at a character
 * budget. That is the right shape for choosing a target and the wrong shape for "give me the coordinates of
 * every element on this site", which is a question about geometry, not about agency. Splitting the two is
 * what keeps the outline small: a tool that lists all 1400 boxes must not be the tool that a model reads
 * before every click.
 *
 * What every row carries: the box in a named coordinate space, the centre (the point a click at that box
 * would use), the identity/token/node-id triple the action layer needs, and whether the element actually
 * owns its own centre — the difference, measured by hit-test, between "there is a box here" and "a click
 * here arrives at this element". A row without that last column is a row that invites clicking a covered
 * button and trusting the result.
 */

import type { PerceivedNode, Rect, Snapshot } from './browser-use-perception.js';
import { cssToDevice, viewportToPage, centreOf, areaOfRect } from './browser-use-coordinates.js';

/**
 * A box is only a number until someone says where its zero is. Four spaces, each named after the thing the
 * caller is holding: the DOM read, the document, a viewport screenshot's pixels, a full-page screenshot's.
 */
export type ElementSpace = 'css-viewport' | 'css-page' | 'image-viewport-device' | 'image-page-device';

export type ElementFilter =
  | 'all'
  /** Anything the read says occupies space. */
  | 'visible'
  /** Clickable right now: in the viewport, unobstructed, enabled, and a control. */
  | 'interactable'
  /** A control by tag/role/attribute, whether or not it can be reached now. */
  | 'interactive'
  /** Carries visible words — the rows a text-oriented reader wants. */
  | 'text';

export interface ElementOptions {
  filter?: ElementFilter;
  tag?: string;
  role?: string;
  nameIncludes?: string;
  frameId?: string;
  /** Only boxes overlapping this rect, in the same space as the snapshot. */
  region?: Rect;
  /** Keep only elements at least this deep in the tree. */
  minDepth?: number;
  maxDepth?: number;
  /** Smallest area, in CSS px². A 1x1 spacer is geometry noise. */
  minArea?: number;
}

/** Does a click at this element's own centre reach it? Read from the hit-test observation. */
export function ownsCentre(node: PerceivedNode): boolean {
  const hit = node.observations.find((o) => o.source === 'hit-test');
  if (!hit) return false;
  const value = hit.value as { self?: boolean };
  return value.self === true;
}

/** Does this element own any of the text, or is all of it inside children? */
export function hasOwnText(node: PerceivedNode): boolean {
  return node.text.trim().length > 0;
}

/**
 * The deepest depth at which each exact string appears.
 *
 * `textContent` is subtree text, so a `<p>`, the `<div>` around it and the `<article>` above it all report
 * the same sentence. Treating that as three text-bearing elements would make a text listing mostly
 * containers. The owner of a string is the deepest element holding it — which is, in practice, the element a
 * reader would point at.
 */
export function deepestTextDepths(nodes: PerceivedNode[]): Map<string, number> {
  const depths = new Map<string, number>();
  for (const node of nodes) {
    const text = node.text.trim();
    if (!text) continue;
    const best = depths.get(text);
    if (best === undefined || node.depth > best) depths.set(text, node.depth);
  }
  return depths;
}

/** Is this node the element that actually holds its own string? */
export function ownsItsText(node: PerceivedNode, depths: Map<string, number>): boolean {
  const text = node.text.trim();
  if (!text) return false;
  return depths.get(text) === node.depth;
}

/**
 * Which nodes survive a filter, in the order the caller will be given them.
 *
 * Order is document-ish order by depth then path, not the snapshot's action ranking: a listing that answers
 * "what is at y=900" has to be walkable by position, and the interactable-first ordering is meaningless once
 * uninteractable rows are included.
 */
export function selectNodes(snapshot: Snapshot, options: ElementOptions = {}): PerceivedNode[] {
  const filter = options.filter ?? 'visible';
  const tag = options.tag?.toLowerCase();
  const role = options.role?.toLowerCase();
  const needle = options.nameIncludes?.toLowerCase();
  const depths = deepestTextDepths(snapshot.nodes);
  const inSpace = (node: PerceivedNode): boolean => {
    switch (filter) {
      case 'all':
        return true;
      case 'visible':
        return node.visible;
      case 'interactable':
        return node.interactable;
      case 'interactive':
        return node.interactive;
      case 'text':
        return node.visible && ownsItsText(node, depths);
      default:
        return true;
    }
  };
  let pool = snapshot.nodes.filter(inSpace);
  if (options.frameId) pool = pool.filter((n) => n.frameId === options.frameId);
  if (tag) pool = pool.filter((n) => n.tag === tag);
  if (role) pool = pool.filter((n) => (n.role || '').toLowerCase() === role);
  if (needle)
    pool = pool.filter(
      (n) =>
        n.name.toLowerCase().includes(needle) ||
        n.text.toLowerCase().includes(needle) ||
        n.value.toLowerCase().includes(needle),
    );
  if (typeof options.minDepth === 'number') pool = pool.filter((n) => n.depth >= options.minDepth!);
  if (typeof options.maxDepth === 'number') pool = pool.filter((n) => n.depth <= options.maxDepth!);
  if (typeof options.minArea === 'number') pool = pool.filter((n) => areaOfRect(n.rect) >= options.minArea!);
  if (options.region) {
    const r = options.region;
    pool = pool.filter(
      (n) =>
        n.rect.x < r.x + r.width &&
        r.x < n.rect.x + n.rect.width &&
        n.rect.y < r.y + r.height &&
        r.y < n.rect.y + n.rect.height,
    );
  }
  return [...pool].sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
}

export interface ElementRow {
  /** Position in this listing — the number an annotation draws. Not stable across reads. */
  index: number;
  identity: string;
  token: string;
  backend_id: string;
  tag: string;
  role: string;
  name: string;
  text: string;
  value: string;
  frame_id: string;
  path: string;
  depth: number;
  rect: Rect;
  centre: { x: number; y: number };
  space: ElementSpace;
  in_viewport: boolean;
  visible: boolean;
  interactable: boolean;
  owns_centre: boolean;
  obstructed: boolean;
  state: Record<string, boolean>;
  conflicts: string[];
}

/**
 * Put a box into the space the caller asked for.
 *
 * The snapshot holds CSS viewport pixels. `css-page` adds the scroll the read was taken at. The two image
 * spaces then multiply by the device pixel ratio, and differ only in where their zero is: a viewport shot's
 * first pixel is the current scroll position, a full-page shot's is the top of the document. Doing this here
 * rather than in the caller is the point — a list that mixes two origins and says nothing is a list of wrong
 * numbers for one of them.
 */
export function placeRect(rect: Rect, space: ElementSpace, snapshot: Snapshot): Rect {
  if (space === 'css-page') return viewportToPage(rect, snapshot.scroll);
  if (space === 'image-page-device')
    return cssToDevice(viewportToPage(rect, snapshot.scroll), snapshot.deviceScaleFactor);
  if (space === 'image-viewport-device') return cssToDevice(rect, snapshot.deviceScaleFactor);
  return rect;
}

export interface RowBuildOptions {
  space?: ElementSpace;
  /** Words the read found inside this element, keyed by the collector's node id. */
  wordCounts?: Map<string, number>;
}

export function elementRows(nodes: PerceivedNode[], snapshot: Snapshot, options: RowBuildOptions = {}): ElementRow[] {
  const space = options.space ?? 'css-viewport';
  return nodes.map((node, index) => {
    const rect = placeRect(node.rect, space, snapshot);
    const centre = centreOf(rect);
    return {
      index: index + 1,
      identity: node.identity,
      token: node.token,
      backend_id: node.backendId,
      tag: node.tag,
      role: node.role,
      name: node.name,
      text: node.text,
      value: node.value,
      frame_id: node.frameId,
      path: node.path,
      depth: node.depth,
      rect,
      centre,
      space,
      in_viewport: node.inViewport,
      visible: node.visible,
      interactable: node.interactable,
      owns_centre: ownsCentre(node),
      obstructed: node.obstructed,
      state: node.state,
      conflicts: node.conflicts,
    };
  });
}

export interface RowStats {
  matched: number;
  space: ElementSpace;
  filter: ElementFilter;
  /** How many of the returned rows a click at their own centre would actually reach. */
  clickable: number;
  covered: number;
  off_viewport: number;
  by_tag: Array<{ tag: string; count: number }>;
}

export function summarizeRows(rows: ElementRow[], filter: ElementFilter): RowStats {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.tag, (counts.get(row.tag) ?? 0) + 1);
  return {
    matched: rows.length,
    space: rows[0]?.space ?? 'css-viewport',
    filter,
    clickable: rows.filter((r) => r.interactable).length,
    covered: rows.filter((r) => r.obstructed).length,
    off_viewport: rows.filter((r) => !r.in_viewport).length,
    by_tag: [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12),
  };
}

/** One compact line for a listing a human reads. */
export function elementLine(row: ElementRow): string {
  const label = row.name || row.text || row.role || row.tag;
  const flags: string[] = [];
  if (!row.in_viewport) flags.push('off-screen');
  if (row.obstructed) flags.push('covered');
  if (!row.owns_centre) flags.push('no-centre');
  if (!row.visible) flags.push('hidden');
  return (
    `#${row.index} ${row.tag}${row.role ? '[' + row.role + ']' : ''} "${label.slice(0, 48)}" ` +
    `${Math.round(row.rect.x)},${Math.round(row.rect.y)} ${Math.round(row.rect.width)}x${Math.round(row.rect.height)} ` +
    `c=${Math.round(row.centre.x)},${Math.round(row.centre.y)}${flags.length ? ' (' + flags.join(',') + ')' : ''}`
  );
}
