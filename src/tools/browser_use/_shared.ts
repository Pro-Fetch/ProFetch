/**
 * Shared input parsing for the `browser_use` tool pack.
 *
 * These tools split into two kinds. Some talk to no browser at all — they answer questions about
 * capability, geometry, pixels and policy from arguments the caller supplies. Others will need a live
 * page, and those go through the session bridge rather than this file. What both kinds must not do is
 * invent a default for something the caller forgot to send: a missing capability list silently becomes
 * "nothing required", and a rect typed as `{x: 10}` silently becomes a box with no area.
 *
 * So every parse here either returns a usable value or a reason, and the reasons are the text a caller
 * sees — written for someone who has to fix a call, not for a log file.
 */

import type { BrowserCapability } from '../../core/browser-use-contract.js';
import { ALL_CAPABILITIES } from '../../core/browser-use-capabilities.js';
import type { RawNode, Rect, Snapshot, BuildOptions } from '../../core/browser-use-perception.js';
import { buildSnapshot } from '../../core/browser-use-perception.js';
import { createHash } from 'node:crypto';
import type { ToolResult } from '../../core/types.js';

/** A node list large enough to be a mistake, not a page. */
export const MAX_INPUT_NODES = 4000;

/**
 * A JSON summary plus image bytes as their own content item.
 *
 * `jsonBlock` truncates its body past 30k characters — harmless for a list of findings, silently wrong
 * for a screenshot, where the cut lands inside base64 and the caller cannot parse what it got. So the
 * bytes travel separately, and the summary carries their length and a short digest: enough to tell one
 * capture from another without decoding it.
 */
export function imageResult(summary: Record<string, unknown>, base64: string): ToolResult {
  const body = {
    ...summary,
    image_chars: base64.length,
    image_sha256: createHash('sha256').update(base64).digest('hex').slice(0, 16),
  };
  return {
    content: [
      { type: 'text', text: '```json\n' + JSON.stringify(body, null, 2) + '\n```' },
      { type: 'text', text: base64 },
    ],
  };
}

/**
 * A parse result as a discriminated union: checking `ok` narrows the other branch, so no caller has to
 * assert that `value` exists, and no caller can read an error out of a successful parse.
 */
export type Parse<T> = { ok: true; value: T } | { ok: false; error: string };

function bad(error: string): Parse<never> {
  return { ok: false, error };
}

