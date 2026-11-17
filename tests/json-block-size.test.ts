import { describe, expect, it } from 'vitest';

import { MAX_JSON_CHARS, jsonBlock } from '../src/core/format.js';
import type { ToolResult } from '../src/core/types.js';

/**
 * The size guard on structured answers.
 *
 * What used to happen: `renderJsonBlock` sliced the serialized text at 30,000 characters and appended
 * "...qisqartirildi". The result was not parseable, so a caller that read the JSON block — every
 * integration test and every client that does — got a syntax error instead of an answer. The trigger
 * was measured, not imagined: asking `pro_gtfs_routes` for 200 lines of a real national feed produced a
 * 40 KB body and the parse died.
 */
function bodyOf(result: ToolResult): string {
  const text = (result.content ?? []).map((item: { text?: string }) => item.text ?? '').join('\n');
  const match = /```json\n([\s\S]*?)\n```/.exec(text);
  if (!match) throw new Error('JSON bloki topilmadi: ' + text.slice(0, 120));
  return match[1];
}

describe('json block size guard', () => {
  it('leaves a small answer exactly as it was', () => {
    const out = jsonBlock('t', { ok: true, matched: 2, routes: [{ route_id: 'A' }, { route_id: 'B' }] });
    const parsed = JSON.parse(bodyOf(out));
    expect(parsed.truncated).toBeUndefined();
    expect(parsed.routes.length).toBe(2);
  });

  it('cuts the biggest array and keeps the answer parseable', () => {
    const payload = {
      ok: true,
      matched: 300,
      routes: Array.from({ length: 300 }, (_, i) => ({ route_id: 'R' + i, long_name: 'x'.repeat(400) })),
    };
    const parsed = JSON.parse(bodyOf(jsonBlock('t', payload)));
    expect(parsed.truncated).toBe(true);
    expect(bodyOf(jsonBlock('t', payload)).length).toBeLessThan(MAX_JSON_CHARS + 2_000);
    // The count the tool measured survives the cut; only the list shrinks.
    expect(parsed.matched).toBe(300);
    expect(parsed.routes.length).toBeLessThan(300);
    expect(parsed.routes.length).toBeGreaterThan(0);
    expect(parsed.dropped_items.routes).toBeGreaterThan(0);
    expect(parsed.dropped_items.routes).toBe(300 - parsed.routes.length);
  });

  it('reports the total when the answer is an array itself', () => {
    const list = Array.from({ length: 400 }, () => 'y'.repeat(300));
    const parsed = JSON.parse(bodyOf(jsonBlock('t', list)));
    expect(parsed.truncated).toBe(true);
    expect(parsed.total).toBe(400);
    expect(Array.isArray(parsed.items)).toBe(true);
    expect(parsed.items.length).toBeLessThan(400);
  });

  it('says so when there is no array left to shorten', () => {
    const parsed = JSON.parse(bodyOf(jsonBlock('t', 'x'.repeat(MAX_JSON_CHARS + 10))));
    expect(parsed.truncated).toBe(true);
    expect(parsed.value_type).toBe('string');
  });

  it('never leaves a half-written object behind', () => {
    const body = bodyOf(jsonBlock('t', { big: { deep: Array.from({ length: 60 }, () => 'z'.repeat(1_000)) } }));
    expect(() => JSON.parse(body)).not.toThrow();
    expect(body).not.toMatch(/qisqartirildi\s*$/);
  });
});
