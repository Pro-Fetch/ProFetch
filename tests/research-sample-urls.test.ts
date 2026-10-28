/**
 * URL samples handed back from a provider's text answer.
 *
 * The provider body is JSON-ish, so a raw match leaves an escaped quote and a comma glued to the end
 * of the URL — a link that does not open. Seen live, twice, in one multi-language answer.
 */

import { describe, it, expect } from 'vitest';
import '../src/loader.js';
import { sampleUrlsFrom } from '../src/core/research-tools.js';

describe('sampleUrlsFrom', () => {
  it('drops the escaped quote and comma the provider body leaves attached', () => {
    const body = 'a https://uz.wikipedia.org/wiki/Kvant_kompyuterlari\\", b https://example.com/x\\",';
    expect(sampleUrlsFrom(body)).toEqual([
      'https://uz.wikipedia.org/wiki/Kvant_kompyuterlari',
      'https://example.com/x',
    ]);
  });

  it('keeps a normal markdown-style link intact', () => {
    expect(sampleUrlsFrom('[x](https://example.com/a)')).toEqual(['https://example.com/a']);
  });

  it('caps at three and ignores text without links', () => {
    expect(sampleUrlsFrom('no links here')).toEqual([]);
    const many = ['1', '2', '3', '4'].map((n) => 'https://e.test/' + n).join(' ');
    expect(sampleUrlsFrom(many)).toHaveLength(3);
  });
});