/** Accept either a JSON string or an already-parsed array; models send both. */
export function parseJsonArray(raw: unknown, field: string): Parse<unknown[]> {
  if (Array.isArray(raw)) return { ok: true, value: raw };
  if (typeof raw !== 'string' || !raw.trim()) return bad(`${field}: JSON massiv kerak (bo'sh emas)`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return bad(`${field}: JSON ajratib bo'lmadi: ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed)) return bad(`${field}: massiv bo'lishi kerak, ${typeof parsed} emas`);
  return { ok: true, value: parsed };
}

export function parseRect(raw: unknown, field = 'rect'): Parse<Rect> {
  const obj = typeof raw === 'string' ? safeJson(raw) : raw;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj))
    return bad(`${field}: {"x","y","width","height"} obyekti kerak`);
  const rec = obj as Record<string, unknown>;
  const out: number[] = [];
  for (const key of ['x', 'y', 'width', 'height']) {
    const value = rec[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) return bad(`${field}.${key} son bo'lishi kerak`);
    out.push(value);
  }
  if (out[2] < 0 || out[3] < 0) return bad(`${field}.width va ${field}.height manfiy bo'la olmaydi`);
  return { ok: true, value: { x: out[0], y: out[1], width: out[2], height: out[3] } };
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Validate a caller-supplied node list into the shape perception expects.
 *
 * Only the fields the merge cannot do without are required. `token` defaults to a positional value —
 * which is enough for geometry tools and refuses to pretend otherwise: a node without a real token has
 * no lifetime, so the answer says so rather than inventing an identity that looks stable.
 */
export function parseNodes(raw: unknown): Parse<RawNode[]> {
  const list = parseJsonArray(raw, 'nodes');
  if (!list.ok) return bad(list.error!);
  if (list.value.length > MAX_INPUT_NODES)
    return bad(`nodes: ${list.value.length} ta juda ko'p, chegara ${MAX_INPUT_NODES}`);
  const out: RawNode[] = [];
  list.value.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const rec = entry as Record<string, unknown>;
    const rect = typeof rec.rect === 'object' && rec.rect ? (rec.rect as Record<string, unknown>) : {};
    const num = (value: unknown, fallback: number): number =>
      typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    out.push({
      backendId: String(rec.backendId ?? `n${index}`),
      token: String(rec.token ?? `position:${index}`),
      frameId: String(rec.frameId ?? 'main'),
      path: String(rec.path ?? `injected[${index}]`),
      tag: String(rec.tag ?? 'div').toLowerCase(),
      role: typeof rec.role === 'string' ? rec.role : undefined,
      name: typeof rec.name === 'string' ? rec.name : undefined,
      text: typeof rec.text === 'string' ? rec.text : undefined,
      value: typeof rec.value === 'string' ? rec.value : undefined,
      placeholder: typeof rec.placeholder === 'string' ? rec.placeholder : undefined,
      href: typeof rec.href === 'string' ? rec.href : undefined,
      ariaHidden: rec.ariaHidden === true,
      disabled: rec.disabled === true,
      checked: rec.checked === true,
      selected: rec.selected === true,
      expanded: typeof rec.expanded === 'boolean' ? rec.expanded : undefined,
      rect: {
        x: num(rect.x, 0),
        y: num(rect.y, 0),
        width: num(rect.width, 0),
        height: num(rect.height, 0),
      },
      inViewport: rec.inViewport !== false,
      styleVisible: rec.styleVisible !== false,
      hitTestSelf: rec.hitTestSelf !== false,
      obstructed: rec.obstructed === true,
      scrollable: typeof rec.scrollable === 'boolean' ? rec.scrollable : undefined,
      depth: num(rec.depth, 1),
      interactive: rec.interactive === true,
      boundaries: Array.isArray(rec.boundaries) ? rec.boundaries.map(String) : [],
    } as RawNode);
  });
  if (!out.length) return bad('nodes: hech bo‘lmaganda bitta obyekt kerak');
  return { ok: true, value: out };
}

export interface SnapshotInput {
  nodes: RawNode[];
  snapshot: Snapshot;
  /** True when any node carried a synthesised token — the caller must know identity is weakened. */
  tokensGuessed: boolean;
}

/**
 * Build a snapshot from an injected node list.
 *
 * `synthetic:` in the snapshot id is not decoration: a snapshot assembled from a tool argument is not a
 * read of a page, and any answer derived from it must be quotable as such.
 */
export function snapshotFromInput(
  raw: unknown,
  url = 'about:blank',
  title = 'injected',
  viewportSize = 1280,
  heightPx = 720,
): Parse<SnapshotInput> {
  const nodes = parseNodes(raw);
  if (!nodes.ok) return bad(nodes.error!);
  const tokensGuessed = nodes.value.some((n) => n.token.startsWith('position:'));
  const options: BuildOptions = {
    snapshotId: 'synthetic-1',
    url,
    title,
    viewport: { width: viewportSize, height: heightPx },
    deviceScaleFactor: 1,
    scroll: { x: 0, y: 0 },
    capturedAt: 0,
  };
  return { ok: true, value: { nodes: nodes.value, snapshot: buildSnapshot(nodes.value, options), tokensGuessed } };
}

/** Capability names are checked against the registry's own list, so a typo is a refusal, not a filter. */
export function parseCapabilities(raw: unknown, field = 'capabilities'): Parse<BrowserCapability[]> {
  const list = parseJsonArray(raw, field);
  if (!list.ok) return bad(list.error!);
  const known = new Set<string>(ALL_CAPABILITIES);
  const out: BrowserCapability[] = [];
  for (const item of list.value) {
    const value = String(item);
    if (!known.has(value))
      return bad(`${field}: "${value}" noma'lum capability — mavjudlar: ${ALL_CAPABILITIES.slice(0, 8).join(', ')}…`);
    out.push(value as BrowserCapability);
  }
  if (!out.length) return bad(`${field}: bo'sh ro'yxat "hech narsa talab qilmayman" degani — ayting`);
  return { ok: true, value: out };
}
