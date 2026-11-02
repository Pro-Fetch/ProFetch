/**
 * The action engine: decide whether to act, act, and then find out separately whether it worked.
 *
 * The failure this exists to prevent is the one every browser agent has at some point: an action returned
 * without throwing, so the agent reported success, and the page had done something else entirely — or
 * nothing, because the element the agent meant had been replaced a moment earlier. So there are three
 * separate steps here and none of them is allowed to vouch for another:
 *
 * 1. `preflight` — a pure policy decision about a target the model currently holds. Stale identity, an
 *    unreachable element, a control that cannot take that value, a destructive label, or a read-only
 *    process all stop the action before anything is touched.
 * 2. `execute` — the only part that talks to a browser, and it is injected. This module stays testable, and
 *    a caller cannot mistake the planner for the thing that acts.
 * 3. `verifyAction` — a fresh read of the page, asking a question specific to the action. Verification is
 *    deliberately not the same snapshot preflight used, because a change that already existed in the
 *    "before" state is not caused by anything.
 *
 * The status vocabulary keeps these apart: `SUCCEEDED_VERIFIED` is the only one that says the page agrees.
 * `EXECUTED_UNVERIFIED` exists so that a run which could not check is written down honestly, and
 * `REFUSED` means the engine declined before acting, which is a result, not a failure.
 */

import type { PerceivedNode, Snapshot } from './browser-use-perception.js';
import type { WorldModel } from './browser-use-world.js';
import { resolveInModel } from './browser-use-world.js';
import { clickPoint, revalidatePoint, type PointIn } from './browser-use-coordinates.js';

export type ActionKind = 'click' | 'type' | 'press' | 'check' | 'uncheck' | 'select' | 'scroll-to' | 'hover' | 'focus';

export interface ActionTarget {
  identity: string;
  backendId: string;
  token?: string;
  /** The box the caller was shown, so drift can be measured rather than assumed away. */
  rect?: { x: number; y: number; width: number; height: number };
}

export interface Action {
  kind: ActionKind;
  target: ActionTarget;
  /** Text for `type`, a key name for `press`, an option label or value for `select`, boolean for check. */
  value?: string | boolean;
}

export interface ActionPolicy {
  /** `PRO_FETCH_READ_ONLY`: no action that could change anything is permitted at all. */
  readOnly?: boolean;
  /** Allow actions whose only effect is to reveal or move focus. Default true. */
  allowReveal?: boolean;
  /** Refuse every target whose label looks like it changes something off the page. Default true. */
  refuseDestructive?: boolean;
  /** A caller that has explicitly confirmed a `NEEDS_CONFIRMATION` action. */
  confirmed?: boolean;
}

export type Decision = 'ALLOW' | 'SCROLL_FIRST' | 'NEEDS_CONFIRMATION' | 'REFUSE';

export interface Preflight {
  decision: Decision;
  reason: string;
  /** The node preflight looked at, when the target resolved. */
  node?: PerceivedNode;
  /** Set when the element exists but is not inside the viewport that was read. */
  scrollHint?: { y: number };
  /** The point an executor should use, in CSS viewport pixels, named with its space and frame. */
  point?: PointIn;
}

export type ActionStatus =
  /** Executed, and a later independent read showed the expected change. */
  | 'SUCCEEDED_VERIFIED'
  /** Executed; nothing re-read the page, so nobody can claim it worked. */
  | 'EXECUTED_UNVERIFIED'
  /** Executed and the later read disagreed. */
  | 'EXECUTED_BUT_NOT_VERIFIED'
  /** Preflight stopped it. Nothing was touched. */
  | 'REFUSED'
  /** Preflight would act only with a caller's confirmation. Nothing was touched. */
  | 'NEEDS_CONFIRMATION'
  /** The executor threw or the page changed under the action. */
  | 'FAILED';

export interface Verification {
  status: 'VERIFIED' | 'NOT_VERIFIED' | 'UNKNOWN';
  /** What was looked for, and what the fresh read said. */
  evidence: string;
}

