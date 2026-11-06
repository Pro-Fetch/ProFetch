// Open-data tools, tested against the real Socrata endpoints.
//
// Every endpoint here was probed before the code was written, and four assumptions were wrong. Those
// probes are the offline half of this file; the live calls below assert the behaviour the code
// depends on, so a change upstream that breaks one of them fails loudly instead of returning an
// empty result that looks like "no data".

import { describe, it, expect, type TestContext } from 'vitest';
import '../src/loader.js';
import { callTool } from '../src/router.js';
import { htmlInsteadOfJson, isDatasetId, parseReference, soqlIdentifier } from '../src/tools/opendata/_opendata.js';
import type { ToolResult } from '../src/core/types.js';
import { hostReachable } from './helpers/liveGate.js';

function payload(result: ToolResult): Record<string, never> {
  const text = (result.content ?? [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text ?? '')
    .join('\n');
  const match = /```json\n([\s\S]*?)\n```/.exec(text);
  return match ? (JSON.parse(match[1]) as Record<string, never>) : ({} as Record<string, never>);
}

/**
 * Which refusals belong to the portal rather than to this code.
 *
 * A tool now reports an upstream refusal as a failed operation (`isError`), because a caller paying per
 * request must not read "nothing was fetched" as success. That makes `isError` too coarse a retry
 * trigger: `No such column: yoqoq_ustun` is a refusal this repo produced on purpose, and a test that
 * asserts on it would be retried three times and then reported as an unavailable endpoint.
 *
 * So the reason decides. Throttling, a 5xx, HTML where JSON was asked for, an id the catalog no longer
 * lists and a network fault are the portal's or the network's — retried, and named when they persist.
 * A 4xx that describes the query is ours, and goes straight to the assertion that judges it.
 */
function transientRefusal(data: Record<string, any>): string | null {
  const error = typeof data.error === 'string' ? data.error : '';
  if (!error) return null;
  if (data.rate_limited === true || /HTTP 429/.test(error)) return 'portal so‘rovni chegaraladi (HTTP 429)';
  if (/HTTP 5\d\d/.test(error)) return `portal ichida xato (HTTP ${/HTTP (\d{3})/.exec(error)?.[1]})`;
  if (/HTTP 40[0-8]/.test(error)) return null;
  if (/HTML qaytadi|portal ma’lumot API/i.test(error)) return 'portal JSON o‘rniga HTML berdi';
  // `domen topilmadi` is deliberately NOT here: it is the answer one test asserts on for an id the
  // catalog does not list, and a helper that retried it away would delete that assertion's subject.
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|socket hang up|timeout/i.test(error)) {
    return 'portalga yetib borilmadi (tarmoq)';
  }
  return null;
}

/**
 * Call a tool that needs the real endpoint, retrying before giving up.
 *
 * These assertions run against Socrata, and a portal that is slow or rate-limiting answers with nothing,
 * which looks exactly like "this dataset has no such column". Measured: `pro_opendata_columns` with
 * `column: 'license_type'` returned `profiled: 0` on one run and the correct payload seconds later with
 * no code change at all. A test that reports that as a product failure is lying about which side broke,
 * so the endpoint is retried, and if it never answers the failure says so by name.
 *
 * The retry condition is **transport-level**, not content-level: a call is retried only when the tool
 * reported a failure, and an empty-but-successful payload is passed straight through so the assertion
 * below reports what it actually received. Two earlier versions got this wrong in opposite directions -
 * one required a non-empty array and rejected every valid `search` response, turning 17 passing tests
 * into failures; the next rejected `pro_opendata_dataset`, which legitimately answers with scalars
 * (`columns_total`, `view_type`) and no arrays at all. A guard for flakiness must not itself be wrong
 * twice.
 *
 * It returns the `ToolResult`, not the payload, because the call sites read `result.isError` as well as
 * the body. An earlier version returned the payload, so every `payload(result)` became `payload({})`.
 *
 * This is not a way to make a flaky test pass: the retry window is short, and a genuine regression - a
 * malformed SoQL query, a wrong URL, a broken parser - fails on every attempt.
 */
async function liveTool(name: string, input: Record<string, unknown>, attempts = 3): Promise<ToolResult> {
  let last: ToolResult = { content: [] };
  let lastData = {} as Record<string, never>;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await callTool(name, input);
    lastData = payload(last) as Record<string, any>;
    const refusal = transientRefusal(lastData);
    // A refusal this repo caused is content: the assertion below is what should judge it, and retrying it
    // would report a correct 400 as an unavailable endpoint.
    if (refusal === null && Object.keys(lastData).length > 0) return last;
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 700 * attempt));
  }
  throw new Error(
    `LIVE_ENDPOINT_UNAVAILABLE: ${name} ga Socrata ${attempts} marta urunildi, javob kelmadi. ` +
      `Oxirgi javob: ${JSON.stringify(lastData).slice(0, 300)}. Bu mahsulot nuqsoni emas - portal javob bermadi.`,
  );
}

