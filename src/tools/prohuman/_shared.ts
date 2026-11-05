/**
 * Shared input handling for the ProHuman pack.
 *
 * Every tool in this category needs the same three things: a profile (from a preset plus overrides), a
 * disclosure (identity + consent, validated before anything moves), and a driver to act on. Doing that in
 * each file is how twelve copies of one rule drift apart, so the parsing lives here and each tool declares
 * only what is specific to it.
 */

import { failJson, jsonBlock } from '../../core/format.js';
import { optionalStr, num, bool } from '../../core/input.js';
import { createProfile, ProfileError, profileSummary, type HumanProfile } from '../../core/prohuman-profile.js';
import { parseDisclosure, disclosureEcho, DisclosureError, type Disclosure } from '../../core/prohuman-disclosure.js';
import { getDriver, type DriverState, type ActionRequest } from '../../core/prohuman-driver.js';
import { requireSession, type BrowserUseSession } from '../../core/browser-use-session.js';
import { readOnly } from '../../core/read-only-guard.js';

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Build a profile from the arguments a caller passed, or refuse with the number that is out of range. */
export function readProfile(input: Record<string, unknown>): Parsed<HumanProfile> {
  try {
    const pointer = (input.pointer && typeof input.pointer === 'object' ? input.pointer : undefined) as
      Record<string, number> | undefined;
    const keyboard = (input.keyboard && typeof input.keyboard === 'object' ? input.keyboard : undefined) as
      Record<string, number> | undefined;
    const scroll = (input.scroll && typeof input.scroll === 'object' ? input.scroll : undefined) as
      Record<string, number> | undefined;
    const attention = (input.attention && typeof input.attention === 'object' ? input.attention : undefined) as
      Record<string, number> | undefined;
    return {
      ok: true,
      value: createProfile({
        ...(optionalStr(input, 'preset') ? { preset: optionalStr(input, 'preset') } : {}),
        ...(optionalStr(input, 'profile_name') ? { name: optionalStr(input, 'profile_name') } : {}),
        ...(input.seed !== undefined ? { seed: num(input, 'seed', 0, 0) } : {}),
        ...(input.max_runtime_ms !== undefined ? { max_runtime_ms: num(input, 'max_runtime_ms', 120_000, 0) } : {}),
        ...(pointer ? { pointer } : {}),
        ...(keyboard ? { keyboard } : {}),
        ...(scroll ? { scroll } : {}),
        ...(attention ? { attention } : {}),
      }),
    };
  } catch (error) {
    if (error instanceof ProfileError) return { ok: false, error: error.message };
    throw error;
  }
}

/**
 * Read the disclosure from the arguments.
 *
 * A caller may also have attached with a disclosure already; then the stored one is reused and the tool does
 * not get to renegotiate consent mid-session — that would make the check decorative.
 */
export function readDisclosure(input: Record<string, unknown>, attached?: Disclosure): Parsed<Disclosure> {
  if (attached) return { ok: true, value: attached };
  try {
    return { ok: true, value: parseDisclosure(input) };
  } catch (error) {
    if (error instanceof DisclosureError) return { ok: false, error: error.message };
    throw error;
  }
}