export interface ActionOutcome {
  action: Action;
  status: ActionStatus;
  decision: Decision;
  /** Preflight's reason, always kept — it explains a refusal and justifies an allowance. */
  reason: string;
  verification?: Verification;
  /** Versions of the world model before and after, so a caller can see what the action moved. */
  beforeVersion?: number;
  afterVersion?: number;
  error?: string;
}

const DESTRUCTIVE =
  /(delete|remove|cancel|unsubscribe|purchase|pay now|buy now|transfer|withdraw|send|publish|post|clear|wipe|reset factory|accept all|reject all)/i;
const IRREVERSIBLE_PAGE_EFFECT = /(download|print|share|forward)/i;

function labelOf(node: PerceivedNode): string {
  return node.name || node.text || node.placeholder || node.role || node.tag;
}

/** A label for an evidence sentence, with a fallback so nobody reads `""`. */
function labelOr(node: PerceivedNode): string {
  return labelOf(node) || '(no label)';
}

const REVEAL_ONLY: ActionKind[] = ['hover', 'focus', 'scroll-to'];

/**
 * Decide whether an action may be carried out, without touching anything.
 *
 * The order is deliberate, and each step owns its own message. Reference first: is the identity still in
 * the document, and is the node id and lifetime token the caller was shown still the one behind it? A stale
 * reference makes every later question meaningless, and answering it vaguely ("not interactable") would
 * hide the actual cause. Then the element's own conditions — disabled, covered, outside the read viewport —
 * each with the reason a caller can act on. Then the geometry, because a point over the same place is not a
 * point at the same thing. Then the value and the policy.
 */
export function preflight(action: Action, model: WorldModel, snapshot: Snapshot, policy: ActionPolicy = {}): Preflight {
  if (policy.readOnly && !REVEAL_ONLY.includes(action.kind)) {
    return {
      decision: 'REFUSE',
      reason: 'this process is read-only (PRO_FETCH_READ_ONLY); a ' + action.kind + ' action would change the page',
    };
  }

  const node = snapshot.nodes.find((n) => n.identity === action.target.identity);
  if (!node) {
    // The identity is not in the fresh read. Only the model can say whether that means the page changed,
    // the element was replaced, or the reference came from somewhere else entirely.
    const explained = resolveInModel(model, {
      identity: action.target.identity,
      backendId: action.target.backendId,
      ...(action.target.token ? { token: action.target.token } : {}),
      ...(action.target.rect ? { rect: action.target.rect } : {}),
    });
    return { decision: 'REFUSE', reason: `${explained.staleness}: ${explained.detail}` };
  }

  if (node.backendId !== action.target.backendId) {
    return {
      decision: 'REFUSE',
      reason: `REPLACED: the element is still in the document but the browser has given it node id ${node.backendId} instead of ${action.target.backendId}; re-read before acting`,
      node,
    };
  }
  if (action.target.token && node.token !== action.target.token) {
    return {
      decision: 'REFUSE',
      reason: `REPLACED: this identity now belongs to a different DOM node (token ${action.target.token} → ${node.token}); the original element is gone`,
      node,
    };
  }

  if (node.state.disabled) {
    return { decision: 'REFUSE', reason: `the element is disabled (${labelOf(node)})`, node };
  }
  if (node.obstructed) {
    return {
      decision: 'REFUSE',
      reason: `something else is on top of the element: ${node.conflicts.join('; ') || 'hit-test did not return it'}`,
      node,
    };
  }
  if (!node.inViewport && action.kind !== 'scroll-to') {
    return {
      decision: 'SCROLL_FIRST',
      reason: `the element is not inside the viewport that was read (box at ${Math.round(node.rect.y)}); scroll and re-read before acting`,
      node,
      scrollHint: { y: Math.max(0, Math.round(node.rect.y - snapshot.viewport.height / 3)) },
    };
  }

  const revalidated = revalidatePoint(snapshot, { identity: node.identity, rect: node.rect, frameId: node.frameId });
  if (!revalidated.ok || !revalidated.identityMatches) {
    return {
      decision: 'REFUSE',
      reason: `the point no longer belongs to this element: ${revalidated.reason}`,
      node,
    };
  }
  const point = clickPoint(node.rect, node.frameId);

  const valueError = checkValue(action, node);
  if (valueError) return { decision: 'REFUSE', reason: valueError, node, point };

  if (REVEAL_ONLY.includes(action.kind)) {
    if (policy.allowReveal === false) {
      return { decision: 'REFUSE', reason: `the caller disallowed ${action.kind} actions`, node, point };
    }
    return {
      decision: 'ALLOW',
      reason: `${action.kind} only reveals state; nothing on the page is changed by it`,
      node,
      point,
    };
  }

  const label = labelOf(node);
  if (policy.refuseDestructive !== false && DESTRUCTIVE.test(label)) {
    return {
      decision: 'REFUSE',
      reason: `"${label}" is a verb that changes something outside this page; this engine does not perform it without a human deciding`,
      node,
      point,
    };
  }
  if (IRREVERSIBLE_PAGE_EFFECT.test(label)) {
    return {
      decision: 'NEEDS_CONFIRMATION',
      reason: `"${label}" may trigger a ${label.match(IRREVERSIBLE_PAGE_EFFECT)?.[1]} interaction that leaves the page (print, download, share)`,
      node,
      point,
    };
  }
  if (isSubmitting(node, action) && !policy.confirmed) {
    return {
      decision: 'NEEDS_CONFIRMATION',
      reason: `this control appears to submit a form ("${label}"); confirm to proceed`,
      node,
      point,
    };
  }
  return { decision: 'ALLOW', reason: `the target resolves, is reachable and takes a ${action.kind}`, node, point };
}