/**
 * A live call whose claim depends on the portal answering at all.
 *
 * Two of these assertions were measured failing across runners with the same commit and the same code,
 * in both shapes a moody portal produces: an error body, and HTTP 200 with `[]` for a group-by over a
 * dataset that holds 105,003 rows. Neither is a statement about this repo. What is a statement about
 * this repo is that it must not present either as "no data", so the call is retried, a persistent
 * portal-side refusal stops that one measurement by name, and an empty answer has to arrive labelled
 * as empty — which is asserted at the call site, not here.
 *
 * A regression still fails: a broken parser or a renamed field produces the same answer on every
 * attempt, no `transientRefusal` reason matches it, and the throw says which side broke.
 */
async function liveAnswer(
  name: string,
  input: Record<string, unknown>,
  context: TestContext,
  options: { attempts?: number; require?: string } = {},
): Promise<Record<string, any>> {
  const attempts = options.attempts ?? 3;
  let data = {} as Record<string, any>;
  let reason: string | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    data = payload(await callTool(name, input)) as Record<string, any>;
    reason = transientRefusal(data);
    const missing = options.require !== undefined && data[options.require] === undefined;
    if (reason === null && !missing) return data;
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 700 * attempt));
  }
  if (reason !== null) context.skip(`${name}: ${reason} — ${attempts} urinishda ham portal javob bermadi`);
  throw new Error(
    `LIVE_ENDPOINT_UNAVAILABLE: ${name} ${attempts} urinishda ham "${options.require ?? 'javob'}" maydonini ` +
      `qaytarmadi, va bu portal rad javobi emas. Oxirgi javob: ${JSON.stringify(data).slice(0, 300)}.`,
  );
}

/**
 * One probe decides whether the live blocks below can mean anything this run. The portal answering
 * with a 404 or an HTML page is a product question and still fails; not reaching it at all is a
 * network fact, and reporting that as a test failure is what made the build lie about itself.
 */
const portalReachable = await hostReachable('https://api.us.socrata.com/api/catalog/v1?limit=1&q=traffic');
if (!portalReachable)
  console.warn('LIVE SKIPPED: Socrata catalog endpointga yetib borilmadi (tarmoq), mahsulot xatosi emas.');

describe('dataset references', () => {
  it('accepts an id, a permalink and a SODA URL alike', () => {
    // Every public link on these portals contains the id, and three different shapes are what a
    // caller actually pastes.
    expect(parseReference('8wbx-tsch')).toEqual({ id: '8wbx-tsch', domain: '' });
    expect(parseReference('https://data.cityofnewyork.us/d/8wbx-tsch')).toEqual({
      id: '8wbx-tsch',
      domain: 'data.cityofnewyork.us',
    });
    expect(parseReference('data.cityofnewyork.us/resource/8wbx-tsch.json?$limit=5')).toEqual({
      id: '8wbx-tsch',
      domain: 'data.cityofnewyork.us',
    });
  });

  it('rejects a reference with no id at all, whatever the host', () => {
    expect(parseReference('https://evil.example.com/d/8wbx-tsch')).toEqual({
      id: '8wbx-tsch',
      domain: 'evil.example.com',
    });
    expect(parseReference('traffic accidents')).toEqual({ error: expect.stringContaining('topilmadi') });
  });

  it('takes the host from a real .us portal, which a .gov-only rule rejected', () => {
    // `data.cityofnewyork.us` is one of the largest portals on the network and was being thrown away
    // by a `.gov` test. The safety now comes from the catalog, not from the suffix.
    expect(parseReference('https://data.cityofnewyork.us/d/8wbx-tsch').domain).toBe('data.cityofnewyork.us');
    expect(parseReference('8wbx-tsch').domain).toBe('');
  });

  it('ignores a host with credentials, a port or path characters', () => {
    // Shape check, not a security boundary - but a URL with a userinfo section should never become a
    // request target, and it costs one pattern to refuse it here.
    expect(parseReference('https://user:pass@evil.example.com/d/8wbx-tsch').domain).toBe('');
    expect(parseReference('8wbx-tsch#a/../../b').domain).toBe('');
  });

  it('prefers the catalog’s domain over one typed in the input', async () => {
    // The catalog is the authority on which portal owns an id. A wrong host in a pasted link is a
    // common typo, and following it would 404 or - worse - read a different dataset.
    const data = payload(
      await callTool('pro_opendata_dataset', {
        dataset: 'https://data.fortworthtexas.gov/d/8wbx-tsch',
      }),
    );
    expect(data.domain).toBe('data.cityofnewyork.us');
  });

  it('says so when there is no id at all, rather than guessing', () => {
    expect(parseReference('traffic accidents')).toEqual({
      error: expect.stringContaining('topilmadi'),
    });
    expect(parseReference('')).toEqual({ error: expect.any(String) });
  });

  it('recognises the id shape', () => {
    expect(isDatasetId('8wbx-tsch')).toBe(true);
    expect(isDatasetId('8WBX-TSCH')).toBe(true);
    expect(isDatasetId('not-an-id')).toBe(false);
    expect(isDatasetId('8wbx-tsch-extra')).toBe(false);
  });
});

