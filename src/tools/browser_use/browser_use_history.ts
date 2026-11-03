import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { requireSession, SessionError } from '../../core/browser-use-session.js';
import { optionalStr, num } from '../../core/input.js';

/**
 * pro_browser_use_history — The reads a session has taken, and what each one meant
 * Pack: browser_use (pro-fetch)
 */
export default defineTool({
  name: 'pro_browser_use_history',
  description:
    'The snapshot history and transition log of a session: which versions exist, whether each was a mutation, a scroll, a resize, a fragment change or a navigation, and how many nodes and omissions each read carried.',
  category: 'browser_use',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Open session' },
      limit: { type: 'number', description: 'Most recent entries to return (default 12)' },
    },
    required: ['session_id'],
    additionalProperties: false,
  },
  async handler(input) {
    try {
      const session = requireSession(optionalStr(input, 'session_id'));
      const limit = num(input, 'limit', 12);
      const history = session.model.history.slice(-limit);
      const transitions = session.model.transitions.slice(-limit);
      return jsonBlock(`v${session.model.version}: ${history.length} read(s) kept`, {
        ok: true,
        version: session.model.version,
        document: session.model.documentSignature,
        history,
        transitions,
        // The bound is a fact about the model, so it is reported rather than discovered by a caller
        // wondering why an older version is gone.
        history_limit: session.model.limits.history,
        evicted_identities: session.model.evicted,
        coverage_complete: session.ledger ? session.ledger.bands.every((b) => b.visitedAt !== null) : null,
        note:
          history.length < session.model.version
            ? `Only the last ${history.length} reads are kept (cap ${session.model.limits.history}); the model still holds every identity it has seen.`
            : 'Every read since the session opened is listed.',
      });
    } catch (error) {
      if (error instanceof SessionError) return fail(`${error.message}${error.hint ? ` — ${error.hint}` : ''}`);
      throw error;
    }
  },
});
