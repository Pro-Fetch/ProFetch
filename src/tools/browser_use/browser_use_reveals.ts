import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { requireSession, SessionError } from '../../core/browser-use-session.js';
import { revealCandidates } from '../../core/browser-use-coverage.js';
import { optionalStr, num } from '../../core/input.js';

/**
 * pro_browser_use_reveals — Which hidden states could be opened, and how safely
 * Pack: browser_use (pro-fetch)
 */
export default defineTool({
  name: 'pro_browser_use_reveals',
  description:
    "List the reveal candidates in a session's current read — closed disclosures, hidden or off-region controls — each classified as reversible, needing confirmation, or refused, with the undo step named.",
  category: 'browser_use',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Open session' },
      limit: { type: 'number', description: 'Maximum candidates returned (default 12)' },
    },
    required: ['session_id'],
    additionalProperties: false,
  },
  async handler(input) {
    try {
      const session = requireSession(optionalStr(input, 'session_id'));
      const candidates = revealCandidates(session.model.latest, num(input, 'limit', 12));
      return jsonBlock(`${candidates.length} reveal candidate(s)`, {
        ok: true,
        version: session.model.version,
        candidates,
        refused: candidates.filter((c) => c.safety === 'REFUSED').map((c) => c.label),
        note: 'A closed disclosure contributes nothing while it is closed, so it is a candidate even when it is perfectly visible.',
      });
    } catch (error) {
      if (error instanceof SessionError) return fail(error.message);
      throw error;
    }
  },
});
