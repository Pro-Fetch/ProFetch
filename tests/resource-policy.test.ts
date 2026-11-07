/**
 * What a text reader is allowed to refuse, and what it must not.
 *
 * The line this file draws is between *slow* and *different*: refusing an image changes how long a read
 * takes, while refusing a script or a stylesheet can change what the page says at all. Those two are not the
 * same kind of knob, and a policy that treats them alike will eventually ship a reader that quietly returns
 * less of the page than the caller asked for.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  CONTENT_BEARING,
  READER_DEFAULT_BLOCK,
  blockSummary,
  parseBlockKinds,
  readerBlockSetting,
  shouldBlock,
} from '../src/core/resource-policy.js';

afterEach(() => {
  delete process.env.PRO_FETCH_BLOCK_RESOURCES;
});

describe('the reader default', () => {
  it('names only kinds a text read cannot use', () => {
    expect(READER_DEFAULT_BLOCK).toEqual(['image', 'media', 'font']);
    for (const kind of READER_DEFAULT_BLOCK) expect(CONTENT_BEARING).not.toContain(kind);
  });

  it('is what an unset variable produces, and an operator can replace or switch it off', () => {
    expect(readerBlockSetting()).toBe('image,media,font');
    process.env.PRO_FETCH_BLOCK_RESOURCES = 'image';
    expect(readerBlockSetting()).toBe('image');
    process.env.PRO_FETCH_BLOCK_RESOURCES = 'none';
    expect(parseBlockKinds(readerBlockSetting()).kinds.size).toBe(0);
  });
});

describe('parsing the list', () => {
  it('accepts names, ignores spacing and case, and refuses to guess at unknown ones', () => {
    const parsed = parseBlockKinds(' Image , media ,notakind ');
    expect(parsed.kinds).toEqual(new Set(['image', 'media']));
    expect(parsed.rejected).toEqual(['notakind']);
  });

  it('takes an array as readily as a comma string', () => {
    expect(parseBlockKinds(['image', 'font']).kinds).toEqual(new Set(['image', 'font']));
  });

  it('reads none, off and false as "block nothing" rather than as a kind', () => {
    for (const value of ['none', 'off', 'false', 'NONE']) expect(parseBlockKinds(value).kinds.size).toBe(0);
    expect(parseBlockKinds(undefined).kinds.size).toBe(0);
    expect(parseBlockKinds('').kinds.size).toBe(0);
  });

  it('says in one line what was refused', () => {
    expect(blockSummary(parseBlockKinds('font,image').kinds)).toBe('font, image');
    expect(blockSummary(new Set())).toContain('bloklanmadi');
  });
});

describe('the decision itself', () => {
  it('never refuses the document, even when an operator lists it', () => {
    const listed = parseBlockKinds('document,image');
    expect(shouldBlock('document', listed.kinds)).toBe(false);
    expect(shouldBlock('image', listed.kinds)).toBe(true);
  });

  it('honours a deliberate decision about content-bearing kinds, because the operator named them', () => {
    const scripts = parseBlockKinds('script,xhr');
    expect(shouldBlock('script', scripts.kinds)).toBe(true);
    expect(shouldBlock('fetch', scripts.kinds)).toBe(false);
  });

  it('blocks nothing at all when the set is empty', () => {
    for (const kind of ['image', 'media', 'font', 'script', 'stylesheet']) {
      expect(shouldBlock(kind, new Set())).toBe(false);
    }
  });
});
