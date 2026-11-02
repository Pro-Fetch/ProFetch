/**
 * The coverage ledger: an accounting of what a page has actually been shown, and what has not.
 *
 * Every browser agent eventually answers a question about a part of the page it never looked at. The cause
 * is that "I read the DOM" sounds complete while a viewport is not: a page four screens tall has three
 * screens of elements that were never in view, an iframe may have produced nothing, and a budget may have
 * dropped half the nodes. A snapshot says what it saw; this says what *has been* seen across snapshots, in
 * units a reader can check — bands of scroll position, frames, and the elements that only appear once
 * something is revealed.
 *
 * It is deliberately arithmetic. Nothing here touches a browser or decides what to do; it counts, it plans
 * the next scroll steps, and it refuses to round an unknown up to full coverage.
 */

import type { PerceivedNode, Snapshot } from './browser-use-perception.js';

export interface Band {
  /** Top of this band in page (document) coordinates. */
  y: number;
  height: number;
  /** Page-y range that has actually been inside a viewport, merged across reads. */
  seenFrom: number | null;
  seenTo: number | null;
  /** Set once the band has been seen end to end — not merely touched by an overlapping viewport. */
  visitedAt: number | null;
  /** Distinct identities first seen while this band was the one being looked at. */
  newIdentities: number;
  nodesVisible: number;
}

export interface FrameCoverage {
  frameId: string;
  observed: boolean;
  nodesSeen: number;
  /** Why a frame was never read, when that is the case. */
  reason: string;
  /** True when the frame's position inside the page is known, so its coordinates can be lifted. */
  positionKnown: boolean;
}

export interface RevealCandidate {
  identity: string;
  label: string;
  /** How the state would be revealed. */
  kind: 'expand' | 'collapse' | 'hover' | 'focus' | 'click-toggle' | 'submit' | 'navigate' | 'unknown';
  safety: RevealSafety;
  reason: string;
  /** What has to be undone afterwards for the page to be as it was. */
  restore: string;
}

export type RevealSafety =
  /** No request, no state change, and the reversal is performed in the same breath. */
  | 'SAFE_REVERSIBLE'
  /** Could be done, but it changes something the page may act on — ask first. */
  | 'NEEDS_CONFIRMATION'
  /** Never offered by this engine: it sends data, changes the document, or cannot be undone. */
  | 'REFUSED';

export interface Ledger {
  url: string;
  /** Document signature of the page this ledger is about. A navigation must start a new ledger. */
  documentSignature: string;
  viewport: { width: number; height: number };
  /** Page height as the host reported it. `null` means coverage cannot be a percentage, only a floor. */
  contentHeight: number | null;
  bands: Band[];
  frames: FrameCoverage[];
  /** Every identity ever seen in this document, so "already known" is not re-counted as new. */
  identities: Set<string>;
  /** Interactable elements that have never been inside a visited band — the honest "unseen" list. */
  unseenInteractable: number;
  budget: { maxSteps: number; stepsSpent: number };
  /** Nodes the collection dropped for being outside the budget, summed across the run. */
  omittedByBudget: number;
  gaps: string[];
}

export interface LedgerInput {
  /** Page height from the host. Omit rather than guess. */
  contentHeight?: number | null;
  /** Frame ids the tab has, whether or not they produced anything. */
  declaredFrames?: Array<{ frameId: string; positionKnown?: boolean }>;
  maxSteps?: number;
}

/**
 * Build a ledger from the first snapshot.
 *
 * Bands are viewport-sized and non-overlapping: a page read once at the top has covered one band, and the
 * remaining bands are the debt. Anything else (percentage of pixels, percentage of nodes) flatters the
 * number.
 */
