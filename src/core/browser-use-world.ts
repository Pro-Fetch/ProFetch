/**
 * The world model: what this engine believes about one tab, and how that belief changes.
 *
 * A snapshot is a photograph; a model is a memory. The difference matters in exactly two places, and
 * both are where browser automation usually breaks:
 *
 * 1. **Between snapshots.** An agent acts, the page changes, and the question is what changed — not
 *    what the new DOM looks like from scratch. `applySnapshot` answers that with an identity-keyed
 *    delta, so "Add to cart" becoming "In cart" is a `changed` entry rather than an unseen mutation.
 * 2. **Across documents.** A page that navigated is a different world. Every identity from the
 *    previous document must stop resolving, even if the new document contains an element with the same
 *    tag, name, role and position — a backend node id would happily resolve there. That is why the
 *    document signature is part of the model rather than an afterthought in the caller.
 *
 * Nothing in this file talks to a browser. It is pure data in, data out, which is what makes the two
 * rules above testable without a machine that has Chrome on it.
 */

import type { NodeDiff, PerceivedNode, Snapshot, Staleness } from './browser-use-perception.js';
import { diffSnapshots, hash32, resolveTarget } from './browser-use-perception.js';
import type { PageObject } from './browser-use-objects.js';
import { groupObjects } from './browser-use-objects.js';

/** What kind of change the latest snapshot represents. */
export type TransitionKind = 'INITIAL' | 'MUTATED' | 'SCROLLED' | 'RESIZED' | 'FRAGMENT' | 'NAVIGATED';

export interface Transition {
  at: number;
  version: number;
  kind: TransitionKind;
  /** One line, human-readable, with the numbers that justify the classification. */
  summary: string;
}

/**
 * Coverage is a claim about what was *seen*. `truncated` in a snapshot is nodes the budget dropped;
 * a missing `contentHeight` means the page is taller than what was read and nobody knows by how much.
 * Both are reported instead of being smoothed into a reassuring 100%.
 */
export interface Coverage {
  /** Distinct identities the model has ever held for this document. */
  identitiesKnown: number;
  /** Identities present in the latest snapshot. */
  identitiesInLatest: number;
  /** Nodes the collector's budget dropped out of the latest snapshot. */
  omittedByBudget: number;
  /** Frames that produced at least one node, with their counts. */
  frames: Array<{ frameId: string; nodes: number; boundaries: string[] }>;
  /** Frames the host declared but no snapshot has ever produced nodes from. */
  framesUnobserved: string[];
  /** Scroll positions this model has seen, so "we only looked at the top" is visible. */
  scrollSeen: { minY: number; maxY: number; samples: number };
  /** Page height as reported by the host; `null` means the host never said. */
  contentHeight: number | null;
  /** Scrolled region over page height, when the height is known. Never a claim about node coverage. */
  viewportCoverage: number | null;
  /** Why coverage cannot be fuller, in plain words. Empty when nothing is missing. */
  gaps: string[];
}

export interface WorldModel {
  tabId: string;
  /** Monotonic per tab. A version is the only safe thing to hand a caller as a "same page" token. */
  version: number;
  url: string;
  /** Without the fragment: a hash change is not a new document. */
  documentUrl: string;
  title: string;
  /** Signature of the document, not of a node. Changes ⇒ every identity below is void. */
  documentSignature: string;
  openedAt: number;
  updatedAt: number;
  latest: Snapshot;
  /** Identity → the most recent node seen for it in this document. */
  nodes: Map<string, PerceivedNode>;
  objects: PageObject[];
  history: Array<{ version: number; snapshotId: string; at: number; nodes: number; truncated: number }>;
  transitions: Transition[];
  coverage: Coverage;
  /** What the most recent update changed. Kept on the model so a caller can ask after the fact. */
  delta: NodeDiff;
  /** Identities dropped because the model is bounded; a number, not a silent loss. */
  evicted: number;
  limits: { history: number; nodes: number; transitions: number };
}

