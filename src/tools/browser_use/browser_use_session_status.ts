import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { requireSession, sessionIds, sessionSummary, SessionError } from '../../core/browser-use-session.js';
import { describeLedger } from '../../core/browser-use-coverage.js';
import { summarizeModel } from '../../core/browser-use-world.js';
import { optionalStr } from '../../core/input.js';

/**
 * pro_browser_use_session_status — What the session currently believes about the page
 * Pack: browser_use (pro-fetch)
 */
export default defineTool({
  name: 'pro_browser_use_session_status',
  description:
    'The world model and coverage ledger for an open session: model version, document signature, identities known, what changed last, and which bands, frames and budgets are still unread. Costs nothing — no new read of the page.',
  category: 'browser_use',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Session from browser_use_session_open' },
    },
    required: ['session_id'],
    additionalProperties: false,
  },
  async handler(input) {
    try {
      const session = requireSession(optionalStr(input, 'session_id'));
      return jsonBlock(`${session.id} at v${session.model.version}`, {
        ok: true,
        ...sessionSummary(session),
        model: summarizeModel(session.model, 1200).text,
        coverage: session.ledger ? describeLedger(session.ledger, 1200).text : 'no ledger',
        transitions: session.model.transitions.slice(-6),
        evicted: session.model.evicted,
        open_sessions: sessionIds().length,
      });
    } catch (error) {
      if (error instanceof SessionError) return fail(`${error.message}${error.hint ? ` — ${error.hint}` : ''}`);
      throw error;
    }
  },
});
