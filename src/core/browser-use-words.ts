/**
 * Word geometry: every visible word on a page and the box it actually occupies.
 *
 * Element boxes are not enough once someone asks a honest question about a screenshot. A paragraph is one
 * `<p>` with one rect, so "where is the word *quantum*" has no answer at element level — the element that
 * contains it may span the whole column. Words are the smallest unit of meaning a model reads, and a range
 * over a text node has a real box, so this module walks text nodes and measures each non-space run with
 * `Range.getClientRects()`.
 *
 * Two details that decide whether the numbers can be trusted:
 *
 * 1. **A word that wraps across lines is several boxes, not one.** Returning the union would describe a
 *    rectangle that covers the end of one line and the start of the next, which is not where the word is.
 *    So each fragment is kept, the union is reported alongside it and labelled as a union, and `parts`
 *    says how many fragments the reader is looking at.
 * 2. **A word belongs to the element the collector stamped.** Each row carries the nearest ancestor's
 *    `data-pf-id`, so a word can be joined to the element row that owns it without recomputing an
 *    identity from a path — and when nothing is stamped (past the collector's cap, or inside a subtree it
 *    skipped) the row says `null` instead of inventing an owner.
 *
 * The script is a string because it runs inside the page, so it carries no backticks: the collector's
 * template literal breaks on them, and this one would too.
 */

import type { Rect } from './browser-use-perception.js';

export interface RawWord {
  /** The word exactly as the document holds it, whitespace already excluded. */
  text: string;
  /** Union of every fragment box, in CSS viewport pixels. */
  rect: Rect;
  /** One box per line the word is broken across. Always at least one entry. */
  fragments: Rect[];
  frameId: string;
  /** The stamped ancestor, or null when the collector did not reach this far. */
  ownerBackendId: string | null;
  ownerTag: string;
  ownerPath: string;
  /** Character offsets inside the text node — what separates this word from an identical one. */
  start: number;
  end: number;
  inViewport: boolean;
}

export interface WordReport {
  words: RawWord[];
  /** Words past the cap that were counted but not measured. */
  truncated: number;
  /** Text runs with no box at all — zero-area rects, usually empty or collapsed markup. */
  unmeasured: number;
  /** Words whose range call threw, which happens in detached or exotic trees. */
  errored: number;
  viewport: { width: number; height: number };
  scroll: { x: number; y: number };
}

/** How many words one read returns before it is cut. A page of a novel is ~50k words; that is not a read, it is a dump. */
export const MAX_WORDS = 4000;

/** Tags whose text is never shown to a reader. */
const SKIP_TAGS = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE', 'META', 'LINK', 'SVG', 'PATH', 'HEAD'];

/**
 * Evaluated inside the page. Returns `WordReport`.
 *
 * `getClientRects()` rather than `getBoundingClientRect()`: the latter returns the union of the fragments,
 * which for a wrapped word is a box covering text that is not part of the word. The union is still computed
 * here, but from the fragments, and `parts` says when it should not be used as a click target.
 */