describe('SoQL identifiers', () => {
  it('quotes a name that needs quoting', () => {
    // Column names are written by people and contain spaces and punctuation regularly.
    expect(soqlIdentifier('license_type')).toBe('license_type');
    expect(soqlIdentifier('Creation Time')).toBe('`Creation Time`');
    expect(soqlIdentifier('we`ird')).toBe('`weird`');
  });
});

describe('an HTML answer is recognised as one', () => {
  // Whether a portal exposes its data API is that portal's decision — `data.fortworthtexas.gov` moved
  // its hub to ArcGIS and now redirects the SODA path to an HTML page. What must not depend on that is
  // how this code reads the answer, so the rule is pinned here against the bodies actually measured,
  // and the live block below asserts only the guarantee that holds whichever way the portal answers.
  it('trusts the content type', () => {
    expect(htmlInsteadOfJson('text/html; charset=utf-8', '<!DOCTYPE html><html>')).toBe(true);
    expect(htmlInsteadOfJson('application/json; charset=utf-8', '[{"license_type":"TRUCK"}]')).toBe(false);
  });

  it('trusts the body when the header says nothing', () => {
    // A proxy that drops the content type must not turn a web page into parsable JSON.
    expect(htmlInsteadOfJson('', '<!doctype html>\n<html>')).toBe(true);
    expect(htmlInsteadOfJson('text/plain', '   <HTML><body>Request blocked</body></html>')).toBe(true);
  });

  it('does not call a redirect stub or an empty body a web page', () => {
    // `302` with `text/plain` is what the ArcGIS migration answers before the hop. It is not HTML, and
    // the caller still gets a named decode failure rather than an empty result — see the live block.
    expect(htmlInsteadOfJson('text/plain', 'Found. Redirecting to https://hub.arcgis.com/legacy')).toBe(false);
    expect(htmlInsteadOfJson('application/json', '')).toBe(false);
  });
});

describe('a refusal is a failed call, not an empty success', () => {
  // The half of this that costs money: `dispatch` derives `structuredContent.ok` from the failure flag, so
  // a tool that answers a refusal with `jsonBlock` tells a paying caller the call succeeded. It is also
  // what made two CI assertions crash instead of reporting — they reached for `rows.length` on a body that
  // had carried `error` all along.
  it('refuses a reference with no id as a failure, on every tool that reads one', async () => {
    for (const name of ['pro_opendata_rows', 'pro_opendata_count', 'pro_opendata_columns', 'pro_opendata_dataset']) {
      const result = await callTool(name, { dataset: 'traffic accidents' });
      expect(result.isError, `${name} answered a reference with no id as success`).toBe(true);
      const data = payload(result) as Record<string, any>;
      expect(String(data.error), `${name} failed without saying why`).toEqual(expect.stringContaining('topilmadi'));
    }
  });
});

