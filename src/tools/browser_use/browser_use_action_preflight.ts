import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { preflight, type Action, type ActionPolicy } from '../../core/browser-use-actions.js';
import { createWorldModel } from '../../core/browser-use-world.js';
import { snapshotFromInput } from './_shared.js';
import { requireStr, bool, optionalStr } from '../../core/input.js';

/**
 * pro_browser_use_action_preflight — Would this engine allow that action?
 * Pack: browser_use (pro-fetch)
 */
export default defineTool({
  name: 'pro_browser_use_action_preflight',
  description:
    'Run the action policy against a node list the caller supplies: does the identity resolve, is the element reachable, does this control take this value, and is the label one this engine will act on without a human? Answers with the reason and the point it would use.',
  category: 'browser_use',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['click', 'type', 'press', 'check', 'uncheck', 'select', 'scroll-to', 'hover', 'focus'],
        description: 'Kind of action',
      },
      nodes: { type: 'string', description: 'JSON node array as the last snapshot reported it' },
      identity: { type: 'string', description: 'Identity of the element to act on' },
      backend_id: { type: 'string', description: 'Node id the caller was shown' },
      token: { type: 'string', description: 'Lifetime token the caller was shown (recommended)' },
      value: {
        type: 'string',
        description: 'Text for type, key for press, option for select; "true"/"false" for check',
      },
      read_only: { type: 'boolean', description: 'Refuse every action that changes the page (PRO_FETCH_READ_ONLY)' },
      allow_reveal: { type: 'boolean', description: 'Allow hover/focus/scroll-to (default true)' },
      confirmed: { type: 'boolean', description: 'The caller has confirmed a NEEDS_CONFIRMATION action' },
      url: { type: 'string', description: 'Page url the nodes came from (default about:blank)' },
    },
    required: ['action', 'nodes', 'identity', 'backend_id'],
    additionalProperties: false,
  },
  async handler(input) {
    const built = snapshotFromInput(input.nodes, optionalStr(input, 'url') ?? 'about:blank');
    if (!built.ok) return fail(built.error!);
    const snapshot = built.value.snapshot;
    const node = snapshot.nodes.find((n) => n.identity === requireStr(input, 'identity'));
    if (!node) {
      return jsonBlock('REFUSE: identity not in this snapshot', {
        ok: true,
        decision: 'REFUSE',
        reason:
          'the identity the caller holds is not in the node list supplied — either the page changed or the reference came from elsewhere',
        identities_known: snapshot.nodes.length,
      });
    }
    const kind = requireStr(input, 'action') as Action['kind'];
    const raw = optionalStr(input, 'value');
    const value = kind === 'check' || kind === 'uncheck' ? (raw === undefined ? true : raw !== 'false') : raw;
    const action: Action = {
      kind,
      target: {
        identity: node.identity,
        backendId: requireStr(input, 'backend_id'),
        ...(optionalStr(input, 'token') ? { token: optionalStr(input, 'token')! } : {}),
        rect: node.rect,
      },
      ...(value === undefined ? {} : { value: value as string | boolean }),
    };
    const policy: ActionPolicy = {
      readOnly: bool(input, 'read_only'),
      allowReveal: input.allow_reveal !== false,
      confirmed: bool(input, 'confirmed'),
    };
    const model = createWorldModel(snapshot, { tabId: 'preflight' });
    const result = preflight(action, model, snapshot, policy);
    return jsonBlock(`${result.decision}: ${kind}`, {
      ok: true,
      decision: result.decision,
      reason: result.reason,
      point: result.point,
      scroll_hint: result.scrollHint,
      element: {
        role: node.role,
        name: node.name,
        tag: node.tag,
        rect: node.rect,
        visible: node.visible,
        interactable: node.interactable,
        conflicts: node.conflicts,
      },
      tokens_synthesised: built.value.tokensGuessed,
      note: built.value.tokensGuessed
        ? 'These nodes carried no lifetime token, so identity is weaker than a live snapshot: a re-render could look like the same element.'
        : 'A refusal here means nothing was sent to the page.',
    });
  },
});
