/**
 * Perception: merging what a browser reports into one record a model can act on.
 *
 * The brief forbids DOM-only or screenshot-only, and the survey shows why. browser-use indexes
 * elements by the raw CDP `backendNodeId` and re-validates nothing before a click, so a node the page
 * recycled resolves to a different element and the automation presses the wrong thing with total
 * confidence. So this layer does three things: merge the signals keeping each one's provenance,
 * identify a node by a structural fingerprint rather than a reused number, and *keep the
 * disagreement* — when the DOM says visible and the accessibility tree says hidden, the answer is a
 * reported conflict, not a silent pick.
 *
 * Pure module: no browser, no Playwright, no I/O. The collector lives in `browser-use-collector.ts`.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SourceObservation<T = unknown> {
  source: 'dom' | 'accessibility' | 'style' | 'geometry' | 'hit-test';
  value: T;
  /** ms since epoch when this signal was gathered. */
  at: number;
  /** A node inside an iframe is not the same thing as its host. */
  frameId: string;
  /** Ranking hint 0..1 — not a probability and never presented as one. */
  confidence: number;
}

/** Raw node as the collector reports it, before merging. */
export interface RawNode {
  backendId: string;
  /**
   * A token bound to the lifetime of this DOM node, not to its position or its tag.
   * Two elements that look identical get different tokens; the same element re-rendered keeps
   * its own. Without this, identity is only "looks the same", which is not the same claim.
   */
  token: string;
  frameId: string;
  /** Structural path from the document root, e.g. `html>body>main>button[1]`. */
  path: string;
  tag: string;
  role?: string;
  name?: string;
  text?: string;
  value?: string;
  placeholder?: string;
  href?: string;
  ariaHidden?: boolean;
  disabled?: boolean;
  checked?: boolean;
  selected?: boolean;
  expanded?: boolean;
  rect: Rect;
  inViewport: boolean;
  /** `display:none` / `visibility:hidden` / zero area, per computed style. */
  styleVisible: boolean;
  /** What `elementFromPoint` at the box centre returned. */
  hitTestSelf: boolean;
  obstructed: boolean;
  scrollable?: boolean;
  depth: number;
  interactive: boolean;
  /** Shadow DOM and iframe boundaries the node sits behind. */
  boundaries: string[];
}

export interface PerceivedNode {
  id: string;
  identity: string;
  backendId: string;
  token: string;
  frameId: string;
  path: string;
  tag: string;
  role: string;
  name: string;
  text: string;
  placeholder: string;
  href: string;
  rect: Rect;
  inViewport: boolean;
  visible: boolean;
  interactable: boolean;
  obstructed: boolean;
  state: Record<string, boolean>;
  depth: number;
  interactive: boolean;
  boundaries: string[];
  observations: SourceObservation[];
  conflicts: string[];
  snapshotId: string;
  capturedAt: number;
}

export interface Snapshot {
  id: string;
  url: string;
  title: string;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  scroll: { x: number; y: number };
  capturedAt: number;
  nodes: PerceivedNode[];
  /** Nodes dropped by the budget, counted so "the whole page" is never implied. */
  truncated: number;
  budget: number;
}

export interface BuildOptions {
  snapshotId: string;
  url: string;
  title: string;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  scroll: { x: number; y: number };
  capturedAt: number;
  budget?: number;
}

const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'details', 'summary']);

