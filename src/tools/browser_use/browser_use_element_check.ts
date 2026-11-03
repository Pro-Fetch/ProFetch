import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { requireSession, SessionError } from '../../core/browser-use-session.js';
import { resolveInModel } from '../../core/browser-use-world.js';
import { requireStr, optionalStr } from '../../core/input.js';

/**
 * pro_browser_use_element_check — Is the element I was shown still the one I would act on?
 * Pack: browser_use (pro-fetch)
 */
export default defineTool({
  name: 'pro_browser_use_element_check',
  description:
    'Resolve a stored identity against the session’s current model: FRESH, MOVED, CHANGED, GONE, REPLACED, ID_RECYCLED or NAVIGATED, with the reason and — for a relabelled element — the identity to use instead.',
  category: 'browser_use',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Open session' },
      identity: { type: 'string', description: 'The identity that was handed out' },
      backend_id: { type: 'string', description: 'Node id the caller was shown' },
      token: { type: 'string', description: 'Lifetime token the caller was shown' },
    },
    required: ['session_id', 'identity', 'backend_id'],
    additionalProperties: false,
  },
  async handler(input) {
    try {
      const session = requireSession(optionalStr(input, 'session_id'));
      const result = resolveInModel(session.model, {
        identity: requireStr(input, 'identity'),
        backendId: requireStr(input, 'backend_id'),
        ...(optionalStr(input, 'token') ? { token: optionalStr(input, 'token')! } : {}),
      });
      return jsonBlock(result.staleness, {
        ok: true,
        staleness: result.staleness,
        actionable: result.ok,
        remembered: result.remembered,
        reason: result.detail,
        replacement: result.replacement,
        element: result.node
          ? {
              role: result.node.role,
              name: result.node.name,
              rect: result.node.rect,
              interactable: result.node.interactable,
            }
          : undefined,
        note: 'A replacement is offered only when the same DOM node is still there with different words; acting on it is still the caller’s decision.',
      });
    } catch (error) {
      if (error instanceof SessionError) return fail(error.message);
      throw error;
    }
  },
});
