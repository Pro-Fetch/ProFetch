import { describe, expect, it } from 'vitest';
import '../src/loader.js';
import { callTool } from '../src/router.js';
import type { ToolResult } from '../src/core/types.js';

/**
 * The path reader, tested against documents held in the test, not against a host.
 *
 * There was no behavioural test for `pro_fetch_json_path` at all — only a schema entry — which is how two
 * of its bugs survived: a leading `$.` (the syntax the description itself shows) never resolved, and every
 * failed path was reported as "Path topilmadi" without saying which segment stopped. Both were found while
 * reading a real API response, and both sent the reader back to the data instead of to the path.
 */

const DOCUMENT = {
  jobs: [
    { id: 1, name: 'Verify', conclusion: 'success' },
    { id: 2, name: 'Coverage' },
    { id: 3, name: 'Gateway', conclusion: null },
  ],
  repository: { owner: { login: 'pro-fetch' }, forks: 4 },
  empty: [],
  scalar: 7,
};

function body(result: ToolResult): string {
  return (result.content ?? [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text ?? '')
    .join('\n');
}

function value(result: ToolResult): unknown {
  const match = /```json\n([\s\S]*?)\n```/.exec(body(result));
  return match ? JSON.parse(match[1]) : undefined;
}

function read(selector: string): Promise<ToolResult> {
  return callTool('pro_fetch_json_path', { text: JSON.stringify(DOCUMENT), selector });
}

describe('the path reader resolves the paths it publishes', () => {
  it('takes the leading $ root marker, which used to be read as a key', async () => {
    const result = await read('$.repository.owner.login');
    expect(result.isError, body(result)).toBeUndefined();
    expect(value(result)).toBe('pro-fetch');
  });

  it('takes the same path written without the marker', async () => {
    expect(value(await read('repository.owner.login'))).toBe('pro-fetch');
  });

  it('takes an index in either spelling', async () => {
    expect(value(await read('$.repository.forks'))).toBe(4);
    expect(value(await read('$.jobs[1].name'))).toBe('Coverage');
    expect(value(await read('$.jobs.1.name'))).toBe('Coverage');
  });

  it('reads a stored null as null, not as a missing path', async () => {
    const result = await read('$.jobs[2].conclusion');
    expect(result.isError, body(result)).toBeUndefined();
    expect(value(result)).toBeNull();
  });
});

describe('the wildcard maps instead of failing', () => {
  it('maps one path over every element', async () => {
    expect(value(await read('$.jobs[*].name'))).toEqual(['Verify', 'Coverage', 'Gateway']);
  });

  it('yields null where an element has no such field, and still answers', async () => {
    // Measured shape of a real API page: check-run jobs where the same field is present on some rows and
    // absent on others. Aborting the read would throw away the values that are there.
    expect(value(await read('$.jobs[*].conclusion'))).toEqual(['success', null, null]);
  });

  it('maps an empty array to an empty array', async () => {
    expect(value(await read('$.empty[*].id'))).toEqual([]);
  });

  it('refuses a wildcard over something that is not an array, and says what it was', async () => {
    const result = await read('$.scalar[*].id');
    expect(result.isError).toBe(true);
    expect(body(result)).toMatch(/\[\*\]/);
    expect(body(result)).toMatch(/number/);
  });
});

describe('a failed read says where it stopped', () => {
  it('names the segment that stopped the walk, not the whole path', async () => {
    const result = await read('$.repository.owner.password');
    expect(result.isError).toBe(true);
    const text = body(result);
    expect(text).toContain('password');
    expect(text).toMatch(/to‘xtadi/);
  });

  it('names the type when the walk runs into a scalar', async () => {
    const result = await read('$.repository.forks.nested');
    expect(result.isError).toBe(true);
    expect(body(result)).toMatch(/number/);
  });

  it('refuses a projection by naming the grammar, not by claiming the path is missing', async () => {
    // This is the message that sent a reader hunting for absent data: `$.jobs[*].{id,name}` is not a path
    // in this language, and "Path topilmadi" described it as if it were.
    const result = await read('$.jobs[*].{id,name}');
    expect(result.isError).toBe(true);
    const text = body(result);
    expect(text).toMatch(/qo‘llab-quvvatlanmaydi/);
    expect(text).not.toMatch(/topilmadi/);
    expect(text).toMatch(/\[\*\]/);
  });

  it('asks for a selector instead of failing on an empty one', async () => {
    const result = await callTool('pro_fetch_json_path', { text: '{"a":1}', selector: '' });
    expect(result.isError).toBe(true);
    expect(body(result)).toMatch(/selector/);
  });

  it('still says when the document is not JSON at all', async () => {
    const result = await callTool('pro_fetch_json_path', { text: '<html>nope</html>', selector: '$.a' });
    expect(result.isError).toBe(true);
    expect(body(result)).toMatch(/JSON/);
  });
});