describe.skipIf(!portalReachable)('live: catalog search', () => {
  it('returns datasets with a domain and an id', async (context) => {
    const data = await liveAnswer('pro_opendata_search', { query: 'traffic accident', limit: 5 }, context);
    expect(data.error, JSON.stringify(data).slice(0, 300)).toBeUndefined();
    expect((data.results as unknown as unknown[]).length).toBeGreaterThan(0);
    const first = (data.results as unknown as Array<Record<string, string>>)[0];
    expect(first.id).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}$/);
    expect(first.domain.length).toBeGreaterThan(0);
  });

  it('reports the catalog total rather than the page length', async (context) => {
    // Falling back to the page length would say "3 results" for a catalog of 920.
    const data = await liveAnswer('pro_opendata_search', { domain: 'data.cityofnewyork.us', limit: 2 }, context);
    expect(typeof data.total).toBe('number');
    expect(data.returned).toBe(2);
  });

  it('explains that a search with neither query nor domain is incomplete', async () => {
    // The schema now declares `anyOf: [query, domain]`, so the central guard refuses the call before the
    // handler runs. That is the better place for it: a refusal that comes from the published contract
    // rather than from a handler that happens to check.
    // `callTool`, not `liveTool`: a refusal is the expected answer here, and the retry helper
    // treats a refusal as "the endpoint did not answer" and eventually throws.
    const result = await callTool('pro_opendata_search', {});
    expect(result.isError).toBeTruthy();
    const body = (result.content ?? []).map((item) => (item.type === 'text' ? item.text : '')).join(' ');
    expect(body).toMatch(/query/);
  });
});

describe.skipIf(!portalReachable)('live: resolving an id to a domain', () => {
  it('finds the dataset from a bare id', async (context) => {
    // `?q=<id>` returns nothing - measured on four URL variations - so this depends entirely on the
    // `?ids=` parameter. If that ever stops working, this test is the one that says so.
    const data = await liveAnswer('pro_opendata_dataset', { dataset: '8wbx-tsch' }, context);
    expect(data.error).toBeUndefined();
    expect(data.domain).toBe('data.cityofnewyork.us');
    expect(data.columns_total).toBeGreaterThan(5);
  });

  it('does not invent a row count it was never told', async (context) => {
    // `rowsUpdatedAt` is a timestamp and `viewCount` is page views. Printing either under
    // `row_count` reads as a row total and is wrong.
    const data = await liveAnswer('pro_opendata_dataset', { dataset: '8wbx-tsch' }, context);
    expect('row_count' in data).toBe(false);
    expect(data.row_count_hint).toEqual(expect.stringContaining('pro_opendata_count'));
  });

  it('reports an unknown id as unknown', async () => {
    const data = payload(await liveTool('pro_opendata_dataset', { dataset: 'aaaa-bbbb' }));
    expect(data.error).toEqual(expect.stringContaining('aaaa-bbbb'));
  });
});

describe.skipIf(!portalReachable)('live: rows through SODA', () => {
  it('returns rows and the fields present', async (context) => {
    const data = await liveAnswer('pro_opendata_rows', { dataset: '8wbx-tsch', limit: 3 }, context);
    expect(data.count).toBe(3);
    expect((data.fields as unknown as string[]).length).toBeGreaterThan(3);
  });

  it('honours $select', async (context) => {
    // The portal was measured answering this with no `fields` at all on one runner while the same
    // commit passed on another; `liveAnswer` retries that absence and names it if it never lifts.
    const data = await liveAnswer(
      'pro_opendata_rows',
      { dataset: '8wbx-tsch', limit: 2, select: 'license_type,vehicle_license_number' },
      context,
      { require: 'fields' },
    );
    expect(data.fields).toEqual(['license_type', 'vehicle_license_number']);
  });

  it('passes the provider message through for a column that does not exist', async () => {
    // The provider says "No such column: yoqoq_ustun", which names the mistake better than anything
    // this code could compose.
    const data = payload(
      await liveTool('pro_opendata_rows', { dataset: '8wbx-tsch', limit: 2, select: 'yoqoq_ustun' }),
    );
    expect(data.error).toMatch(/no-such-column|No such column|column/i);
  });

  it('says "no rows" rather than failing when a filter matches nothing', async (context) => {
    const data = await liveAnswer(
      'pro_opendata_rows',
      { dataset: '8wbx-tsch', limit: 2, where: "license_type='BuQiYoqShart'" },
      context,
    );
    expect(data.count).toBe(0);
    expect(data.rows).toEqual([]);
  });

  it('never reports a portal that will not hand over rows as "no rows matched"', async (context) => {
    // data.fortworthtexas.gov answers the SODA path with a web page (it redirects to
    // hub.arcgis.com/legacy). Whether it keeps doing so is the portal's business — an earlier version
    // of this test asserted the flag itself and failed once on a run where the product was correct and
    // the portal had simply answered differently. What has to hold whichever way it answers is this:
    // the dataset has rows, so an empty result is a lie, and any error names which kind it is.
    //
    // `callTool`, not a retry helper: the refusal is what this test is about, and a helper that treats a
    // refusal as "the endpoint never answered" would throw away the very answer being asserted.
    const data = payload(await callTool('pro_opendata_rows', { dataset: 'eax3-qev8', limit: 2 }));
    const error = data.error as unknown as string | undefined;
    if (typeof error === 'string' && error.includes('domen topilmadi')) {
      // The catalog did not resolve the id on this call. Third-party availability, reported by name.
      context.skip();
      return;
    }
    const rows = data.rows as unknown as unknown[] | undefined;
    const silentEmpty = (data.count as unknown as number | undefined) === 0 && Array.isArray(rows) && rows.length === 0;
    expect(
      silentEmpty,
      `Portal HTML qaytargan holatda "mos qator topilmadi" deb javob berildi: ${JSON.stringify(data).slice(0, 200)}`,
    ).toBe(false);
    if (error !== undefined) expect(typeof data.portal_without_data_api).toBe('boolean');
  });
});

