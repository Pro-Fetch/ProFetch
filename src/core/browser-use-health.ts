/**
 * Website health: what is wrong with this page, how sure are we, and what may be done about it.
 *
 * Diagnostics here are derived from what the engine observed — the perception snapshot, the document's own
 * metadata, and the coverage ledger — not from a checklist of opinions about style. Each finding names the
 * elements it is about and the evidence that fired it, because "accessibility: poor" is not actionable and
 * "3 of 7 interactable elements have no accessible name: pf-4, pf-9, pf-11" is.
 *
 * Recovery is the part that gets over-promise. This engine may make a *temporary, local, visual* change to
 * the page it is reading — a style rule that un-clips an element so it can be seen and hit — and it must
 * then undo it and prove the page is as it was. It does not patch the site, does not store anything on the
 * server, and does not attempt a fix whose result nobody verified. Every recovery carries a status, and
 * `FIXED_VERIFIED` is only reachable by someone re-reading the page afterwards.
 */

import type { PerceivedNode, Snapshot } from './browser-use-perception.js';
import type { Ledger } from './browser-use-coverage.js';

export type Severity = 'BLOCKING' | 'DEGRADED' | 'NOTICE';

/** What kind of remedy is possible, and how far this engine will go without asking. */
export type RecoveryKind =
  /** A change to this page's presentation, in this browser only, undone after use. */
  | 'TEMPORARY_LOCAL_VISUAL_RESCUE'
  /** The page itself has to change; nothing local and reversible will fix it. */
  | 'REPORT_ONLY';

export type RecoveryStatus =
  /** A fix was applied and a later read of the page showed the finding gone. */
  | 'FIXED_VERIFIED'
  /** A fix was applied and a later read showed it did not work. */
  | 'FIX_FAILED'
  /** A fix was applied but nothing re-read the page, so nobody can claim it worked. */
  | 'APPLIED_UNVERIFIED'
  /** Deliberately not tried: no local fix exists, or the caller said not to touch anything. */
  | 'NOT_ATTEMPTED';

export interface PageMeta {
  url: string;
  title: string;
  /** `document.documentElement.lang`. */
  lang: string;
  hasViewportMeta: boolean;
  doctype: string;
  /** Content wider than the viewport, in CSS pixels; 0 when nothing overflows. */
  horizontalOverflow: number;
  /** Count of ids used by more than one element. */
  duplicateIdCount: number;
  images: number;
  imagesWithoutAlt: number;
  /** Frames the page declares (iframe elements) — the ledger may add its own view. */
  frameCount: number;
  /** Seconds the page took to reach the state that was read, when the caller measured it. */
  loadSeconds?: number;
}

export interface Finding {
  /** Stable identifier so a caller can say "we still have the unlabeled-controls finding". */
  kind: string;
  severity: Severity;
  /** The measurement, in words, with the numbers in it. */
  evidence: string;
  /** Identities of the elements concerned, capped so a huge page cannot blow the answer up.
   * The count is always the true one. */
  affected: string[];
  count: number;
  recovery: RecoveryKind;
  recoveryStatus: RecoveryStatus;
  /** What would have to be done, and what it would not fix. */
  note: string;
}

export interface Diagnosis {
  findings: Finding[];
  /** Findings that were not evaluated because the input was missing, listed rather than assumed fine. */
  skipped: string[];
  blocking: number;
  degraded: number;
  notice: number;
  /** True only when the ledger says every band was read; a partial read cannot clear a page. */
  pageFullyObserved: boolean;
}

const MAX_AFFECTED = 12;

/**
 * The document facts a snapshot cannot show, as a script to evaluate inside the page.
 *
 * Plain JavaScript, no type syntax: this string is executed by a browser, not compiled. Every field maps to
 * a `PageMeta` property, and each is a measurement rather than a judgement — the severity lives in the
 * checks below, where it can be tested.
 */
export const PAGE_META_SCRIPT = `(() => {
  const vw = window.innerWidth;
  const de = document.documentElement;
  const ids = new Set();
  const dupes = new Set();
  document.querySelectorAll('[id]').forEach((el) => {
    const v = el.id;
    if (ids.has(v)) dupes.add(v); else ids.add(v);
  });
  const imgs = Array.from(document.querySelectorAll('img'));
  const noAlt = imgs.filter((i) => !i.hasAttribute('alt'));
  let overflow = 0;
  try { overflow = Math.max(0, de.scrollWidth - vw); } catch (e) { overflow = 0; }
  const vp = document.querySelector('meta[name="viewport"]');
  return {
    url: location.href,
    title: document.title || '',
    lang: (de.getAttribute('lang') || '').trim(),
    hasViewportMeta: !!vp,
    doctype: document.doctype ? document.doctype.name : '',
    horizontalOverflow: overflow,
    duplicateIdCount: dupes.size,
    images: imgs.length,
    imagesWithoutAlt: noAlt.length,
    frameCount: document.querySelectorAll('iframe').length
  };
})()`;