export interface WorldInput {
  tabId: string;
  /** Page height, when the host knows it. Omit rather than guess — `null` is a reported gap. */
  contentHeight?: number | null;
  /** Frame ids the tab has, so an unobserved iframe becomes a visible hole instead of silence. */
  declaredFrames?: string[];
  now?: number;
  historyLimit?: number;
  nodeLimit?: number;
  transitionLimit?: number;
}

const DEFAULTS = { history: 12, nodes: 4000, transitions: 24 };

function withoutFragment(url: string): string {
  const i = url.indexOf('#');
  return i === -1 ? url : url.slice(0, i);
}

/**
 * A signature for the *document*: the URL without its fragment plus the root-level structure.
 *
 * Deliberately not the node count or any deep element — adding a row to a list is a mutation, not a new
 * page. A document rebuilt at the same URL (a reload, or a framework that remounted everything) is not
 * caught here either; it is caught in `classify`, where the observation that *no* identity survived the
 * update says what a signature cannot.
 */
export function documentSignatureOf(snapshot: Snapshot): string {
  const shallow = snapshot.nodes
    .filter((n) => n.depth <= 2)
    .map((n) => n.path)
    .sort()
    .slice(0, 64)
    .join(',');
  return hash32(`${withoutFragment(snapshot.url)}|${shallow}`);
}

function frameLedger(nodes: PerceivedNode[]): Coverage['frames'] {
  const byFrame = new Map<string, { nodes: number; boundaries: Set<string> }>();
  for (const n of nodes) {
    const entry = byFrame.get(n.frameId) ?? { nodes: 0, boundaries: new Set<string>() };
    entry.nodes += 1;
    for (const b of n.boundaries ?? []) entry.boundaries.add(b);
    byFrame.set(n.frameId, entry);
  }
  return [...byFrame.entries()]
    .map(([frameId, e]) => ({ frameId, nodes: e.nodes, boundaries: [...e.boundaries].sort() }))
    .sort((a, b) => b.nodes - a.nodes || a.frameId.localeCompare(b.frameId));
}

/**
 * Fold one more snapshot into the coverage numbers.
 *
 * `prior` is carried forward for the two things that accumulate across snapshots — how far the page has
 * been scrolled through, and a content height the host only reported once.
 */
function nextCoverage(
  latest: Snapshot,
  nodes: Map<string, PerceivedNode>,
  prior: Coverage | null,
  input: WorldInput,
): Coverage {
  const declared = new Set(input.declaredFrames ?? []);
  const frames = frameLedger(latest.nodes);
  const framesUnobserved = [...declared].filter(
    (f) => !frames.some((x) => x.frameId === f) && !prior?.frames.some((x) => x.frameId === f),
  );
  const scrollSeen = {
    minY: Math.min(prior?.scrollSeen.minY ?? latest.scroll.y, latest.scroll.y),
    maxY: Math.max(prior?.scrollSeen.maxY ?? latest.scroll.y, latest.scroll.y),
    samples: (prior?.scrollSeen.samples ?? 0) + 1,
  };
  const contentHeight = input.contentHeight ?? prior?.contentHeight ?? null;
  const viewH = latest.viewport.height || 1;
  const viewportCoverage = contentHeight
    ? Math.min(1, (scrollSeen.maxY - scrollSeen.minY + viewH) / contentHeight)
    : null;

  const gaps: string[] = [];
  if (latest.truncated > 0) gaps.push(`${latest.truncated} nodes left out of this snapshot by the budget`);
  if (contentHeight === null) gaps.push('page height unknown, so nothing above or below the read region is claimed');
  else if (viewportCoverage !== null && viewportCoverage < 1)
    gaps.push(`only ${Math.round(viewportCoverage * 100)}% of the page height has been scrolled through`);
  if (framesUnobserved.length)
    gaps.push(`${framesUnobserved.length} declared frame(s) produced no nodes: ${framesUnobserved.join(', ')}`);
  if (prior && prior.identitiesKnown > nodes.size && !framesUnobserved.length && !latest.truncated) {
    // Identities only ever leave the map when the model is capped or the document changed; say so,
    // rather than letting a shrinking number look like the page lost elements.
    gaps.push(
      `model holds ${nodes.size} identities after ${prior.identitiesKnown}; earlier ones were dropped by a document change or the ${input.nodeLimit ?? DEFAULTS.nodes}-identity cap`,
    );
  }

  return {
    identitiesKnown: nodes.size,
    identitiesInLatest: latest.nodes.length,
    omittedByBudget: latest.truncated,
    frames,
    framesUnobserved,
    scrollSeen,
    contentHeight,
    viewportCoverage,
    gaps,
  };
}