export const WORD_SCRIPT = `(() => {
  const MAX = ${MAX_WORDS};
  const SKIP = ${JSON.stringify(SKIP_TAGS)};
  const out = [];
  const vw = window.innerWidth, vh = window.innerHeight;
  let truncated = 0, unmeasured = 0, errored = 0;

  const pathOf = (el) => {
    const parts = [];
    let node = el, guard = 0;
    while (node && node.nodeType === 1 && guard++ < 16) {
      let name = node.tagName.toLowerCase();
      if (node.id) { parts.unshift(name + '#' + node.id); break; }
      let sibling = 1, prev = node.previousElementSibling;
      while (prev) { if (prev.tagName === node.tagName) sibling++; prev = prev.previousElementSibling; }
      parts.unshift(name + (sibling > 1 ? '[' + sibling + ']' : ''));
      node = node.parentElement;
    }
    return parts.join('>');
  };

  const blocked = (el) => {
    for (let p = el; p; p = p.parentElement) {
      if (SKIP.indexOf(p.tagName) !== -1) return 'tag';
    }
    if (el.closest && el.closest('details:not([open])')) return 'closed-details';
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return 'style';
    return '';
  };

  const filter = {
    acceptNode(node) {
      if (!node.data || !node.data.trim()) return NodeFilter.FILTER_REJECT;
      const el = node.parentElement;
      if (!el || blocked(el)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  };
  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT, filter);
  const range = document.createRange();
  let stopped = false;
  let node = walker.nextNode();

  while (node) {
    const data = node.data;
    const el = node.parentElement;
    let owner = null;
    if (el && el.closest) {
      const stamped = el.closest('[data-pf-id]');
      if (stamped) owner = { id: stamped.getAttribute('data-pf-id'), tag: stamped.tagName.toLowerCase(), path: pathOf(stamped) };
    }
    const pattern = /\\S+/g;
    let match;
    while ((match = pattern.exec(data)) !== null) {
      if (stopped || out.length >= MAX) {
        // Past the cap the words are still counted, because a report that says "4000" when the page holds
        // 12000 has hidden nine thousand from the reader.
        stopped = true;
        truncated++;
        continue;
      }
      const word = match[0];
      let rects;
      try {
        range.setStart(node, match.index);
        range.setEnd(node, match.index + word.length);
        rects = Array.prototype.slice.call(range.getClientRects());
      } catch (error) {
        errored++;
        continue;
      }
      const fragments = rects
        .filter((r) => r.width > 0 && r.height > 0)
        .map((r) => ({ x: Math.round(r.left * 100) / 100, y: Math.round(r.top * 100) / 100,
                       width: Math.round(r.width * 100) / 100, height: Math.round(r.height * 100) / 100 }));
      if (!fragments.length) { unmeasured++; continue; }
      let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
      for (const f of fragments) {
        if (f.x < left) left = f.x;
        if (f.y < top) top = f.y;
        if (f.x + f.width > right) right = f.x + f.width;
        if (f.y + f.height > bottom) bottom = f.y + f.height;
      }
      out.push({
        text: word.slice(0, 120),
        rect: { x: left, y: top, width: right - left, height: bottom - top },
        fragments,
        frameId: 'main',
        ownerBackendId: owner ? owner.id : null,
        ownerTag: owner ? owner.tag : (el ? el.tagName.toLowerCase() : ''),
        ownerPath: owner ? owner.path : (el ? pathOf(el) : ''),
        start: match.index,
        end: match.index + word.length,
        inViewport: bottom > 0 && top < vh && right > 0 && left < vw,
      });
    }
    node = walker.nextNode();
  }

  return { words: out, truncated, unmeasured, errored,
           viewport: { width: vw, height: vh }, scroll: { x: window.scrollX, y: window.scrollY } };
})()`;

/** What the page hands back, before the perception layer joins it to elements. */
export interface WordRow {
  index: number;
  text: string;
  rect: Rect;
  fragments: Rect[];
  owner_backend_id: string | null;
  /** The identity of the owning element, when the same read knows it. */
  owner_identity: string | null;
  owner_tag: string;
  owner_path: string;
  /** Centre of the word box — the point that lands on this word. */
  centre: { x: number; y: number };
  in_viewport: boolean;
  parts: number;
  chars: [number, number];
}

/**
 * Join words to the elements that own them and number them.
 *
 * The join is by the collector's own stamped id, which is the one identifier both sides agree on without
 * recomputation. A word whose owner was never stamped keeps `owner_identity: null`: an unknown owner is
 * reported as unknown, not attached to whatever ancestor happens to be nearby in the list.
 */
export function buildWordRows(
  report: Pick<WordReport, 'words'>,
  nodes: Array<{ identity: string; backendId: string }>,
): WordRow[] {
  const byBackend = new Map(nodes.map((n) => [n.backendId, n.identity]));
  return report.words.map((word, index) => ({
    index: index + 1,
    text: word.text,
    rect: word.rect,
    fragments: word.fragments,
    owner_backend_id: word.ownerBackendId,
    owner_identity: word.ownerBackendId ? (byBackend.get(word.ownerBackendId) ?? null) : null,
    owner_tag: word.ownerTag,
    owner_path: word.ownerPath,
    centre: { x: word.rect.x + word.rect.width / 2, y: word.rect.y + word.rect.height / 2 },
    in_viewport: word.inViewport,
    parts: word.fragments.length,
    chars: [word.start, word.end],
  }));
}

