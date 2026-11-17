import type { ToolResult } from './types.js';
import { clipToTokens } from './chunker.js';

export function result(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

export function fail(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export function md(text: string, maxTokens = 8000): ToolResult {
  return result(clipToTokens(text, maxTokens));
}

/** How many characters one JSON answer may take before it has to be made smaller. */
export const MAX_JSON_CHARS = 30_000;

/**
 * Make an oversized answer smaller without breaking it.
 *
 * What this replaces: the serialized text was sliced at 30,000 characters and `...qisqartirildi` was
 * appended, which is not JSON. Every caller that parsed the fenced block got a syntax error and could
 * report nothing — measured when `pro_gtfs_routes` listed 200 lines of a real national feed. Shortening
 * the arrays keeps the answer valid, keeps the totals true, and names what was left out, so a reader
 * knows to ask for a narrower page instead of trusting a cut-off list.
 */
function shrinkToFit(data: unknown, maxChars = MAX_JSON_CHARS): unknown {
  const size = (value: unknown): number => {
    try {
      const text = JSON.stringify(value, null, 2);
      return text === undefined ? Number.POSITIVE_INFINITY : text.length;
    } catch {
      // A value JSON cannot represent (a cycle) must not escape into the answer.
      return Number.POSITIVE_INFINITY;
    }
  };
  if (size(data) <= maxChars) return data;

  const dropped: Record<string, number> = {};
  const marker = () => ({
    truncated: true,
    reason: 'javob ' + maxChars + ' belgidan oshdi — ro‘yxatlar qisqartirildi',
    dropped_items: { ...dropped },
  });

  if (Array.isArray(data)) {
    for (let keep = Math.floor(data.length / 2); keep > 0; keep = Math.floor(keep / 2)) {
      const candidate = { ...marker(), total: data.length, items: data.slice(0, keep) };
      if (size(candidate) <= maxChars) return candidate;
    }
    return { ...marker(), total: data.length, items: [] };
  }

  if (data && typeof data === 'object') {
    const copy: Record<string, unknown> = { ...(data as Record<string, unknown>) };
    const listsOf = (value: Record<string, unknown>): Array<[string, unknown[]]> =>
      Object.entries(value).filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]));
    for (let guard = 0; guard < 40; guard++) {
      const lists = listsOf(copy);
      if (!lists.length) break;
      const [key, list] = lists.reduce((a, b) => (size(b[1]) > size(a[1]) ? b : a));
      if (!list.length) break;
      const keep = Math.floor(list.length / 2);
      dropped[key] = (dropped[key] ?? 0) + (list.length - keep);
      copy[key] = list.slice(0, keep);
      const candidate = { ...copy, ...marker() };
      if (size(candidate) <= maxChars) return candidate;
    }
    // No array left to cut — the answer itself is what is too big. Say so, and hand back the shape.
    return { ...marker(), keys: Object.keys(copy), chars: size(data) };
  }

  return { ...marker(), value_type: typeof data };
}

function renderJsonBlock(title: string, data: unknown): string {
  const s = JSON.stringify(shrinkToFit(data), null, 2) ?? 'null';
  return title + '\n\n```json\n' + s + '\n```';
}

export function jsonBlock(title: string, data: unknown): ToolResult {
  return result(renderJsonBlock(title, data));
}

/**
 * Same structured JSON payload as `jsonBlock`, but flagged as a tool failure.
 *
 * Use this for genuine operation errors (missing/invalid argument, unparseable input, a resource
 * that was not found) where the caller still benefits from a structured body — a suggestion, an id,
 * the failing input. A plain `jsonBlock({ error })` left `isError` false, so `dispatch` reported
 * `structuredContent.ok = true` and clients that branch on `isError` treated the failed call as a
 * success. Contrast with validation results (e.g. a schema saying a value is invalid): there the
 * operation succeeded, so those stay `jsonBlock`, not `failJson`.
 */
export function failJson(title: string, data: unknown): ToolResult {
  return { content: [{ type: 'text', text: renderJsonBlock(title, data) }], isError: true };
}