/** Classify what happened between the model and the incoming snapshot. */
function classify(model: WorldModel, next: Snapshot): { kind: TransitionKind; summary: string } {
  const nextSignature = documentSignatureOf(next);
  if (model.documentSignature !== nextSignature) {
    return {
      kind: 'NAVIGATED',
      summary: `document replaced (${model.documentSignature} → ${nextSignature}); ${model.nodes.size} identities from the previous document are void`,
    };
  }
  // Same URL, same root structure, nothing in common: the document was rebuilt under the same address —
  // a reload, or a framework that remounted the tree. Every lifetime token changed, so nothing the
  // caller holds can be the same element it was shown. This is an observation, not a guess.
  if (model.nodes.size > 0 && next.nodes.length > 0 && !next.nodes.some((n) => model.nodes.has(n.identity))) {
    return {
      kind: 'NAVIGATED',
      summary: `not one of ${model.nodes.size} identities survived at the same url — the document was replaced or reloaded, ${next.nodes.length} elements are all new`,
    };
  }
  const viewportChanged =
    model.latest.viewport.width !== next.viewport.width ||
    model.latest.viewport.height !== next.viewport.height ||
    model.latest.deviceScaleFactor !== next.deviceScaleFactor;
  if (viewportChanged) {
    return {
      kind: 'RESIZED',
      summary: `viewport ${model.latest.viewport.width}x${model.latest.viewport.height}@${model.latest.deviceScaleFactor} → ${next.viewport.width}x${next.viewport.height}@${next.deviceScaleFactor}`,
    };
  }
  if (model.latest.url !== next.url) {
    // The signature above already ignores fragments, so reaching here means a hash change: same document.
    return { kind: 'FRAGMENT', summary: `fragment changed to ${next.url.slice(next.url.indexOf('#'))}, same document` };
  }
  const scrolled = model.latest.scroll.y !== next.scroll.y || model.latest.scroll.x !== next.scroll.x;
  const diff = diffSnapshots(model.latest, next);
  const counts =
    `+${diff.added.length} -${diff.removed.length} ~${diff.changed.length} <>${diff.moved.length}` +
    (diff.relabelled.length ? ` ⟲${diff.relabelled.length}` : '');
  // A relabelled element keeps neither an added nor a removed entry — pairing moved it into its own
  // category. Leaving it out of this condition would make "Add to cart" becoming "In cart" a no-op.
  if (diff.added.length || diff.removed.length || diff.changed.length || diff.relabelled.length)
    return { kind: 'MUTATED', summary: `${counts}${scrolled ? ', also scrolled' : ''}` };
  if (scrolled) return { kind: 'SCROLLED', summary: `scrolled to ${next.scroll.x},${next.scroll.y}; ${counts}` };
  return { kind: 'MUTATED', summary: `nothing the identity diff can see changed; ${counts}` };
}

