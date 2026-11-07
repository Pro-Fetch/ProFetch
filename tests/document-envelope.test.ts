/**
 * The document envelope: an id that survives a re-read, and coordinates counted from the body.
 *
 * Everything here is derived from bytes we already hold, so every case below can be checked offline — and
 * every number has to be explainable by a line of the input. The point of the envelope is that a pipeline
 * can compare two reads without reading them; if a field in it were a guess, that comparison would be a
 * guess too.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/loader.js';
import { cache } from '../src/core/cache.js';
import { dispatch } from '../src/core/tool.js';
import {
  buildDocument,
  countCodeBlocks,
  countLinks,
  countTables,
  deriveTitle,
  documentId,
  extractHeadings,
  normalizeBody,
  revisionOf,
} from '../src/core/document.js';
import type { FetchResult } from '../src/core/fetcher.js';

const ARTICLE = [
  '# SQLite',
  '',
  'SQLite is a small, fast database engine.',
  '',
  '## Write ahead logging',
  '',
  'The WAL mode lets readers and one writer work at the same time.',
  '',
  '```sql',
  '# not a heading inside a code block',
  'PRAGMA journal_mode = WAL;',
  '```',
  '',
  '| mode | writer |',
  '| --- | --- |',
  '| delete | exclusive |',
  '| wal | one |',
  '',
  'See [the docs](https://sqlite.org/wal.html) and [WAL][ref].',
  '',
  '[ref]: https://sqlite.org/wal.html',
].join('\n');

function fetchResult(overrides: Partial<FetchResult> = {}): FetchResult {
  return {
    url: 'https://example.org/sqlite',
    status: 200,
    contentType: 'text/html',
    markdown: ARTICLE,
    tokens: 120,
    cached: false,
    truncated: false,
    blocked: null,
    method: 'http',
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  cache.clear();
});

describe('the content address', () => {
  it('is the same document when only the whitespace moved', () => {
    const reflowed = ARTICLE.replace('small, fast database', 'small,   fast   database').replace('## WAL', '## WAL');
    expect(documentId(reflowed)).toBe(documentId(ARTICLE));
    // and the exact revision does notice, which is why both fields exist
    expect(revisionOf(reflowed)).not.toBe(revisionOf(ARTICLE));
  });

  it('changes when the page says something different', () => {
    expect(documentId(ARTICLE + '\n\nA new paragraph.')).not.toBe(documentId(ARTICLE));
  });

  it('normalises line endings and trims, so a reader that re-wraps is not a new document', () => {
    expect(normalizeBody('a  b\r\nc\t\t d  ')).toBe('a b\nc d');
  });
});

describe('coordinates counted from the body', () => {
  it('reads the heading outline and ignores what only looks like a heading', () => {
    expect(extractHeadings(ARTICLE)).toEqual([
      { level: 1, text: 'SQLite' },
      { level: 2, text: 'Write ahead logging' },
    ]);
  });

  it('takes setext headings, and does not mistake a table separator or a rule after a blank line for one', () => {
    expect(extractHeadings('Title\n===\n\nBody')).toEqual([{ level: 1, text: 'Title' }]);
    expect(extractHeadings('Sub\n---\n\nBody')).toEqual([{ level: 2, text: 'Sub' }]);
    expect(extractHeadings('| a | b |\n| --- | --- |\n| 1 | 2 |')).toEqual([]);
    expect(extractHeadings('Text\n\n---\n\nMore')).toEqual([]);
  });

  it('counts links in both markdown forms', () => {
    expect(countLinks(ARTICLE)).toBe(2);
  });

  it('counts tables as tables, not as rows', () => {
    expect(countTables(ARTICLE)).toBe(1);
    const two = ARTICLE + '\n\n|x|y|\n|---|---|\n|1|2|\n|3|4|';
    expect(countTables(two)).toBe(2);
    // A pipe row without a separator row is a line of text, not a table.
    expect(countTables('| a | b |\n| c | d |')).toBe(0);
  });

  it('counts fenced blocks once each', () => {
    expect(countCodeBlocks(ARTICLE)).toBe(1);
    expect(countCodeBlocks('```\na\n```\n\ntext\n\n~~~\nb\n~~~')).toBe(2);
  });

  it('titles the document by what it calls itself', () => {
    expect(deriveTitle(ARTICLE, extractHeadings(ARTICLE))).toBe('SQLite');
    expect(deriveTitle('## Only a section', [{ level: 2, text: 'Only a section' }])).toBe('Only a section');
    expect(deriveTitle('plain body', [])).toBeNull();
  });
});

describe('the envelope', () => {
  const clock = () => new Date('2026-11-07T12:00:00.000Z');

  it('carries the coordinates, the provenance and the read time', () => {
    const document = buildDocument(fetchResult(), { now: clock });
    expect(document.document_id).toMatch(/^[0-9a-f]{16}$/);
    expect(document.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(document.host).toBe('example.org');
    expect(document.method).toBe('http');
    expect(document.fetched_at).toBe('2026-11-07T12:00:00.000Z');
    expect(document.title).toBe('SQLite');
    expect(document.headings).toHaveLength(2);
    expect(document.tables).toBe(1);
    expect(document.links).toBe(2);
    expect(document.code_blocks).toBe(1);
    expect(document.words).toBeGreaterThan(20);
    expect(document.characters).toBe(ARTICLE.length);
  });

  it('does not claim a browser ran when none did', () => {
    const plain = buildDocument(fetchResult());
    expect(plain.escalation_reason).toBeUndefined();
    expect(plain.browser_ms).toBeUndefined();
    expect(plain.resources_blocked).toBeUndefined();
    const rendered = buildDocument(
      fetchResult({
        method: 'browser',
        escalation_reason: '4 words came back with 2 script tag(s)',
        browser_ms: 1492,
        resources_blocked: 1,
      }),
    );
    expect(rendered.method).toBe('browser');
    expect(rendered.browser_ms).toBe(1492);
    expect(rendered.resources_blocked).toBe(1);
    expect(rendered.escalation_reason).toContain('script tag');
  });

  it('names the refusal kind without dressing it up as a document', () => {
    const blocked = buildDocument(
      fetchResult({
        status: 403,
        markdown: 'Attention Required!',
        blocked: { kind: 'cloudflare_challenge', marker: 'm', hint: 'h' },
      }),
    );
    expect(blocked.blocked_kind).toBe('cloudflare_challenge');
    expect(blocked.method).toBe('http');
  });
});

describe('pro_fetch_document', () => {
  const url = 'http://93.184.216.34/document-envelope';

  function stubBody(body: string): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })),
    );
  }

  function payload(result: Awaited<ReturnType<typeof dispatch>>): Record<string, any> {
    const text = (result.content ?? []).map((item: { text?: string }) => item.text ?? '').join('\n');
    const match = /```json\n([\s\S]*?)\n```/.exec(text);
    return JSON.parse(match ? match[1] : text);
  }

  it('returns the envelope with the body attached', async () => {
    stubBody('<html><body><h1>SQLite</h1><p>' + ARTICLE.replace(/[`|]/g, ' ') + '</p></body></html>');
    const body = payload(await dispatch('pro_fetch_document', { url }));
    expect(body.document_id).toMatch(/^[0-9a-f]{16}$/);
    expect(typeof body.markdown).toBe('string');
    // The id is the body: recomputing it from the text the tool returned must agree with the tool.
    expect(body.document_id).toBe(documentId(body.markdown));
    expect(body.fetched_at).toMatch(/Z$/);
    expect(body.method).toBe('http');
  });

  it('leaves the body out when the caller only routes on coordinates', async () => {
    stubBody('<html><body><h1>SQLite</h1><p>Some readable text here.</p></body></html>');
    const lean = payload(await dispatch('pro_fetch_document', { url, include_body: false }));
    const full = payload(await dispatch('pro_fetch_document', { url }));
    expect(lean.markdown).toBeUndefined();
    expect(Array.isArray(lean.headings)).toBe(true);
    expect(lean.document_id).toMatch(/^[0-9a-f]{16}$/);
    // Same page, same id — whether or not the caller asked for the body.
    expect(lean.document_id).toBe(full.document_id);
  });

  it('gives the same id for the same page read twice, and a different one when it changed', async () => {
    stubBody('<html><body><h1>Stable</h1><p>Identical body text.</p></body></html>');
    const first = payload(await dispatch('pro_fetch_document', { url: url + '-stable', include_body: false }));
    const second = payload(await dispatch('pro_fetch_document', { url: url + '-stable', include_body: false }));
    expect(second.document_id).toBe(first.document_id);
    stubBody('<html><body><h1>Stable</h1><p>Changed body text.</p></body></html>');
    cache.clear();
    const third = payload(await dispatch('pro_fetch_document', { url: url + '-stable', include_body: false }));
    expect(third.document_id).not.toBe(first.document_id);
  });
});
