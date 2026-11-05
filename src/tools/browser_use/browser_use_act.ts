import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { livePage, refresh, requireSession, SessionError } from '../../core/browser-use-session.js';
import {
  performAction,
  withVerification,
  verifyAction,
  type Action,
  type ActionPolicy,
} from '../../core/browser-use-actions.js';
import type { Snapshot } from '../../core/browser-use-perception.js';
import { requireStr, optionalStr, bool } from '../../core/input.js';
import { acquirePointer, pointerHolder, releasePointer } from '../../core/prohuman-lock.js';
import { stop } from '../../core/prohuman-driver.js';

/**
 * pro_browser_use_act — Preflight, act, and verify against the page
 * Pack: browser_use (pro-fetch)
 *
 * The only tool in the pack that changes something. It reports `SUCCEEDED_VERIFIED` only when a fresh
 * read of the page agrees with the action, and `EXECUTED_UNVERIFIED` when nothing could confirm it —
 * those two are never collapsed into "no error was thrown".
 */
export default defineTool({
  name: 'pro_browser_use_act',
  description:
    'Perform one action on an element the session has reported: click, type, press, check, select, hover, focus or scroll. Every action is preflighted (stale identity, covered element, wrong control kind and destructive labels are refused before anything runs) and then verified by re-reading the page.',
  category: 'browser_use',
  annotations: { readOnlyHint: false, openWorldHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Open session' },
      action: {
        type: 'string',
        enum: ['click', 'type', 'press', 'check', 'uncheck', 'select', 'scroll-to', 'hover', 'focus'],
        description: 'What to do',
      },
      identity: { type: 'string', description: 'Identity from the last snapshot or outline' },
      backend_id: { type: 'string', description: 'Node id from the same read' },
      token: { type: 'string', description: 'Lifetime token from the same read (recommended)' },
      pause_driver: {
        type: 'boolean',
        description:
          'Take the cursor from a ProHuman driver. It stops that driver rather than pausing it: resuming would need a state it no longer has, and a cursor handed back to a loop that kept running would move under whatever this action reads',
      },
      value: {
        type: 'string',
        description: 'Text for type, key for press, option for select; "true"/"false" for check',
      },
      confirmed: { type: 'boolean', description: 'The caller confirmed an action that needed confirmation' },
      verify: { type: 'boolean', description: 'Re-read the page afterwards and judge the result (default true)' },
    },
    required: ['session_id', 'action', 'identity', 'backend_id'],
    additionalProperties: false,
  },
  async handler(input) {
    let session;
    try {
      session = requireSession(optionalStr(input, 'session_id'));
    } catch (error) {
      if (error instanceof SessionError) return fail(error.message);
      throw error;
    }
    // A ProHuman driver owns the cursor while it runs. Two writers on one pointer interleave: the path is
    // neither the driver's plan nor the caller's click, and every measurement after it describes a
    // collision. `pause_driver` is the caller's way of saying "take over" — it stops the driver rather
    // than sneaking an action in beside it.
    const holder = pointerHolder(session.id);
    if (holder?.kind === 'driver' && !bool(input, 'pause_driver', false)) {
      return fail(
        `the cursor belongs to ProHuman driver "${holder.id}" — pass pause_driver=true to take it over, or stop the driver first`,
      );
    }
    const actionId = `act-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (holder?.kind === 'driver') {
      // Yielding is a handover, not a negotiation: the driver is stopped first, and stopping it releases
      // its lease. Asking a live lease for permission would refuse the very call that asked to take over.
      stop(holder.id, `yielded to pro_browser_use_act (${actionId})`);
      acquirePointer(session.id, { kind: 'action', id: actionId });
    }
    const kind = requireStr(input, 'action') as Action['kind'];
    const raw = optionalStr(input, 'value');
    const action: Action = {
      kind,
      target: {
        identity: requireStr(input, 'identity'),
        backendId: requireStr(input, 'backend_id'),
        ...(optionalStr(input, 'token') ? { token: optionalStr(input, 'token')! } : {}),
      },
      ...(raw === undefined ? {} : { value: kind === 'check' || kind === 'uncheck' ? raw !== 'false' : raw }),
    };
    const policy: ActionPolicy = {
      confirmed: bool(input, 'confirmed'),
      allowReveal: true,
      // The operator's read-only switch is the authority; the engine does not decide it per tool.
      readOnly: process.env.PRO_FETCH_READ_ONLY === 'true' || process.env.PRO_FETCH_READ_ONLY === '1',
    };

    const before: Snapshot = session.model.latest;
    const page = livePage(session);
    const { outcome, preflight } = await performAction(
      action,
      session.model,
      before,
      async (a, decision) => {
        const point = decision.point;
        if (!point) throw new Error('the engine allowed an action without a point');
        switch (a.kind) {
          case 'type': {
            await page.mouse.click(point.x, point.y);
            await page.keyboard.type(String(a.value ?? ''));
            break;
          }
          case 'press': {
            await page.mouse.click(point.x, point.y);
            await page.keyboard.press(String(a.value ?? 'Enter'));
            break;
          }
          case 'scroll-to': {
            await page.evaluate(
              `(() => { const el = document.querySelector('[data-pf-id="${nodeId(a, before)}"]'); if (el) el.scrollIntoView({block:'center'}); })()`,
            );
            break;
          }
          case 'hover':
          case 'focus': {
            await page.mouse.move(point.x, point.y);
            break;
          }
          default: {
            await page.mouse.click(point.x, point.y);
          }
        }
        await page.waitForTimeout(120);
      },
      policy,
    );

    let final = outcome;
    if (outcome.status === 'EXECUTED_UNVERIFIED' && bool(input, 'verify', true)) {
      const afterResult = await refresh(session, {});
      final = withVerification(outcome, verifyAction(action, before, afterResult.snapshot, action.target.identity));
    }
    // The driver stays stopped: resuming it would need a state it no longer has, and a cursor handed back
    // to a loop that kept running during the action would move under whatever the action read.
    if (holder?.kind === 'driver') releasePointer(session.id, actionId);
    return jsonBlock(final.status, {
      ok: final.status === 'SUCCEEDED_VERIFIED' || final.status === 'EXECUTED_UNVERIFIED',
      status: final.status,
      decision: preflight.decision,
      reason: final.reason,
      verification: final.verification,
      error: final.error,
      version_before: final.beforeVersion,
      version_after: session.model.version,
      note:
        final.status === 'SUCCEEDED_VERIFIED'
          ? 'A later read of the page agreed with the action.'
          : final.status === 'EXECUTED_UNVERIFIED'
            ? 'Nothing re-read the page, so nobody can claim it worked.'
            : 'The page did not confirm the action.',
    });
  },
});

/** The collector's own id attribute for the target node, used only to find it for a scroll. */
function nodeId(action: Action, snapshot: Snapshot): string {
  const node = snapshot.nodes.find((n) => n.identity === action.target.identity);
  return node?.backendId ?? '';
}