function pushBounded<T>(list: T[], item: T, limit: number): T[] {
  const next = [...list, item];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/** Keep the identity map inside its bound, counting what was dropped. Map order is insertion order. */
function trimNodes(nodes: Map<string, PerceivedNode>, limit: number): number {
  let evicted = 0;
  for (const key of nodes.keys()) {
    if (nodes.size <= limit) break;
    nodes.delete(key);
    evicted++;
  }
  return evicted;
}

/** The first belief about a tab. Every later belief is an update to this one. */
export function createWorldModel(snapshot: Snapshot, input: WorldInput): WorldModel {
  const now = input.now ?? snapshot.capturedAt;
  const nodes = new Map<string, PerceivedNode>(snapshot.nodes.map((n) => [n.identity, n]));
  const limits = {
    history: input.historyLimit ?? DEFAULTS.history,
    nodes: input.nodeLimit ?? DEFAULTS.nodes,
    transitions: input.transitionLimit ?? DEFAULTS.transitions,
  };
  return {
    tabId: input.tabId,
    version: 1,
    url: snapshot.url,
    documentUrl: withoutFragment(snapshot.url),
    title: snapshot.title,
    documentSignature: documentSignatureOf(snapshot),
    openedAt: now,
    updatedAt: now,
    latest: snapshot,
    nodes,
    objects: groupObjects(snapshot),
    history: [
      { version: 1, snapshotId: snapshot.id, at: now, nodes: snapshot.nodes.length, truncated: snapshot.truncated },
    ],
    transitions: [
      { at: now, version: 1, kind: 'INITIAL', summary: `${snapshot.nodes.length} nodes from ${snapshot.url}` },
    ],
    coverage: nextCoverage(snapshot, nodes, null, input),
    delta: { added: [], removed: [], moved: [], changed: [], relabelled: [] },
    evicted: 0,
    limits,
  };
}

export interface WorldUpdate {
  model: WorldModel;
  transition: Transition;
  delta: NodeDiff;
}

/**
 * Fold a snapshot into the model.
 *
 * The previous model is never mutated: a caller that is mid-action holds a reference to the world it
 * reasoned about, and silently changing that reference under it is how an action ends up aimed at an
 * element the model no longer believes exists.
 */
export function applySnapshot(model: WorldModel, snapshot: Snapshot, input: WorldInput): WorldUpdate {
  const now = input.now ?? snapshot.capturedAt;
  const { kind, summary } = classify(model, snapshot);
  const version = model.version + 1;

  let nodes: Map<string, PerceivedNode>;
  let delta: NodeDiff;
  if (kind === 'NAVIGATED') {
    // A new document: the old identities are not "missing", they came from somewhere else.
    nodes = new Map(snapshot.nodes.map((n) => [n.identity, n]));
    delta = { added: snapshot.nodes, removed: [...model.nodes.values()], moved: [], changed: [], relabelled: [] };
  } else {
    delta = diffSnapshots(model.latest, snapshot);
    nodes = new Map(model.nodes);
    // A re-labelled element has a new identity and the same DOM node. Keeping the old identity in the
    // map would let a stale reference resolve as "node id recycled" — true of the ids and misleading
    // about the page. Superseding it lets `resolveInModel` name the change and the new identity.
    // MUTATION PROBE PASSED: without this line the old identity answers ID_RECYCLED instead of CHANGED.
    for (const r of delta.relabelled) nodes.delete(r.from);
    for (const n of snapshot.nodes) nodes.set(n.identity, n);
  }

  let evicted = model.evicted;
  if (nodes.size > model.limits.nodes) {
    const dropped = trimNodes(nodes, model.limits.nodes);
    evicted += dropped;
    // The cap is a fact about the model, so it is reported inside the delta rather than only in a field
    // nobody reads: a caller comparing versions sees that something was lost.
    delta = {
      ...delta,
      changed: [
        ...delta.changed,
        {
          identity: '(model limit)',
          fields: [`${dropped} identities evicted at the ${model.limits.nodes}-identity cap`],
        },
      ],
    };
  }

  const transition: Transition = { at: now, version, kind, summary };
  const next: WorldModel = {
    ...model,
    version,
    url: snapshot.url,
    documentUrl: withoutFragment(snapshot.url),
    title: snapshot.title,
    documentSignature: documentSignatureOf(snapshot),
    updatedAt: now,
    latest: snapshot,
    nodes,
    objects: groupObjects(snapshot),
    history: pushBounded(
      model.history,
      { version, snapshotId: snapshot.id, at: now, nodes: snapshot.nodes.length, truncated: snapshot.truncated },
      model.limits.history,
    ),
    transitions: pushBounded(model.transitions, transition, model.limits.transitions),
    coverage: nextCoverage(snapshot, nodes, model.coverage, { ...input, contentHeight: input.contentHeight ?? null }),
    delta,
    evicted,
  };
  return { model: next, transition, delta };
}

export interface ModelTarget {
  identity: string;
  backendId: string;
  token?: string;
  rect?: PerceivedNode['rect'];
}

export interface ModelResolution {
  ok: boolean;
  node?: PerceivedNode;
  staleness: Staleness | 'NAVIGATED';
  /** Was this identity ever in the model? Distinguishes "wrong reference" from "old page". */
  remembered: boolean;
  detail: string;
  /** When the element is still there under a new identity (a label change), that identity. */
  replacement?: string;
}

/**
 * Resolve a target the caller was shown earlier against the current model.
 *
 * The answer `resolveTarget` cannot give is *why* something is missing. An identity the model never
 * held is a bad reference — the caller invented it or read it off another tab. An identity the model
 * held and lost when the tab navigated is a stale one, and only that second case deserves the words
 * "the page changed".
 */
export function resolveInModel(model: WorldModel, target: ModelTarget): ModelResolution {
  const held = model.nodes.get(target.identity);
  if (!held) {
    const relabelled = model.delta.relabelled.find((r) => r.from === target.identity);
    if (relabelled) {
      return {
        ok: false,
        node: relabelled.node,
        staleness: 'CHANGED',
        remembered: true,
        replacement: relabelled.to,
        detail: `the element is still there and says "${relabelled.toLabel}" instead of "${relabelled.fromLabel}" (${relabelled.fields.join(', ')} changed); confirm the new words before acting`,
      };
    }
    const navigated = model.transitions.some((t) => t.kind === 'NAVIGATED');
    if (navigated) {
      return {
        ok: false,
        staleness: 'NAVIGATED',
        remembered: true,
        detail: `this tab navigated (v${model.transitions
          .filter((t) => t.kind === 'NAVIGATED')
          .map((t) => t.version)
          .join(', ')}); the element belonged to the previous document and does not exist here`,
      };
    }
    return {
      ok: false,
      staleness: 'GONE',
      remembered: false,
      detail: 'this identity was never in the model for this tab — the reference came from somewhere else',
    };
  }
  return { ...resolveTarget(target, model.latest), remembered: true };
}

/**
 * A compact rendering of the model for a tool answer. Bounded, and it names what it left out — the same
 * contract the snapshot outline keeps, because a model that silently truncates is worse than one that
 * says it truncated.
 */
export function summarizeModel(model: WorldModel, budget = 900): { text: string; omitted: string[] } {
  const lines: string[] = [];
  const omitted: string[] = [];
  let used = 0;
  const push = (s: string) => {
    if (used + s.length + 1 > budget) omitted.push(s);
    else {
      lines.push(s);
      used += s.length + 1;
    }
  };

  push(`tab ${model.tabId} · v${model.version} · ${model.url}`);
  push(`document ${model.documentSignature} · title "${model.title}"`);
  const last = model.transitions[model.transitions.length - 1];
  push(`last change: ${last.kind} at v${last.version} — ${last.summary}`);
  push(
    `nodes ${model.coverage.identitiesInLatest} present / ${model.coverage.identitiesKnown} known · objects ${
      model.objects.map((o) => `${o.kind}(${o.members.length})`).join(', ') || 'none'
    }`,
  );
  push(
    `coverage: ${model.coverage.omittedByBudget} omitted by budget · ${model.coverage.frames.length} frame(s) seen${
      model.coverage.viewportCoverage === null
        ? ' · page height unknown'
        : ` · ${Math.round(model.coverage.viewportCoverage * 100)}% of height scrolled`
    }`,
  );
  for (const gap of model.coverage.gaps) push(`gap: ${gap}`);
  if (model.evicted) push(`model evicted ${model.evicted} identities at its ${model.limits.nodes} cap`);
  return { text: lines.join('\n'), omitted };
}

/** Every identity the model holds, oldest first — the answer to "what can still be acted on?". */
export function knownIdentities(model: WorldModel): string[] {
  return [...model.nodes.keys()];
}