export function createLedger(snapshot: Snapshot, input: LedgerInput = {}): Ledger {
  const height = input.contentHeight ?? null;
  const bandHeight = Math.max(1, snapshot.viewport.height);
  const total = height ? Math.max(1, Math.ceil(height / bandHeight)) : 1;
  const bands: Band[] = [];
  for (let i = 0; i < total; i++) {
    const y = i * bandHeight;
    // The final band is whatever the page actually has left; asking it to be a full viewport tall would
    // make a page that ends mid-screen impossible to cover.
    const h = height ? Math.min(bandHeight, height - y) : bandHeight;
    bands.push({
      y,
      height: Math.max(1, h),
      seenFrom: null,
      seenTo: null,
      visitedAt: null,
      newIdentities: 0,
      nodesVisible: 0,
    });
  }
  const ledger: Ledger = {
    url: snapshot.url,
    documentSignature: signatureOf(snapshot),
    viewport: snapshot.viewport,
    contentHeight: height,
    bands,
    frames: (input.declaredFrames ?? []).map((f) => ({
      frameId: f.frameId,
      observed: false,
      nodesSeen: 0,
      reason: 'declared but not read yet',
      positionKnown: f.positionKnown ?? false,
    })),
    identities: new Set<string>(),
    unseenInteractable: 0,
    budget: { maxSteps: input.maxSteps ?? 12, stepsSpent: 0 },
    omittedByBudget: 0,
    gaps: [],
  };
  return recordSnapshot(ledger, snapshot, { first: true });
}