describe.skipIf(!portalReachable)('live: aggregates', () => {
  it('returns the row total as a number', async (context) => {
    // SoQL returns every aggregate as a string, `{"count":"104900"}` included.
    const data = await liveAnswer('pro_opendata_count', { dataset: '8wbx-tsch' }, context);
    expect(typeof data.total).toBe('number');
    expect(data.total as unknown as number).toBeGreaterThan(1000);
  });

  it('groups by a column', async (context) => {
    const data = await liveAnswer('pro_opendata_count', { dataset: '8wbx-tsch', group_by: 'license_type' }, context);
    // Measured on two runners in two shapes: `rows: []` for a dataset of 105,003 rows, and an error body
    // with no `rows` at all. Whether Socrata groups on a given second is the portal's business; that an
    // answer carrying no groups says so, instead of reading as "this column has no values", is ours.
    if (data.empty === true) {
      expect(data.dataset_rows, JSON.stringify(data).slice(0, 300)).not.toBeUndefined();
      if (typeof data.dataset_rows === 'number') expect(data.dataset_rows).toBeGreaterThan(0);
      expect(String(data.note).length, JSON.stringify(data).slice(0, 300)).toBeGreaterThan(0);
      return;
    }
    const rows = data.rows as unknown as Array<Record<string, unknown>>;
    expect(rows.length, JSON.stringify(data).slice(0, 300)).toBeGreaterThan(0);
    expect(typeof rows[0].count).toBe('number');
  });

  it('labels an aggregate that returned nothing, with the row total measured under the same filter', async (context) => {
    // The empty answer has to say which kind of empty it is, and the only honest way to know is to ask the
    // portal for the total with the same filter applied. Zero here is measured, not assumed.
    const data = await liveAnswer(
      'pro_opendata_count',
      { dataset: '8wbx-tsch', group_by: 'license_type', where: "license_type='BuQiYoqShart'" },
      context,
    );
    expect(data.empty).toBe(true);
    expect(data.rows).toEqual([]);
    expect(data.dataset_rows).toBe(0);
    expect(String(data.note)).toContain('portal xatosi emas');
  });

  it('documents the flattened aggregate names it produces', async (context) => {
    // Measured: SoQL returns `min_vehicle_license_number`, not `min(vehicle_license_number)`.
    const data = await liveAnswer(
      'pro_opendata_count',
      { dataset: '8wbx-tsch', min: 'vehicle_license_number', max: 'vehicle_license_number' },
      context,
      { require: 'column_naming' },
    );
    expect(data.column_naming).toEqual(expect.stringContaining('min_ustun'));
    expect('min_vehicle_license_number' in ((data.rows as unknown[])[0] as object)).toBe(true);
  });
});

describe.skipIf(!portalReachable)('live: column profiling', () => {
  it('lists columns without querying when asked to', async (context) => {
    const data = await liveAnswer('pro_opendata_columns', { dataset: '8wbx-tsch', only_list: true, limit: 4 }, context);
    expect(data.columns).toHaveLength(4);
    expect(data.profiled).toBeUndefined();
  });

  it('profiles one column and reports its most frequent values', async (context) => {
    const data = await liveAnswer(
      'pro_opendata_columns',
      { dataset: '8wbx-tsch', column: 'license_type', top: 3 },
      context,
    );
    expect(data.profiled).toBe(1);
    const first = (data.columns as unknown as Array<Record<string, unknown>>)[0];
    expect(first.field_name).toBe('license_type');
    expect((first.top_values as unknown[]).length).toBeGreaterThan(0);
  });

  it('lists the available names when the requested column is absent', async () => {
    const data = payload(await liveTool('pro_opendata_columns', { dataset: '8wbx-tsch', column: 'yoqoq_ustun' }));
    expect(data.error).toEqual(expect.stringContaining('yoqoq_ustun'));
    expect((data.available as unknown[]).length).toBeGreaterThan(0);
  });
});