/**
 * The box around a phrase, from the words that make it up.
 *
 * This is what makes the word map useful to a reader rather than merely large: "circle the sentence about
 * the treaty" resolves to one rectangle. Matching is over consecutive words within one owner, so a phrase
 * that only exists by coincidence across two unrelated paragraphs is not reported as a match — the words
 * of a heading and the words of the body text below it are not a sentence.
 */
export interface PhraseHit {
  phrase: string;
  /** Word indices, 1-based, exactly as `buildWordRows` numbered them. */
  from: number;
  to: number;
  rect: Rect;
  fragments: Rect[];
  /** How many times the phrase occurred; only the first is returned, so a caller knows to narrow down. */
  occurrences: number;
  /** The first occurrence straddled a line break, so `rect` is a union and not one box. */
  wrapped: boolean;
}

export function findPhrase(rows: WordRow[], phrase: string): PhraseHit | null {
  const target = phrase.trim().split(/\s+/).filter(Boolean);
  if (!target.length) return null;
  const wanted = target.map((w) => w.toLowerCase());
  let occurrences = 0;
  let first: WordRow[] | null = null;
  for (let i = 0; i <= rows.length - wanted.length; i++) {
    let ok = true;
    for (let k = 0; k < wanted.length; k++) {
      const row = rows[i + k];
      if (!row || row.text.toLowerCase() !== wanted[k]) {
        ok = false;
        break;
      }
      // Same owner, or both owners unknown. A phrase assembled from two different elements is a matching
      // artifact, not a phrase on the page.
      if (k > 0 && rows[i].owner_backend_id !== rows[i + k].owner_backend_id) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    occurrences++;
    if (!first) first = rows.slice(i, i + wanted.length);
  }
  if (!first) return null;
  const fragments = first.flatMap((row) => row.fragments);
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const f of fragments) {
    left = Math.min(left, f.x);
    top = Math.min(top, f.y);
    right = Math.max(right, f.x + f.width);
    bottom = Math.max(bottom, f.y + f.height);
  }
  return {
    phrase: target.join(' '),
    from: first[0].index,
    to: first[first.length - 1].index,
    rect: { x: left, y: top, width: right - left, height: bottom - top },
    fragments,
    occurrences,
    wrapped: first.some((row) => row.parts > 1),
  };
}

/** Words whose box overlaps a rectangle — "what text is inside this box", answered from the read. */
export function wordsInRect(rows: WordRow[], rect: Rect): WordRow[] {
  return rows.filter(
    (row) =>
      row.rect.x < rect.x + rect.width &&
      rect.x < row.rect.x + row.rect.width &&
      row.rect.y < rect.y + rect.height &&
      rect.y < row.rect.y + row.rect.height,
  );
}

/** A plain transcript of the words in a region, in document order as measured. */
export function textOfWords(rows: WordRow[]): string {
  return rows.map((row) => row.text).join(' ');
}

export interface WordSummary {
  words: number;
  in_viewport: number;
  wrapped: number;
  unowned: number;
  owners: number;
  /** Words per owner, highest first — tells a reader where the text actually is. */
  busiest: Array<{ owner_backend_id: string | null; tag: string; count: number }>;
}

export function summarizeWords(rows: WordRow[]): WordSummary {
  const byOwner = new Map<string, { tag: string; count: number }>();
  let unowned = 0;
  for (const row of rows) {
    if (!row.owner_backend_id) {
      unowned++;
      continue;
    }
    const entry = byOwner.get(row.owner_backend_id) ?? { tag: row.owner_tag, count: 0 };
    entry.count++;
    byOwner.set(row.owner_backend_id, entry);
  }
  const busiest = [...byOwner.entries()]
    .map(([owner_backend_id, value]) => ({ owner_backend_id, tag: value.tag, count: value.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  return {
    words: rows.length,
    in_viewport: rows.filter((row) => row.in_viewport).length,
    wrapped: rows.filter((row) => row.parts > 1).length,
    unowned,
    owners: byOwner.size,
    busiest,
  };
}

/** One line of the compact word listing: index, word, and the box in the space the caller asked for. */
export function wordLine(row: WordRow, x: number, y: number): string {
  return `#${row.index} "${row.text}" @${Math.round(x)},${Math.round(y)} ${Math.round(row.rect.width)}x${Math.round(row.rect.height)}`;
}
