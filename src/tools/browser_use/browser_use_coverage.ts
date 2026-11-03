import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { requireSession, SessionError } from '../../core/browser-use-session.js';
import { coverageRatio, describeLedger } from '../../core/browser-use-coverage.js';
import { optionalStr } from '../../core/input.js';

/**
 * pro_browser_use_coverage — What has this session actually looked at
 * Pack: browser_use (pro-fetch)
 */
export default defineTool({
  name: 'pro_browser_use_coverage',
  description:
    'The coverage ledger for a session: which scroll bands have been seen edge to edge, which frames were read or never produced a node, what the budgets dropped, and what remains unknown. An unread page is not a clean page.',
  category: 'browser_use',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: { session_id: { type: 'string', description: 'Open session' } },
    required: ['session_id'],
    additionalProperties: false,
  },
  async handler(input) {
    try {
      const session = requireSession(optionalStr(input, 'session_id'));
      if (!session.ledger) throw new SessionError('the session has no coverage ledger', 're-open it');
      const ledger = session.ledger;
      return jsonBlock(`coverage ${Math.round((coverageRatio(ledger) ?? 0) * 100)}%`, {
        ok: true,
        version: session.model.version,
        url: session.url,
        content_height: ledger.contentHeight,
        bands: ledger.bands.map((b) => ({
          y: b.y,
          height: b.height,
          seen_from: b.seenFrom,
          seen_to: b.seenTo,
          visited: b.visitedAt !== null,
          new_identities_booked: b.newIdentities,
        })),
        ratio: coverageRatio(ledger),
        complete: coverageRatio(ledger) === 1,
        frames: ledger.frames,
        omitted_by_budget: ledger.omittedByBudget,
        identities: ledger.identities.size,
        gaps: describeLedger(ledger, 1400).text,
        note: 'A band counts as seen only when the viewport covered it from edge to edge; brushing past it with an overlapping read does not count.',
      });
    } catch (error) {
      if (error instanceof SessionError) return fail(error.message);
      throw error;
    }
  },
});