function signatureOf(snapshot: Snapshot): string {
  // Same idea as the world model's document signature, kept local so this file has no import cycle.
  const shallow = snapshot.nodes
    .filter((n) => n.depth <= 2)
    .map((n) => n.path)
    .sort()
    .slice(0, 64)
    .join(',');
  const base = snapshot.url.split('#')[0];
  let h = 0x811c9dc5;
  const s = `${base}|${shallow}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Fold a snapshot into the ledger.
 *
 * A snapshot from a different document does not update the ledger, it invalidates it — returning the old
 * one with a `REFUSED` gap message would let a caller keep counting coverage across a navigation.
 */
export function recordSnapshot(
  ledger: Ledger,
  snapshot: Snapshot,
  options: { first?: boolean; stepCosts?: boolean } = {},
): Ledger {
  const signature = signatureOf(snapshot);
  if (!options.first && signature !== ledger.documentSignature) {
    throw new Error(
      `snapshot is from a different document (${ledger.documentSignature} → ${signature}); start a new ledger instead of mixing coverage from two pages`,
    );
  }
  const identities = new Set(ledger.identities);
  const bands = ledger.bands.map((b) => ({ ...b }));
  const scrollY = snapshot.scroll.y;
  const viewTop = scrollY;
  const viewBottom = scrollY + snapshot.viewport.height;

  let newCount = 0;
  let grownTo: number | null = null;
  for (const node of snapshot.nodes) {
    if (!identities.has(node.identity)) {
      identities.add(node.identity);
      newCount++;
    }
  }

  const touched = bands.filter((b) => b.y < viewBottom && b.y + b.height > viewTop);
  if (touched.length) {
    const visibleNodes = snapshot.nodes.filter((n) => n.inViewport).length;
    for (const band of touched) {
      const from = Math.max(band.y, viewTop);
      const to = Math.min(band.y + band.height, viewBottom);
      band.seenFrom = band.seenFrom === null ? from : Math.min(band.seenFrom, from);
      band.seenTo = band.seenTo === null ? to : Math.max(band.seenTo, to);
      band.nodesVisible = Math.max(band.nodesVisible, visibleNodes);
      // A band counts as visited when the page range it stands for has been inside a viewport from edge to
      // edge. Overlap is not coverage: two reads that each miss 200 px of a band have not seen that band.
      if (band.seenFrom <= band.y + 2 && band.seenTo >= band.y + band.height - 2) band.visitedAt = snapshot.capturedAt;
    }
    // New identities are booked to the band whose top the viewport is looking at, so a count can be
    // traced back to where the reader actually was.
    const primary = touched.find((b) => b.y <= viewTop && b.y + b.height > viewTop) ?? touched[0];
    primary.newIdentities += newCount;
  } else if (snapshot.nodes.length) {
    // Scrolled past the known bands: the page is taller than the host said. Grow the ledger instead of
    // hiding the fact that there is more below.
    const bandHeight = Math.max(1, snapshot.viewport.height);
    const start = bands.length;
    const extra = Math.max(1, Math.ceil((viewBottom - start * bandHeight) / bandHeight));
    for (let i = 0; i < extra; i++) {
      const y = (start + i) * bandHeight;
      const from = Math.max(y, viewTop);
      const to = Math.min(y + bandHeight, viewBottom);
      const overlapped = to > from;
      const band: Band = {
        y,
        height: bandHeight,
        seenFrom: overlapped ? from : null,
        seenTo: overlapped ? to : null,
        visitedAt: null,
        newIdentities: i === 0 ? newCount : 0,
        nodesVisible: snapshot.nodes.filter((n) => n.inViewport).length,
      };
      bands.push(band);
    }
    // The page is at least this tall now — that is a measurement, not a guess, and keeping the old number
    // would leave the last band unreachable and coverage permanently below 1.
    grownTo = viewBottom;
  }

  const contentHeight = grownTo !== null ? Math.max(ledger.contentHeight ?? 0, grownTo) : ledger.contentHeight;
  if (grownTo !== null && contentHeight) {
    for (const band of bands) {
      band.height = Math.max(1, Math.min(band.height, contentHeight - band.y));
      if (
        band.visitedAt === null &&
        band.seenFrom !== null &&
        band.seenTo !== null &&
        band.seenFrom <= band.y + 2 &&
        band.seenTo >= band.y + band.height - 2
      ) {
        band.visitedAt = snapshot.capturedAt;
      }
    }
  }

  const frames = ledger.frames.map((f) => {
    const seen = snapshot.nodes.filter((n) => n.frameId === f.frameId);
    if (!seen.length) return f;
    return { ...f, observed: true, nodesSeen: f.nodesSeen + seen.length, reason: 'read' };
  });
  for (const node of snapshot.nodes) {
    if (!frames.some((f) => f.frameId === node.frameId)) {
      frames.push({
        frameId: node.frameId,
        observed: true,
        nodesSeen: 1,
        reason: 'appeared without being declared',
        positionKnown: node.frameId === 'main',
      });
    }
  }

  const unseenInteractable = [...identities].length
    ? snapshot.nodes.filter((n) => n.interactive).length -
      snapshot.nodes.filter((n) => n.interactive && n.inViewport).length
    : 0;

  const gaps: string[] = [];
  const unvisited = bands.filter((b) => b.visitedAt === null).length;
  if (unvisited) gaps.push(`${unvisited} of ${bands.length} band(s) never visited`);
  if (ledger.contentHeight === null) gaps.push('page height unknown, so band coverage is a floor, not a percentage');
  const unreadFrames = frames.filter((f) => !f.observed);
  if (unreadFrames.length) gaps.push(`frame(s) never read: ${unreadFrames.map((f) => f.frameId).join(', ')}`);
  const unpositioned = frames.filter((f) => f.observed && !f.positionKnown);
  if (unpositioned.length)
    gaps.push(`frame(s) read but not positioned: ${unpositioned.map((f) => f.frameId).join(', ')}`);
  if (snapshot.truncated) gaps.push(`${snapshot.truncated} node(s) dropped from the latest snapshot by its budget`);

  return {
    ...ledger,
    contentHeight,
    bands,
    frames,
    identities,
    unseenInteractable: Math.max(0, unseenInteractable),
    omittedByBudget: ledger.omittedByBudget + snapshot.truncated,
    budget: { ...ledger.budget, stepsSpent: ledger.budget.stepsSpent + (options.stepCosts === false ? 0 : 1) },
    documentSignature: signature,
    url: snapshot.url,
    gaps,
  };
}

export interface ScanPlan {
  /** Scroll positions to visit next, in order. Empty when the ledger is already covered or out of budget. */
  scrolls: number[];
  /** Why the plan stops where it does. */
  reason: string;
  /** Bands that would remain unvisited after this plan is executed. */
  remaining: number;
}

/**
 * Plan the scrolls that would close the coverage debt.
 *
 * The overlap exists because a viewport-sized step can leave a row of elements never fully inside the view
 * — a control split between two bands is visible in neither, and an agent that "covered the page" never saw
 * it whole. Default overlap is a quarter of the viewport.
 */
export function planScan(ledger: Ledger, options: { maxSteps?: number; overlapPx?: number } = {}): ScanPlan {
  const remainingBands = ledger.bands.filter((b) => b.visitedAt === null);
  const budgetLeft = Math.max(0, ledger.budget.maxSteps - ledger.budget.stepsSpent);
  const maxSteps = Math.min(options.maxSteps ?? 8, budgetLeft);
  if (!ledger.contentHeight) {
    return {
      scrolls: [],
      reason: 'page height unknown, so a scan cannot promise to reach the bottom',
      remaining: remainingBands.length,
    };
  }
  if (!remainingBands.length) return { scrolls: [], reason: 'every band has been visited', remaining: 0 };
  if (!maxSteps)
    return {
      scrolls: [],
      reason: `out of scan budget (${ledger.budget.stepsSpent}/${ledger.budget.maxSteps} steps spent)`,
      remaining: remainingBands.length,
    };

  const overlap = options.overlapPx ?? Math.round(ledger.viewport.height / 4);
  const maxScroll = Math.max(0, ledger.contentHeight - ledger.viewport.height);
  const scrolls: number[] = [];
  for (const band of remainingBands) {
    // Aim at the band's own top rather than a stride grid: a band is at most a viewport tall, so a read
    // starting there covers it edge to edge. Grid-snapped targets can name a position that covers the
    // band's *neighbour* instead, which leaves a scan re-planning the same scroll forever.
    const target = Math.min(maxScroll, band.y);
    if (!scrolls.includes(target)) scrolls.push(target);
    if (scrolls.length >= maxSteps) break;
  }
  const reached = new Set<number>();
  for (const y of scrolls) {
    for (const band of remainingBands)
      if (y <= band.y + 2 && y + ledger.viewport.height >= band.y + band.height - 2) reached.add(band.y);
  }
  return {
    scrolls,
    reason: `${scrolls.length} step(s), each aimed at a band top with ${overlap}px of read overlap requested, ${maxSteps} allowed, max scroll ${maxScroll}`,
    remaining: remainingBands.filter((b) => !reached.has(b.y)).length,
  };
}

/** Percentage of the page's bands that have been looked at. `null` when the height is unknown. */
export function coverageRatio(ledger: Ledger): number | null {
  if (!ledger.bands.length) return null;
  const visited = ledger.bands.filter((b) => b.visitedAt !== null).length;
  return visited / ledger.bands.length;
}

export function complete(ledger: Ledger): boolean {
  return (
    ledger.contentHeight !== null &&
    ledger.bands.every((b) => b.visitedAt !== null) &&
    ledger.frames.every((f) => f.observed)
  );
}

/** The part a model or a human reads. Bounded, and it names what is still missing. */
export function describeLedger(ledger: Ledger, budget = 700): { text: string; omitted: string[] } {
  const lines: string[] = [];
  const omitted: string[] = [];
  let used = 0;
  const push = (s: string): void => {
    if (used + s.length + 1 > budget) omitted.push(s);
    else {
      lines.push(s);
      used += s.length + 1;
    }
  };
  const ratio = coverageRatio(ledger);
  const visited = ledger.bands.filter((b) => b.visitedAt !== null).length;
  push(`coverage for ${ledger.url}`);
  push(
    `bands ${visited}/${ledger.bands.length}${ratio === null ? ' (page height unknown: a floor, not a percentage)' : ` = ${Math.round(ratio * 100)}%`}` +
      ` · ${ledger.identities.size} identities · ${ledger.budget.stepsSpent}/${ledger.budget.maxSteps} scan steps`,
  );
  push(
    `frames: ${ledger.frames.filter((f) => f.observed).length}/${ledger.frames.length || 1} read` +
      (ledger.frames.filter((f) => f.observed && !f.positionKnown).length
        ? `, ${ledger.frames.filter((f) => f.observed && !f.positionKnown).length} without a measured position`
        : ''),
  );
  if (ledger.omittedByBudget) push(`${ledger.omittedByBudget} node(s) dropped by collection budgets`);
  if (ledger.unseenInteractable) push(`${ledger.unseenInteractable} interactable node(s) outside the last read region`);
  for (const gap of ledger.gaps) push(`gap: ${gap}`);
  return { text: lines.join('\n'), omitted };
}

/* ------------------------------------------------------------------ state discovery */

const DESTRUCTIVE =
  /(delete|remove|cancel|unsubscribe|purchase|buy|pay|submit|send|publish|post|transfer|withdraw|claim|redeem|accept all|reject all)/i;
/** Labels that mean the control hands something to a server, whatever its tag says. */
const SENDING = /(submit|send|sign in|log in|register|order|checkout|apply|subscribe)/i;

function labelOf(node: PerceivedNode): string {
  return node.name || node.text || node.placeholder || node.role || node.tag;
}

/**
 * Decide whether revealing a hidden state is safe to do without asking.
 *
 * The rule is the one this repository already uses elsewhere — fail closed. A state that can be opened and
 * closed again without sending anything is offered; anything that sends data, changes the document, or
 * cannot be reversed is refused or escalated, and the reason is written so a caller can disagree with the
 * judgement instead of guessing at it.
 */
export function classifyReveal(node: PerceivedNode, kind: RevealCandidate['kind']): RevealCandidate {
  const label = labelOf(node);
  const base = { identity: node.identity, label, kind };
  const destructive = DESTRUCTIVE.test(label);

  if (destructive) {
    return {
      ...base,
      safety: 'REFUSED',
      reason: `"${label}" is a verb that changes something outside the page; a scan does not offer it`,
      restore: 'not reversible',
    };
  }
  switch (kind) {
    case 'expand':
    case 'collapse':
      return {
        ...base,
        safety: 'SAFE_REVERSIBLE',
        reason: 'an open/closed disclosure that the page itself can reverse',
        restore: kind === 'expand' ? 'collapse it again' : 'expand it again',
      };
    case 'hover':
      return {
        ...base,
        safety: 'SAFE_REVERSIBLE',
        reason: 'pointer position only; nothing is sent',
        restore: 'move the pointer away',
      };
    case 'focus':
      return {
        ...base,
        safety: 'SAFE_REVERSIBLE',
        reason: 'focus can be moved back; a focus handler that navigates would be caught before the next action',
        restore: 'blur the element',
      };
    case 'click-toggle':
      return {
        ...base,
        safety: 'NEEDS_CONFIRMATION',
        reason: 'a click may be wired to a request even when the label looks local',
        restore: 'click the same element again',
      };
    case 'submit':
      return { ...base, safety: 'REFUSED', reason: 'submitting sends data', restore: 'not reversible' };
    case 'navigate':
      return {
        ...base,
        safety: 'REFUSED',
        reason: 'leaving the document voids every identity collected so far',
        restore: 'not reversible without a back navigation',
      };
    default:
      return {
        ...base,
        safety: 'NEEDS_CONFIRMATION',
        reason: 'the element is not recognised, so no claim about its effect is made',
        restore: 'unknown',
      };
  }
}

/**
 * Candidates worth revealing on a snapshot, in the order a scan would take them.
 *
 * Only elements that are *not* currently contributing — hidden, or outside the region that has been read —
 * are considered, because a state that is already visible is not a discovery. The kind comes from what the
 * node is, and the label is checked as well: an `aria-expanded` "Delete item" is reported as refused
 * rather than quietly planned.
 */
export function revealCandidates(snapshot: Snapshot, limit = 12): RevealCandidate[] {
  const out: RevealCandidate[] = [];
  for (const node of snapshot.nodes) {
    // A disclosure whose content is closed is worth revealing even though the disclosure itself is on
    // screen: what is missing is not the element, it is what the element hides.
    const isDisclosure = node.tag === 'details' || node.role === 'disclosure' || node.state.expanded !== undefined;
    const collapsed = isDisclosure && node.state.expanded === false;
    if (node.visible && node.inViewport && !collapsed) continue;
    const isField = node.tag === 'input' || node.tag === 'textarea' || node.tag === 'select';
    const worthRevealing = node.interactive || node.role === 'button' || node.role === 'link' || isDisclosure;
    if (!worthRevealing) continue;

    const label = labelOf(node);
    let kind: RevealCandidate['kind'];
    if (isDisclosure) kind = 'expand';
    else if (node.tag === 'a' && node.href) kind = 'navigate';
    else if (SENDING.test(label)) kind = 'submit';
    else if (isField) kind = 'focus';
    else kind = 'click-toggle';

    out.push(classifyReveal(node, kind));
    if (out.length >= limit) break;
  }
  return out;
}