/** FNV-1a 32-bit: cheap, stable across runs, and not used for anything security-sensitive. */
export function hash32(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * A structural fingerprint: what the element *is in the document*, never a browser-assigned number.
 * That is the difference between "the node the page points at now" and "the node the model was shown".
 */
export function identityOf(node: RawNode): string {
  return hash32(
    [
      node.frameId,
      node.path,
      node.tag.toLowerCase(),
      node.token,
      node.role ?? '',
      (node.name ?? '').slice(0, 120),
      (node.text ?? '').slice(0, 120),
    ].join('|'),
  );
}

export function areaOf(rect: Rect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

export function sameBox(a: Rect, b: Rect, tolerancePx = 1): boolean {
  return (
    Math.abs(a.x - b.x) <= tolerancePx &&
    Math.abs(a.y - b.y) <= tolerancePx &&
    Math.abs(a.width - b.width) <= tolerancePx &&
    Math.abs(a.height - b.height) <= tolerancePx
  );
}
/**
 * Visibility is where the sources disagree most often, so the disagreement is kept rather than
 * resolved: `aria-hidden` on an element with a real box, or a box the hit-test says is covered, are
 * both facts a caller needs. `visible` is the conservative answer — true only when style, geometry and
 * the accessibility tree all allow it — and every reason not to trust it is listed in `conflicts`.
 */
export function mergeVisibility(node: RawNode): { visible: boolean; conflicts: string[]; interactable: boolean } {
  const conflicts: string[] = [];
  const hasArea = areaOf(node.rect) > 0;
  if (!node.styleVisible && hasArea) conflicts.push('style says hidden but the layout box has area');
  if (node.styleVisible && !hasArea) conflicts.push('style says visible but the layout box is empty');
  if (node.ariaHidden && hasArea && node.styleVisible) conflicts.push('aria-hidden on an element that occupies space');
  if (!node.hitTestSelf && hasArea && node.styleVisible)
    conflicts.push('hit-test at the centre returns a different element');

  const visible = node.styleVisible && hasArea && !node.ariaHidden;
  const interactable =
    visible &&
    node.inViewport &&
    node.hitTestSelf &&
    !node.obstructed &&
    !node.disabled &&
    (node.interactive || INTERACTIVE_TAGS.has(node.tag.toLowerCase()));
  return { visible, conflicts, interactable };
}

export function perceiveNode(node: RawNode, options: BuildOptions): PerceivedNode {
  const { visible, conflicts, interactable } = mergeVisibility(node);
  const state: Record<string, boolean> = {};
  for (const key of ['disabled', 'checked', 'selected', 'expanded', 'scrollable'] as const) {
    if (typeof node[key] === 'boolean') state[key] = node[key] as boolean;
  }
  return {
    id: `${options.snapshotId}:${node.backendId}`,
    identity: identityOf(node),
    backendId: node.backendId,
    token: node.token,
    frameId: node.frameId,
    path: node.path,
    tag: node.tag.toLowerCase(),
    role: node.role ?? '',
    name: node.name ?? '',
    text: (node.text ?? '').replace(/\s+/g, ' ').trim(),
    rect: node.rect,
    placeholder: node.placeholder ?? '',
    href: node.href ?? '',
    inViewport: node.inViewport,
    visible,
    interactable,
    obstructed: node.obstructed,
    state,
    depth: node.depth,
    interactive: node.interactive,
    boundaries: node.boundaries,
    observations: [
      {
        source: 'dom',
        value: { tag: node.tag, path: node.path },
        at: options.capturedAt,
        frameId: node.frameId,
        confidence: 0.9,
      },
      {
        source: 'accessibility',
        value: { role: node.role, name: node.name, ariaHidden: node.ariaHidden },
        at: options.capturedAt,
        frameId: node.frameId,
        confidence: 0.8,
      },
      {
        source: 'style',
        value: { visible: node.styleVisible },
        at: options.capturedAt,
        frameId: node.frameId,
        confidence: 0.85,
      },
      { source: 'geometry', value: node.rect, at: options.capturedAt, frameId: node.frameId, confidence: 0.95 },
      {
        source: 'hit-test',
        value: { self: node.hitTestSelf, obstructed: node.obstructed },
        at: options.capturedAt,
        frameId: node.frameId,
        confidence: 0.9,
      },
    ],
    conflicts,
    snapshotId: options.snapshotId,
    capturedAt: options.capturedAt,
  };
}
export function buildSnapshot(raw: RawNode[], options: BuildOptions): Snapshot {
  const budget = options.budget ?? 400;
  const nodes = raw.map((node) => perceiveNode(node, options));
  // Order matters as much as the count: the outline is cut at the budget, so the most useful nodes go
  // first — interactable, then visible, then in document order.
  const ranked = [...nodes].sort((a, b) => {
    if (a.interactable !== b.interactable) return a.interactable ? -1 : 1;
    if (a.visible !== b.visible) return a.visible ? -1 : 1;
    return a.depth - b.depth || a.path.localeCompare(b.path);
  });
  return {
    id: options.snapshotId,
    url: options.url,
    title: options.title,
    viewport: options.viewport,
    deviceScaleFactor: options.deviceScaleFactor,
    scroll: options.scroll,
    capturedAt: options.capturedAt,
    nodes: ranked.slice(0, budget),
    truncated: Math.max(0, ranked.length - budget),
    budget,
  };
}

/**
 * One line of the model-facing outline.
 *
 * Shape follows the lesson from the survey: an index the model can quote, the role and name the
 * accessibility tree reports, and the tag — in that order, because that is the order a model uses to
 * decide. Bounds are included because coordinate work without them means a second round trip.
 */
export function outlineLine(node: PerceivedNode): string {
  const bits = [node.role || node.tag];
  if (node.name) bits.push(`"${node.name.slice(0, 80)}"`);
  else if (node.text) bits.push(`"${node.text.slice(0, 60)}"`);
  if (node.placeholder) bits.push(`ph="${node.placeholder.slice(0, 40)}"`);
  const flags: string[] = [];
  if (node.tag === 'a' && node.href === undefined && node.state) flags.push('link');
  for (const [k, v] of Object.entries(node.state)) if (v) flags.push(k);
  if (node.obstructed) flags.push('obstructed');
  if (node.conflicts.length) flags.push('conflicted');
  const box = `${Math.round(node.rect.x)},${Math.round(node.rect.y)} ${Math.round(node.rect.width)}x${Math.round(node.rect.height)}`;
  return `[${node.identity}] ${bits.join(' ')}${flags.length ? ` (${flags.join(',')})` : ''} @${box}`;
}

export interface OutlineOptions {
  /** Include nodes that cannot be acted on. Off by default: the outline is an action surface. */
  includeNonInteractable?: boolean;
  /** Hard character ceiling. Truncation is reported in the returned metadata, never silent. */
  maxChars?: number;
}

export interface Outline {
  text: string;
  lines: number;
  omitted: number;
  truncated: boolean;
}

/** Serialize a snapshot for a model, within an exact character budget. */
export function serializeOutline(snapshot: Snapshot, options: OutlineOptions = {}): Outline {
  const maxChars = options.maxChars ?? 12_000;
  const pool = snapshot.nodes.filter((n) => (options.includeNonInteractable ? true : n.interactable));
  const out: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const node of pool) {
    const line = outlineLine(node);
    if (used + line.length + 1 > maxChars) {
      omitted++;
      continue;
    }
    used += line.length + 1;
    out.push(line);
  }
  const header = `# ${snapshot.title} — ${snapshot.url}\n# viewport ${snapshot.viewport.width}x${snapshot.viewport.height} dpr ${snapshot.deviceScaleFactor} scroll ${snapshot.scroll.x},${snapshot.scroll.y}\n`;
  const body = out.join('\n');
  const tail =
    omitted > 0
      ? `\n# ${omitted} more element(s) omitted by the ${maxChars} character budget; re-run with a larger budget or query a region`
      : '';
  return { text: header + body + tail, lines: out.length, omitted, truncated: omitted > 0 };
}
export interface NodeDiff {
  added: PerceivedNode[];
  removed: PerceivedNode[];
  moved: Array<{ identity: string; from: Rect; to: Rect }>;
  changed: Array<{ identity: string; fields: string[] }>;
}

/**
 * What changed between two snapshots, keyed by identity rather than by position or backend id.
 *
 * This is the incremental update path the brief asks for: a small DOM mutation should not require a
 * full re-read to answer "what moved", and an action layer that re-resolves by identity gets a real
 * answer instead of trusting an index that may now point somewhere else.
 */
export function diffSnapshots(before: Snapshot, after: Snapshot): NodeDiff {
  const b = new Map(before.nodes.map((n) => [n.identity, n]));
  const a = new Map(after.nodes.map((n) => [n.identity, n]));
  const diff: NodeDiff = { added: [], removed: [], moved: [], changed: [] };
  for (const [identity, node] of a) if (!b.has(identity)) diff.added.push(node);
  for (const [identity, node] of b) if (!a.has(identity)) diff.removed.push(node);
  for (const [identity, now] of a) {
    const was = b.get(identity);
    if (!was) continue;
    if (!sameBox(was.rect, now.rect)) diff.moved.push({ identity, from: was.rect, to: now.rect });
    const fields: string[] = [];
    if (was.name !== now.name) fields.push('name');
    if (was.text !== now.text) fields.push('text');
    if (was.visible !== now.visible) fields.push('visible');
    if (was.interactable !== now.interactable) fields.push('interactable');
    if (JSON.stringify(was.state) !== JSON.stringify(now.state)) fields.push('state');
    if (fields.length) diff.changed.push({ identity, fields });
  }
  return diff;
}

export type Staleness =
  | 'FRESH'
  | 'MOVED'
  | 'CHANGED'
  | 'GONE' /** Same identity, different backend id: the page replaced the element. */
  | 'REPLACED' /** Found by backend id but under a different identity — the id was recycled. */
  | 'ID_RECYCLED';

export interface TargetResolution {
  ok: boolean;
  node?: PerceivedNode;
  staleness: Staleness;
  /** Why, in a sentence a host can act on. Never "not found". */
  detail: string;
}

/**
 * Resolve a target the model was shown against the current snapshot.
 *
 * The failure this exists to prevent is the one found in browser-use: an index is looked up in a fresh
 * map and clicked without checking that it is the same element. Here an identity that no longer exists
 * is `GONE`, an identity that exists under a new backend id is `REPLACED`, and a backend id that now
 * belongs to a different identity is `ID_RECYCLED` — the last of which is a hard stop, not a warning.
 */
export function resolveTarget(
  expected: { identity: string; backendId: string; token?: string; rect?: Rect },
  current: Snapshot,
): TargetResolution {
  const byIdentity = current.nodes.find((n) => n.identity === expected.identity);
  if (byIdentity) {
    if ((expected.token && byIdentity.token !== expected.token) || byIdentity.backendId !== expected.backendId) {
      return {
        ok: false,
        node: byIdentity,
        staleness: 'REPLACED',
        detail: `the element is still in the document but the browser handed out a new node id; re-confirm before acting`,
      };
    }
    if (expected.rect && !sameBox(expected.rect, byIdentity.rect)) {
      return {
        ok: true,
        node: byIdentity,
        staleness: 'MOVED',
        detail: `element moved from ${expected.rect.x},${expected.rect.y} to ${byIdentity.rect.x},${byIdentity.rect.y}; use the new box`,
      };
    }
    if (!byIdentity.interactable) {
      return {
        ok: false,
        node: byIdentity,
        staleness: 'CHANGED',
        detail: byIdentity.conflicts.length
          ? `element is no longer interactable: ${byIdentity.conflicts.join('; ')}`
          : 'element is no longer interactable',
      };
    }
    return { ok: true, node: byIdentity, staleness: 'FRESH', detail: 'identity, node id and box all match' };
  }

  const byBackend = current.nodes.find((n) => n.backendId === expected.backendId);
  if (byBackend) {
    return {
      ok: false,
      node: byBackend,
      staleness: 'ID_RECYCLED',
      detail: `node id ${expected.backendId} now belongs to "${byBackend.role || byBackend.tag}" — the original element is gone and clicking this id would hit something else`,
    };
  }
  return { ok: false, staleness: 'GONE', detail: 'the element is no longer in the document' };
}
