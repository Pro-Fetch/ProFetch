import { describe, it, expect } from 'vitest';
import {
  buildWordRows,
  findPhrase,
  summarizeWords,
  textOfWords,
  wordsInRect,
  type RawWord,
} from '../src/core/browser-use-words.js';
import type { Rect } from '../src/core/browser-use-perception.js';

/**
 * The word layer: boxes around text, and the joins that make those boxes mean something.
 *
 * The geometry itself belongs to the browser — `Range.getClientRects()` is the only thing on a page that
 * knows where a word's ink is. What this module owns is the part a browser cannot: which element a word
 * belongs to, whether a run of words is a phrase or an accident, and what a list of 4000 boxes adds up to.
 */

function word(overrides: Partial<RawWord> & { text: string }): RawWord {
  const rect: Rect = overrides.rect ?? { x: 0, y: 0, width: 20, height: 12 };
  return {
    rect,
    fragments: overrides.fragments ?? [rect],
    frameId: 'main',
    ownerBackendId: overrides.ownerBackendId ?? 'pf-1',
    ownerTag: overrides.ownerTag ?? 'p',
    ownerPath: overrides.ownerPath ?? 'html>body>p',
    start: overrides.start ?? 0,
    end: overrides.end ?? overrides.text.length,
    inViewport: overrides.inViewport ?? true,
    ...overrides,
    text: overrides.text,
  };
}

const OWNERS = [
  { identity: 'aaa11111', backendId: 'pf-1' },
  { identity: 'bbb22222', backendId: 'pf-7' },
];

describe('word rows', () => {
  it('join each word to the element the collector stamped', () => {
    const rows = buildWordRows({ words: [word({ text: 'quantum', ownerBackendId: 'pf-7' })] }, OWNERS);
    expect(rows[0]!.owner_identity).toBe('bbb22222');
    expect(rows[0]!.owner_backend_id).toBe('pf-7');
    expect(rows[0]!.centre).toEqual({ x: 10, y: 6 });
  });

  it('leaves the owner empty when nothing was stamped, instead of guessing an ancestor', () => {
    // Past the collector's cap, or inside a subtree it skipped, a word has no measured owner. Reporting a
    // nearby element as the owner would attach text to something that never contained it.
    const rows = buildWordRows({ words: [word({ text: 'orphan', ownerBackendId: null })] }, OWNERS);
    expect(rows[0]!.owner_backend_id).toBeNull();
    expect(rows[0]!.owner_identity).toBeNull();
  });

  it('numbers words by position, so an identical word twice is two rows', () => {
    const rows = buildWordRows({ words: [word({ text: 'the' }), word({ text: 'the', start: 10, end: 13 })] }, OWNERS);
    expect(rows.map((r) => r.index)).toEqual([1, 2]);
    expect(rows.map((r) => r.chars)).toEqual([
      [0, 3],
      [10, 13],
    ]);
  });
});

describe('phrase boxes', () => {
  const sentence = buildWordRows(
    {
      words: [
        word({ text: 'The', start: 0, rect: { x: 10, y: 100, width: 30, height: 14 } }),
        word({ text: 'quantum', start: 4, rect: { x: 44, y: 100, width: 60, height: 14 } }),
        word({ text: 'treatise', start: 12, rect: { x: 108, y: 100, width: 62, height: 14 } }),
      ],
    },
    OWNERS,
  );

  it('returns the box around the whole run, not around its first word', () => {
    const hit = findPhrase(sentence, 'quantum treatise');
    expect(hit).not.toBeNull();
    expect(hit!.rect).toEqual({ x: 44, y: 100, width: 126, height: 14 });
    expect(hit!.from).toBe(2);
    expect(hit!.to).toBe(3);
  });

  it('does not match a phrase assembled out of two different elements', () => {
    // "treatise" ends one paragraph and the next paragraph opens with the same word. Read as a sequence of
    // boxes that is a match; read as language it is nothing, and a caller who boxed it would annotate a
    // rectangle spanning two unrelated blocks.
    const mixed = buildWordRows(
      {
        words: [word({ text: 'alpha', ownerBackendId: 'pf-1' }), word({ text: 'beta', ownerBackendId: 'pf-7' })],
      },
      OWNERS,
    );
    expect(findPhrase(mixed, 'alpha beta')).toBeNull();
  });

  it('counts every occurrence and returns the first in document order', () => {
    const twice = buildWordRows(
      {
        words: [
          word({ text: 'no', start: 0 }),
          word({ text: 'way', start: 3, rect: { x: 0, y: 0, width: 30, height: 10 } }),
          word({ text: 'no', start: 7, rect: { x: 100, y: 200, width: 20, height: 10 } }),
          word({ text: 'way', start: 10, rect: { x: 124, y: 200, width: 30, height: 10 } }),
        ],
      },
      OWNERS,
    );
    const hit = findPhrase(twice, 'no way');
    expect(hit!.occurrences).toBe(2);
    expect(hit!.rect.y).toBe(0);
  });

  it('says when the phrase straddles a line break, because then its rect is a union', () => {
    const wrapped = buildWordRows(
      {
        words: [
          word({ text: 'hyph', rect: { x: 0, y: 10, width: 40, height: 12 } }),
          word({
            text: 'enated',
            rect: { x: 0, y: 40, width: 50, height: 12 },
            fragments: [
              { x: 200, y: 10, width: 40, height: 12 },
              { x: 0, y: 40, width: 50, height: 12 },
            ],
          }),
        ],
      },
      OWNERS,
    );
    const hit = findPhrase(wrapped, 'hyph enated');
    expect(hit!.wrapped).toBe(true);
    expect(hit!.fragments).toHaveLength(3);
  });

  it('is case insensitive on the word, and keeps the document spelling in the answer', () => {
    const hit = findPhrase(sentence, 'THE QUANTUM');
    expect(hit!.phrase).toBe('THE QUANTUM');
    expect(hit!.from).toBe(1);
  });
});

describe('regions and summaries', () => {
  const rows = buildWordRows(
    {
      words: [
        word({ text: 'see', rect: { x: 0, y: 0, width: 10, height: 10 }, inViewport: true }),
        word({ text: 'below', rect: { x: 0, y: 900, width: 40, height: 10 }, inViewport: false }),
        // Straddles the region border on purpose: overlap membership keeps it.
        word({ text: 'edge', rect: { x: 95, y: 5, width: 10, height: 10 } }),
      ],
    },
    OWNERS,
  );

  it('keeps a word that only partly overlaps the region', () => {
    const found = wordsInRect(rows, { x: 0, y: 0, width: 100, height: 20 });
    expect(found.map((r) => r.text)).toEqual(['see', 'edge']);
  });

  it('transcribes the words it was given, in the order measured', () => {
    expect(textOfWords(rows)).toBe('see below edge');
  });

  it('reports the counts a reader needs to judge the list', () => {
    const summary = summarizeWords(rows);
    expect(summary.words).toBe(3);
    expect(summary.in_viewport).toBe(2);
    expect(summary.owners).toBe(1);
    expect(summary.busiest[0]).toEqual({ owner_backend_id: 'pf-1', tag: 'p', count: 3 });
  });

  it('counts unowned words rather than dropping them from the total', () => {
    const withOrphan = rows.concat(buildWordRows({ words: [word({ text: 'loose', ownerBackendId: null })] }, OWNERS));
    const summary = summarizeWords(withOrphan);
    expect(summary.words).toBe(4);
    expect(summary.unowned).toBe(1);
  });
});