function finding(
  kind: string,
  severity: Severity,
  evidence: string,
  nodes: PerceivedNode[],
  recovery: RecoveryKind,
  note: string,
  countOverride?: number,
): Finding {
  return {
    kind,
    severity,
    evidence,
    affected: nodes.slice(0, MAX_AFFECTED).map((n) => n.backendId || n.identity),
    count: countOverride ?? nodes.length,
    recovery,
    recoveryStatus: 'NOT_ATTEMPTED',
    note,
  };
}

/** Anything the caller can click should be describable, or a model is guessing at what it is pressing. */
function unnamedControls(nodes: PerceivedNode[]): Finding | null {
  // A `value` is what a control holds, not what it is called, so it does not count as a name here.
  const bad = nodes.filter((n) => n.interactable && !n.name && !n.placeholder);
  if (!bad.length) return null;
  return finding(
    'unnamed-controls',
    'BLOCKING',
    `${bad.length} of ${nodes.filter((n) => n.interactable).length} interactable elements have no accessible name and no placeholder`,
    bad,
    'REPORT_ONLY',
    'A label has to exist in the document; a local style change cannot invent one. Until then, targeting these elements is guesswork.',
  );
}

/** A target smaller than a comfortable hit area is a source of clicks that land on the neighbour. */
function tinyTargets(nodes: PerceivedNode[]): Finding | null {
  const MIN = 24;
  const bad = nodes.filter((n) => n.interactable && (n.rect.width < MIN || n.rect.height < MIN));
  if (!bad.length) return null;
  const smallest = bad.reduce((a, b) => (a.rect.width * a.rect.height < b.rect.width * b.rect.height ? a : b));
  return finding(
    'tiny-targets',
    'DEGRADED',
    `${bad.length} interactable element(s) are under ${MIN}x${MIN} CSS px; the smallest is ${Math.round(smallest.rect.width)}x${Math.round(smallest.rect.height)} ("${smallest.name || smallest.role || smallest.tag}")`,
    bad,
    'TEMPORARY_LOCAL_VISUAL_RESCUE',
    'A local style rule can enlarge the hit area for this read, and must be undone afterwards; it does not fix the site for anyone else.',
  );
}

/** Elements that report themselves clickable but cannot actually be hit are a targeting trap. */
function unreachableInteractables(nodes: PerceivedNode[]): Finding | null {
  const bad = nodes.filter((n) => n.interactive && !n.interactable && n.visible);
  if (!bad.length) return null;
  const reason = bad[0].conflicts[0] || 'hit-test says the point lands elsewhere';
  return finding(
    'unreachable-interactables',
    'BLOCKING',
    `${bad.length} visible interactive element(s) cannot be reached at their own centre; first one: ${reason}`,
    bad,
    'TEMPORARY_LOCAL_VISUAL_RESCUE',
    'Often an overlay or a stacking context. Removing it locally may make the element hittable for this read; it will not tell you why the site does it.',
  );
}

/** A control the reader has never been able to look at is not a defect, but it is a gap in the read. */
function neverInView(nodes: PerceivedNode[]): Finding | null {
  // `interactable` already requires the element to be inside a viewport, so asking for it here would make
  // this finding unreachable: the question is about real interactive elements that were out of range.
  const bad = nodes.filter((n) => n.interactive && n.visible && !n.inViewport);
  if (!bad.length) return null;
  return finding(
    'interactables-outside-read-region',
    'NOTICE',
    `${bad.length} interactive element(s) sit outside the viewport that was read; they are real but were not lookable-at in this snapshot`,
    bad,
    'REPORT_ONLY',
    'Scroll and re-read rather than acting on coordinates that were never inside a viewport.',
  );
}