/** Does this control look like it hands a form to a server? */
function isSubmitting(node: PerceivedNode, action: Action): boolean {
  if (action.kind !== 'click') return false;
  if (node.tag === 'button') {
    // The collector does not carry the button `type` attribute, so a name that says submit is the signal.
    return /(submit|sign in|log in|checkout|order|register|apply)/i.test(labelOf(node));
  }
  return false;
}

/** Whether the value the caller supplied can be delivered to this control at all. */
function checkValue(action: Action, node: PerceivedNode): string | null {
  const isTextControl =
    node.tag === 'input' || node.tag === 'textarea' || node.role === 'textbox' || node.role === 'searchbox';
  if (action.kind === 'type') {
    if (typeof action.value !== 'string' || action.value.length === 0)
      return 'a type action needs a non-empty string value';
    if (!isTextControl) return `cannot type into a ${node.role || node.tag}; typing belongs to a text control`;
    if (action.value.length > 2000)
      return `refusing to type ${action.value.length} characters into one field — that is a payload, not input`;
    return null;
  }
  if (action.kind === 'press') {
    if (typeof action.value !== 'string' || !action.value.trim()) return 'a press action needs a key name';
    return null;
  }
  if (action.kind === 'check' || action.kind === 'uncheck') {
    if (node.role !== 'checkbox' && node.role !== 'switch')
      return `cannot ${action.kind} a ${node.role || node.tag}; it is not a checkbox`;
    return null;
  }
  if (action.kind === 'select') {
    if (typeof action.value !== 'string' || !action.value) return 'a select action needs an option label or value';
    if (node.tag !== 'select' && node.role !== 'combobox' && node.role !== 'listbox')
      return `cannot select on a ${node.role || node.tag}`;
    return null;
  }
  return null;
}

/** The executor is injected so this module never holds a browser and cannot be confused for one. */
export type Executor = (action: Action, preflight: Preflight) => Promise<void>;

/**
 * Run one action: preflight, execute only if allowed, and hand back the outcome without claiming a result
 * that nobody verified.
 */
export async function performAction(
  action: Action,
  model: WorldModel,
  snapshot: Snapshot,
  execute: Executor,
  policy: ActionPolicy = {},
): Promise<{ outcome: ActionOutcome; preflight: Preflight }> {
  const decision = preflight(action, model, snapshot, policy);
  const base = { action, decision: decision.decision, reason: decision.reason, beforeVersion: model.version };
  if (decision.decision === 'REFUSE') return { outcome: { ...base, status: 'REFUSED' }, preflight: decision };
  if (decision.decision === 'NEEDS_CONFIRMATION')
    return { outcome: { ...base, status: 'NEEDS_CONFIRMATION' }, preflight: decision };
  if (decision.decision === 'SCROLL_FIRST') return { outcome: { ...base, status: 'REFUSED' }, preflight: decision };

  try {
    await execute(action, decision);
  } catch (error) {
    return {
      outcome: { ...base, status: 'FAILED', error: (error as Error).message.slice(0, 300) },
      preflight: decision,
    };
  }
  // Nothing has been re-read yet, so this is the honest state: done, and unverified.
  return { outcome: { ...base, status: 'EXECUTED_UNVERIFIED' }, preflight: decision };
}

