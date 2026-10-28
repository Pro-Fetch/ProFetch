/**
 * What `pro_fetch_wayback_lookup` means when archive.org answers.
 *
 * The old handler piped the body straight into a parse with a `'{}'` default, so a throttling page and
 * a genuinely unarchived URL produced the same answer — "no snapshot". An ops host reported that as
 * "CDX HTML qaytardi — eski nusxa yo'q" and had no way to know whether to retry.
 */

import { describe, it, expect } from 'vitest';
import { interpretWayback } from '../src/tools/archive/wayback_lookup.js';
import { parseUpstreamJson } from '../src/core/json-response.js';

describe('interpretWayback', () => {
  it('reports a found snapshot plainly', () => {
    const out = interpretWayback('example.com', {
      url: 'example.com',
      archived_snapshots: {
        closest: { url: 'https://web.archive.org/2020/x', timestamp: '20200101120000', status: '200' },
      },
    });
    expect(out.payload).toMatchObject({ available: true, timestamp: '20200101120000' });
  });

  it('says "no snapshot" only when the API really says so', () => {
    const out = interpretWayback('example.com', { url: 'example.com', archived_snapshots: {} });
    expect(out.payload).toMatchObject({ available: false });
    expect(String(out.payload.note)).toContain('nusxa topilmadi');
  });

  it('treats a missing archived_snapshots key as no snapshot, not as data to guess at', () => {
    expect(interpretWayback('example.com', {}).payload).toMatchObject({ available: false });
  });
});

describe('the decode the handler relies on', () => {
  it('names the provider when a 200 carries an HTML block page', () => {
    // The case that used to look like "no archive exists".
    const thrown = (() => {
      try {
        parseUpstreamJson(
          { status: 200, contentType: 'text/html; charset=utf-8', text: '<html>Too Many Requests</html>' },
          'Wayback availability API',
        );
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(thrown).toContain('Wayback availability API');
    expect(thrown).toContain('JSON emas');
    expect(thrown).toContain('text/html');
  });
});