/** Images without alt text are the difference between a page and a page of rectangles. */
function imagesWithoutAlt(meta: PageMeta, nodes: PerceivedNode[]): Finding | null {
  if (!meta.images || !meta.imagesWithoutAlt) return null;
  const imgs = nodes.filter((n) => n.tag === 'img');
  return finding(
    'images-without-alt',
    'DEGRADED',
    `${meta.imagesWithoutAlt} of ${meta.images} image(s) have no alt attribute`,
    imgs.slice(0, meta.imagesWithoutAlt),
    'REPORT_ONLY',
    'Meaningful alternative text has to be written; an empty alt is only correct for decorative images, and this cannot tell which is which.',
    meta.imagesWithoutAlt,
  );
}

/** A form field with no label leaves the engine typing into something it cannot name. */
function unlabelledFields(meta: PageMeta, nodes: PerceivedNode[]): Finding | null {
  const fields = nodes.filter((n) => n.tag === 'input' || n.tag === 'textarea' || n.tag === 'select');
  const bad = fields.filter((n) => !n.name && !n.placeholder);
  if (!bad.length) return null;
  return finding(
    'unlabelled-fields',
    'BLOCKING',
    `${bad.length} of ${fields.length} form field(s) have no accessible name (a label, aria-label or placeholder)`,
    bad,
    'REPORT_ONLY',
    'The association has to exist in the document. Until it does, filling this form is a guess about which box is which.',
  );
}

function documentMetadata(meta: PageMeta): Finding[] {
  const out: Finding[] = [];
  if (!meta.title.trim()) {
    out.push(
      finding(
        'no-title',
        'NOTICE',
        'the document has no title',
        [],
        'REPORT_ONLY',
        'A title is written by the page, not by a reader.',
        1,
      ),
    );
  }
  if (!meta.lang.trim()) {
    out.push(
      finding(
        'no-lang',
        'DEGRADED',
        'the root element has no lang attribute, so text language has to be inferred',
        [],
        'REPORT_ONLY',
        'Language affects spelling, hyphenation and search; it cannot be measured reliably from content alone.',
        1,
      ),
    );
  }
  if (!meta.hasViewportMeta) {
    out.push(
      finding(
        'no-viewport-meta',
        'DEGRADED',
        'no viewport meta tag: mobile rendering scales the page rather than laying it out for the width',
        [],
        'TEMPORARY_LOCAL_VISUAL_RESCUE',
        'Emulating a device width and re-measuring is the honest way to test this; injecting the tag locally would only imitate the author.',
        1,
      ),
    );
  }
  if (!/html/i.test(meta.doctype)) {
    out.push(
      finding(
        'no-or-odd-doctype',
        'NOTICE',
        `doctype is "${meta.doctype || 'absent'}" — quirks mode changes box sizes, so geometry from this page is less predictable`,
        [],
        'REPORT_ONLY',
        'Coordinates are still reported, but a page in quirks mode is not laying out the way standards mode does.',
        1,
      ),
    );
  }
  if (meta.horizontalOverflow > 0) {
    out.push(
      finding(
        'horizontal-overflow',
        'DEGRADED',
        `content is ${Math.round(meta.horizontalOverflow)} CSS px wider than the viewport, so part of the page can only be reached by horizontal scrolling`,
        [],
        'TEMPORARY_LOCAL_VISUAL_RESCUE',
        'A local width fix can expose the clipped area for this read; the layout bug belongs to the page.',
        1,
      ),
    );
  }
  if (meta.duplicateIdCount > 0) {
    out.push(
      finding(
        'duplicate-ids',
        'DEGRADED',
        `${meta.duplicateIdCount} id value(s) are used by more than one element, so #id selectors are ambiguous`,
        [],
        'REPORT_ONLY',
        'Identity here is structural and does not depend on ids, but a page with duplicate ids breaks its own anchors and scripts.',
        meta.duplicateIdCount,
      ),
    );
  }
  return out;
}

/** The scheme matters: reading a page over http is not the same as reading it over https. */
function insecureOrigin(meta: PageMeta): Finding | null {
  if (!meta.url.startsWith('http://')) return null;
  return finding(
    'insecure-origin',
    'NOTICE',
    `${meta.url.slice(0, 60)} is served over http; content can be modified in transit before this engine reads it`,
    [],
    'REPORT_ONLY',
    'Nothing local fixes transport. Findings from this page are marked so a reader knows the source was not authenticated.',
    1,
  );
}

/** A page with no interactable elements at all is usually a failed read, not a static page. */
function emptyInteraction(nodes: PerceivedNode[]): Finding | null {
  if (nodes.some((n) => n.interactable)) return null;
  return finding(
    'no-interactable-elements',
    'BLOCKING',
    `${nodes.length} node(s) collected and none of them can be acted on`,
    [],
    'REPORT_ONLY',
    'Either the page really is static, or the read happened before the app hydrated. Re-read after waiting rather than concluding there is nothing there.',
    nodes.length,
  );
}

