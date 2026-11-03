import { describe, it, expect } from 'vitest';
import { COLLECTOR_SCRIPT } from '../src/core/browser-use-collector.js';
import { WORD_SCRIPT, MAX_WORDS } from '../src/core/browser-use-words.js';
import { HOP_SCRIPT, GEOMETRY_SCRIPT } from '../src/core/browser-use-session.js';
import { PAGE_META_SCRIPT } from '../src/core/browser-use-health.js';

/**
 * Every script this engine evaluates inside a page.
 *
 * These are strings, because that is what `page.evaluate` takes, and a string that is built as a template
 * literal dies on a backtick inside it — silently, at build time in the sense that nothing notices, and
 * loudly at runtime in the sense that the page returns a syntax error and every tool that reads the page
 * fails at once. Two separate bugs in this engine were exactly that: a comment containing a backtick, in a
 * collector and then again in a page-eval. A unit test of the merge logic cannot see either of them, because
 * the merge never parses the script.
 *
 * So the scripts themselves are the thing under test here: they must be syntactically complete expressions,
 * and they must not contain the character that breaks the literal they live in.
 */
const SCRIPTS: Array<[name: string, source: string]> = [
  ['COLLECTOR_SCRIPT', COLLECTOR_SCRIPT],
  ['WORD_SCRIPT', WORD_SCRIPT],
  ['HOP_SCRIPT', HOP_SCRIPT],
  ['GEOMETRY_SCRIPT', GEOMETRY_SCRIPT],
  ['PAGE_META_SCRIPT', PAGE_META_SCRIPT],
];

describe('in-page scripts survive being strings', () => {
  it.each(SCRIPTS)('%s contains no backtick, which would end the template literal early', (_name, source) => {
    expect(source).not.toContain('`');
  });

  it.each(SCRIPTS)('%s contains no unescaped interpolation left in the source', (_name, source) => {
    // A leftover `${` means someone wrote an interpolation that the outer template consumed at build time
    // and a reader of the script now sees as literal text in the page.
    expect(source).not.toContain('${');
  });

  it.each(SCRIPTS)('%s parses as a single JavaScript expression', (_name, source) => {
    // Compiling is the check. Running would need a DOM, and every script here is an immediately invoked
    // expression, so `new Function` proves the syntax without executing anything.
    expect(() => new Function(`return (${source});`)).not.toThrow();
  });

  it('the collector is the one that stamps the ids the word map joins on', () => {
    // The two scripts are coupled by an attribute name, not by an import. If one changes, the join between
    // a word and its element stops working, and the failure looks like "this page has no text owners".
    expect(COLLECTOR_SCRIPT).toContain('data-pf-id');
    expect(WORD_SCRIPT).toContain('data-pf-id');
  });

  it('the word cap in the source is the exported constant, not a second number someone kept in sync', () => {
    expect(WORD_SCRIPT).toContain(`const MAX = ${MAX_WORDS};`);
  });
});