/**
 * Ask a fresh read whether the action did what it was supposed to.
 *
 * Each kind gets its own question, answerable from the page: a type action should leave that exact string
 * in that control; a check should flip a state flag; a click should leave evidence that *something*
 * changed, and if nothing did the outcome is NOT_VERIFIED rather than a shrug. `before` is the snapshot the
 * action was planned against — comparing to it is what makes the claim causal instead of coincidental.
 */
export function verifyAction(action: Action, before: Snapshot, after: Snapshot, targetIdentity: string): Verification {
  const was = before.nodes.find((n) => n.identity === targetIdentity);
  let node = after.nodes.find((n) => n.identity === targetIdentity);
  if (!node && was) {
    // Same DOM node, different words: a label change moves the identity on purpose, and that is the most
    // direct evidence a click had an effect. Match it by the lifetime token instead.
    const byToken = after.nodes.find((n) => n.token === was.token && n.frameId === was.frameId);
    if (byToken && (byToken.name !== was.name || byToken.text !== was.text)) {
      return {
        status: 'VERIFIED',
        evidence: `the element is the same DOM node (token ${was.token}) but now reads "${labelOr(byToken)}" instead of "${labelOr(was)}"`,
      };
    }
  }
  if (!node) {
    // A click that navigates or replaces the element is a real effect; the absence is the evidence.
    const urlChanged = before.url !== after.url;
    if (urlChanged)
      return {
        status: 'VERIFIED',
        evidence: `the document changed from ${trim(before.url)} to ${trim(after.url)}; the target element is gone with the old page`,
      };
    if (action.kind === 'click')
      return {
        status: 'UNKNOWN',
        evidence: `the target identity is not in the fresh read and the url did not change — could not tell whether the click worked or the element was replaced by something unrelated`,
      };
    return {
      status: 'NOT_VERIFIED',
      evidence: 'the element is not in the fresh read, so the action cannot be confirmed against it',
    };
  }

  switch (action.kind) {
    case 'type': {
      const was = before.nodes.find((n) => n.identity === targetIdentity);
      const nowText = node.value || node.text || node.name;
      if (typeof action.value !== 'string') return { status: 'NOT_VERIFIED', evidence: 'no value was asked for' };
      if (nowText === action.value) return { status: 'VERIFIED', evidence: `the control now holds "${action.value}"` };
      if (was && was.value === node.value && node.value !== action.value)
        return {
          status: 'NOT_VERIFIED',
          evidence: `the control still holds "${node.value || '(empty)'}", not the text that was typed`,
        };
      return {
        status: 'NOT_VERIFIED',
        evidence: `the control reads "${node.value || node.text || '(no value reported)'}" instead of "${action.value}" — the collector may not be reading this control's value`,
      };
    }
    case 'check':
    case 'uncheck': {
      const want = action.kind === 'check';
      if (typeof node.state.checked !== 'boolean')
        return { status: 'UNKNOWN', evidence: 'the fresh read carries no checked state to compare' };
      return node.state.checked === want
        ? { status: 'VERIFIED', evidence: `checked is now ${String(want)}` }
        : { status: 'NOT_VERIFIED', evidence: `checked is ${String(node.state.checked)}, expected ${String(want)}` };
    }
    case 'select': {
      const got = node.value || node.text;
      if (typeof action.value !== 'string') return { status: 'NOT_VERIFIED', evidence: 'no option was asked for' };
      return got === action.value || got.includes(action.value)
        ? { status: 'VERIFIED', evidence: `the control now reads "${got}"` }
        : { status: 'NOT_VERIFIED', evidence: `the control reads "${got}", expected "${action.value}"` };
    }
    case 'press': {
      const changed = describeChange(before, after);
      return changed
        ? { status: 'VERIFIED', evidence: `after the key press, ${changed}` }
        : { status: 'NOT_VERIFIED', evidence: 'nothing in the fresh read differs after the key press' };
    }
    case 'click': {
      const changed = describeChange(before, after);
      if (changed) return { status: 'VERIFIED', evidence: `the page moved after the click: ${changed}` };
      if (node.state.checked !== undefined) {
        const was = before.nodes.find((n) => n.identity === targetIdentity);
        if (was && was.state.checked !== node.state.checked)
          return {
            status: 'VERIFIED',
            evidence: `the control's checked state flipped to ${String(node.state.checked)}`,
          };
      }
      return {
        status: 'NOT_VERIFIED',
        evidence:
          'no difference at all between the reads: same url, same nodes, same values — the click cannot be said to have done anything',
      };
    }
    case 'scroll-to': {
      const moved = Math.abs(after.scroll.y - before.scroll.y) > 1;
      return moved
        ? {
            status: 'VERIFIED',
            evidence: `scroll moved from ${Math.round(before.scroll.y)} to ${Math.round(after.scroll.y)}`,
          }
        : { status: 'NOT_VERIFIED', evidence: `scroll is still ${Math.round(after.scroll.y)}; nothing moved` };
    }
    case 'hover':
    case 'focus': {
      // A reveal that shows nothing is a reveal that did not happen — but only the page knows whether
      // hovering has an effect at all, so this reports what was seen rather than asserting a rule.
      const changed = describeChange(before, after);
      return changed
        ? { status: 'VERIFIED', evidence: `${action.kind} produced a change: ${changed}` }
        : { status: 'NOT_VERIFIED', evidence: `nothing appeared on ${action.kind}` };
    }
    default:
      return { status: 'UNKNOWN', evidence: `no verification rule is defined for ${action.kind}` };
  }
}