/** Look a driver up by id, turning the missing-driver case into a tool answer rather than a stack trace. */
export function driver(id: unknown): Parsed<DriverState> {
  const value = optionalStr({ driver_id: id } as Record<string, unknown>, 'driver_id');
  if (!value) return { ok: false, error: 'driver_id is required — attach a driver first' };
  try {
    return { ok: true, value: getDriver(value) };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/**
 * Keep only the named keys of an input object.
 *
 * The action handlers delegate, and the schema audit measures what a handler's own body reads: a handler
 * that names nothing looks like a tool that ignores every argument it declares. Naming them here is not
 * ceremony for the audit — it is the contract the handler actually honours, and it is what a reader of the
 * file sees.
 */
export function pick(input: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (input[key] !== undefined) out[key] = input[key];
  return out;
}

/** The arguments every action tool takes: where to aim, and how long to wait before answering. */
export function readAction(input: Record<string, unknown>, kind: ActionRequest['kind']): ActionRequest {
  const request: ActionRequest = { kind };
  const identity = optionalStr(input, 'identity');
  const backendId = optionalStr(input, 'node_id');
  if (identity) request.identity = identity;
  if (backendId) request.backend_id = backendId;
  if (input.x !== undefined) request.x = num(input, 'x', 0, -100000);
  if (input.y !== undefined) request.y = num(input, 'y', 0, -100000);
  if (input.target_width_px !== undefined) request.target_width_px = num(input, 'target_width_px', 0, 0);
  const text = optionalStr(input, 'text');
  if (text) request.text = text;
  const key = optionalStr(input, 'key');
  if (key) request.key = key;
  if (input.words !== undefined) request.words = num(input, 'words', 1, 1);
  if (input.direction !== undefined) request.direction = num(input, 'direction', 1, -1) < 0 ? -1 : 1;
  return request;
}

/**
 * Turn an element the engine already read into a point to aim at.
 *
 * The alternative — accepting `identity` and quietly using whatever `x`/`y` came with it — would let a
 * stale or wrong identity drive a click somewhere the caller never named. So a named element wins, and if
 * it is not in the latest read, the answer says that instead of guessing.
 */
export function resolveTarget(state: DriverState, request: ActionRequest): Parsed<ActionRequest> {
  const name = request.identity ?? request.backend_id;
  if (!name) return { ok: true, value: request };
  let session: BrowserUseSession;
  try {
    session = requireSession(state.sessionId);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  const nodes = session.model.latest.nodes;
  const node = nodes.find((n) => n.identity === name || n.backendId === name);
  if (!node) {
    return {
      ok: false,
      error: `"${name}" is not in session ${state.sessionId}'s latest read (${nodes.length} nodes) — read the page again, or pass x and y`,
    };
  }
  if (!node.inViewport) {
    return {
      ok: false,
      error: `"${name}" is outside the viewport, so no pointer can reach it — scroll it into view first (pro_browser_use_scroll), then aim again`,
    };
  }
  return {
    ok: true,
    value: {
      ...request,
      x: Math.round(node.rect.x + node.rect.width / 2),
      y: Math.round(node.rect.y + node.rect.height / 2),
      target_width_px: Math.round(node.rect.width),
      resolved_from: `${node.tag}${node.role ? `[${node.role}]` : ''} ${(node.name || node.text || node.backendId).slice(0, 60)}`,
    },
  };
}

/** A refusal that carries its own evidence, instead of a bare sentence. */
export function refused(reason: string, extra: Record<string, unknown> = {}): ReturnType<typeof failJson> {
  return failJson('prohuman refused', { ok: false, reason, ...extra });
}

/** The shape every answer shares: what was asked, what the driver did, and what was disclosed. */
export function answer(
  summary: string,
  state: DriverState,
  extra: Record<string, unknown> = {},
): ReturnType<typeof jsonBlock> {
  return jsonBlock(summary, {
    ok: true,
    driver_id: state.id,
    session_id: state.sessionId,
    running: state.running,
    disclosure: disclosureEcho(state.disclosure),
    ...extra,
  });
}

/** Read-only mode is a deployment decision, and the pack must obey it rather than explain it away. */
export function writeModeBlocked(): { blocked: true; message: string } | { blocked: false } {
  if (!readOnly()) return { blocked: false };
  return {
    blocked: true,
    message:
      'PRO_FETCH_READ_ONLY=true: this server refuses to move a cursor or press a key. Measurement of an existing trace still works.',
  };
}

/** `bool` already defaults correctly; this wrapper exists so a tool that wants `true` by default reads plainly. */
export function flag(input: Record<string, unknown>, name: string, fallback = true): boolean {
  return bool(input, name, fallback);
}

export { profileSummary };