/**
 * Run the diagnostics.
 *
 * `ledger` is optional, but without it the diagnosis cannot say the page was fully observed — a scan of the
 * first screen would otherwise produce a clean bill of health for a page nobody read to the bottom.
 */
export function diagnose(snapshot: Snapshot, meta: PageMeta, ledger?: Ledger | null): Diagnosis {
  const findings: Finding[] = [];
  const skipped: string[] = [];
  const nodes = snapshot.nodes;

  for (const check of [
    unnamedControls(nodes),
    unlabelledFields(meta, nodes),
    unreachableInteractables(nodes),
    emptyInteraction(nodes),
    imagesWithoutAlt(meta, nodes),
    tinyTargets(nodes),
    neverInView(nodes),
    insecureOrigin(meta),
    ...documentMetadata(meta),
  ]) {
    if (check) findings.push(check);
  }

  const pageFullyObserved = ledger
    ? ledger.bands.every((b) => b.visitedAt !== null) && ledger.contentHeight !== null
    : false;
  if (!ledger) skipped.push('no coverage ledger: page was not confirmed to be read to the bottom');
  if (typeof meta.loadSeconds !== 'number') skipped.push('no load timing supplied: performance findings not evaluated');
  if (ledger && ledger.omittedByBudget > 0) {
    findings.unshift(
      finding(
        'collection-budget-omissions',
        'NOTICE',
        `${ledger.omittedByBudget} node(s) were dropped by collection budgets during the scan, so findings cover what was read`,
        [],
        'REPORT_ONLY',
        'Raise the budget or scan a region before concluding an element does not exist.',
        ledger.omittedByBudget,
      ),
    );
  }

  return {
    findings,
    skipped,
    blocking: findings.filter((f) => f.severity === 'BLOCKING').length,
    degraded: findings.filter((f) => f.severity === 'DEGRADED').length,
    notice: findings.filter((f) => f.severity === 'NOTICE').length,
    pageFullyObserved,
  };
}

export interface RescueRecord {
  finding: string;
  kind: RecoveryKind;
  status: RecoveryStatus;
  /** What was changed locally, in one line, with what proves it was undone. */
  detail: string;
  appliedAt: number | null;
  revertedAt: number | null;
  verifiedAt: number | null;
}

/**
 * Build the record for one attempted rescue.
 *
 * The status is a parameter, not an internal guess, because only the caller can know whether anything
 * re-read the page afterwards. This function exists so a rescue without verification is written down as
 * `APPLIED_UNVERIFIED` rather than remembered as a success.
 */
export function rescueRecord(input: {
  finding: string;
  status: RecoveryStatus;
  detail: string;
  appliedAt?: number | null;
  revertedAt?: number | null;
  verifiedAt?: number | null;
}): RescueRecord {
  const status = input.status === 'FIXED_VERIFIED' && !input.verifiedAt ? 'APPLIED_UNVERIFIED' : input.status;
  return {
    finding: input.finding,
    kind: 'TEMPORARY_LOCAL_VISUAL_RESCUE',
    status,
    detail: input.detail,
    appliedAt: input.appliedAt ?? null,
    revertedAt: input.revertedAt ?? null,
    verifiedAt: input.verifiedAt ?? null,
  };
}

/** The answer a tool returns: findings first, ordered by what blocks work, in a bounded number of lines. */
export function describeDiagnosis(diagnosis: Diagnosis, budget = 900): { text: string; omitted: string[] } {
  const ordered = [...diagnosis.findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
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
  push(
    `${diagnosis.blocking} blocking, ${diagnosis.degraded} degraded, ${diagnosis.notice} notice · page ${
      diagnosis.pageFullyObserved ? 'read end to end' : 'NOT fully read'
    }`,
  );
  for (const f of ordered) {
    push(`${f.severity} ${f.kind}: ${f.evidence} (count ${f.count}; recovery ${f.recovery} → ${f.recoveryStatus})`);
  }
  for (const s of diagnosis.skipped) push(`not evaluated: ${s}`);
  return { text: lines.join('\n'), omitted };
}

function severityRank(s: Severity): number {
  return s === 'BLOCKING' ? 0 : s === 'DEGRADED' ? 1 : 2;
}