/** Attach a verification to an outcome, turning `EXECUTED_UNVERIFIED` into something a reader can use. */
export function withVerification(outcome: ActionOutcome, verification: Verification): ActionOutcome {
  if (outcome.status !== 'EXECUTED_UNVERIFIED') return outcome;
  return {
    ...outcome,
    status:
      verification.status === 'VERIFIED'
        ? 'SUCCEEDED_VERIFIED'
        : verification.status === 'NOT_VERIFIED'
          ? 'EXECUTED_BUT_NOT_VERIFIED'
          : 'EXECUTED_UNVERIFIED',
    verification,
  };
}

function describeChange(before: Snapshot, after: Snapshot): string | null {
  if (before.url !== after.url) return `the url became ${trim(after.url)}`;
  if (before.title !== after.title) return `the title became "${after.title}"`;
  const beforeIds = new Set(before.nodes.map((n) => n.identity));
  const afterIds = new Set(after.nodes.map((n) => n.identity));
  const added = [...afterIds].filter((i) => !beforeIds.has(i)).length;
  const removed = [...beforeIds].filter((i) => !afterIds.has(i)).length;
  let relabelled = 0;
  for (const n of after.nodes) {
    const was = before.nodes.find((b) => b.identity === n.identity && b.token === n.token);
    if (was && (was.name !== n.name || was.text !== n.text)) relabelled++;
  }
  const moved = after.nodes.filter((n) => {
    const was = before.nodes.find((b) => b.identity === n.identity);
    return !!was && (Math.abs(was.rect.y - n.rect.y) > 1 || Math.abs(was.rect.x - n.rect.x) > 1);
  }).length;
  const parts: string[] = [];
  if (added) parts.push(`${added} node(s) appeared`);
  if (removed) parts.push(`${removed} node(s) disappeared`);
  if (relabelled) parts.push(`${relabelled} label(s) changed`);
  if (moved) parts.push(`${moved} element(s) moved`);
  return parts.length ? parts.join(', ') : null;
}

function trim(s: string): string {
  return s.length > 80 ? s.slice(0, 77) + '...' : s;
}
