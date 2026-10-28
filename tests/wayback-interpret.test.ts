/**
 * What `pro_fetch_wayback_lookup` says when archive.org answers oddly.
 *
 * The old handler piped the body straight into `JSON.parse`, so a throttling page became an
 * exception and a genuinely-absent snapshot became an opaque blob. A host could not tell "no archive
 * exists" from "we were blocked" — the difference that decides whether to retry at all.
 */

import { describe, it, expect } from 'vitest';
import { interpretWayback } from '../src/tools/archive/wayback_lookup.js';

const hit = JSON.stringify({
  url: 'example.com',
  archived_snapshots: {
    closest: { url: 'https://web.archive.org/2020/x', timestamp: '20200101120000', status: '200' },
  },
});

describe('interpretWayback', () => {
  it('reports a found snapshot plainly', () => {
    const out = interpretWayback('example.com', 200, 'application/json', hit);
    expect(out.ok).toBe(true);
    expect(out.payload).toMatchObject({ available: true, timestamp: '20200101120000' });
  });

  it('says "no snapshot" when the API answers with an empty set', () => {
    const out = interpretWayback(
      'example.com',
      200,
      'application/json',
      JSON.stringify({ url: 'example.com', archived_snapshots: {} }),
    );
    expect(out.ok).toBe(true);
    expect(out.payload).toMatchObject({ available: false });
    expect(String(out.payload?.note)).toContain('nusxa topilmadi');
  });

  it('names a block page for what it is, without claiming the archive is empty', () => {
    const out = interpretWayback('example.com', 200, 'text/html', '<html><body>Too Many Requests</body></html>');
    expect(out.ok).toBe(false);
    expect(out.message).toContain('JSON emas');
    expect(out.message).toContain('throttling');
    // The old behaviour: this input threw a SyntaxError out of the tool call.
    expect(() => JSON.parse('<html>')).toThrow();
  });

  it('keeps an HTTP error separate from a parse problem', () => {
    const out = interpretWayback('example.com', 503, 'text/html', '<html>down</html>');
    expect(out.ok).toBe(false);
    expect(out.message).toContain('503');
  });

  it('survives a truncated JSON body', () => {
    const out = interpretWayback('example.com', 200, 'application/json', '{"archived_snapshots": ');
    expect(out.ok).toBe(false);
    expect(out.message).toContain("o'qilmadi");
  });
});
