import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { refresh, requireSession, scrollTo, SessionError } from '../../core/browser-use-session.js';
import { coverageRatio, planScan, describeLedger } from '../../core/browser-use-coverage.js';
import { knownIdentities } from '../../core/browser-use-world.js';
import { optionalStr, num } from '../../core/input.js';

/**
 * pro_browser_use_scan — Read the whole page, band by band
 * Pack: browser_use (pro-fetch)
 */
export default defineTool({
  name: 'pro_browser_use_scan',
  description:
    'Scroll a session through the document in planned steps, re-reading at each one, until the coverage ledger has seen every band edge to edge or the budget runs out. Reports what the first screen was hiding.',
  category: 'browser_use',
  annotations: { readOnlyHint: false, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Open session' },
      max_steps: { type: 'number', description: 'Reads allowed in this call (default 6, hard cap 25)' },
      overlap: {
        type: 'number',
        description: 'Overlap between steps in CSS pixels (default a quarter of the viewport)',
      },
      budget: { type: 'number', description: 'Max elements per read (default 400)' },
    },
    required: ['session_id'],
    additionalProperties: false,
  },
  async handler(input) {
    try {
      const session = requireSession(optionalStr(input, 'session_id'));
      if (!session.ledger)
        throw new SessionError(
          'the session has no coverage ledger',
          're-open it; a session without a ledger cannot promise completeness',
        );
      const maxSteps = Math.min(25, num(input, 'max_steps', 6));
      const overlap = num(input, 'overlap', Math.round(session.model.latest.viewport.height / 4));
      const started = { ...session.ledger };
      const firstIdentities = new Set(knownIdentities(session.model));
      const newlyVisible: string[] = [];
      let reads = 0;
      let guard = 0;

      while (guard++ < maxSteps * 2) {
        const plan = planScan(session.ledger, { maxSteps: 2, overlapPx: overlap });
        if (!plan.scrolls.length) break;
        const visitedBefore = session.ledger.bands.filter((b) => b.visitedAt !== null).length;
        for (const y of plan.scrolls) {
          await scrollTo(session, y);
          reads++;
          for (const n of session.model.latest.nodes) {
            if (n.interactable && !firstIdentities.has(n.identity) && !newlyVisible.includes(n.name || n.tag)) {
              newlyVisible.push(n.name || n.tag);
            }
            firstIdentities.add(n.identity);
          }
        }
        const visitedAfter = session.ledger.bands.filter((b) => b.visitedAt !== null).length;
        // Progress is measured, not assumed: a plan that cannot cover a new band would loop forever.
        if (visitedAfter === visitedBefore) {
          return jsonBlock('scan stopped without progress', {
            ok: false,
            reason: `reading ${plan.scrolls.join(', ')} did not complete a single band (${plan.reason})`,
            coverage: describeLedger(session.ledger, 900).text,
          });
        }
        if (reads >= maxSteps) break;
      }

      const ratio = coverageRatio(session.ledger);
      return jsonBlock(
        `scan covered ${ratio === null ? 'an unknown fraction' : `${Math.round(ratio * 100)}%`} of the page`,
        {
          ok: true,
          reads,
          bands: session.ledger.bands.length,
          visited: session.ledger.bands.filter((b) => b.visitedAt !== null).length,
          coverage_ratio: ratio,
          complete: ratio !== null && ratio === 1,
          content_height: session.ledger.contentHeight,
          started_at: {
            bands: started.bands.length,
            visited: started.bands.filter((b) => b.visitedAt !== null).length,
          },
          only_found_by_scrolling: newlyVisible.slice(0, 20),
          only_found_count: newlyVisible.length,
          coverage: describeLedger(session.ledger, 900).text,
          model_version: session.model.version,
          note: 'An element below the fold is invisible to one read, not to the page: the list above is what the first screen was hiding.',
        },
      );
    } catch (error) {
      if (error instanceof SessionError) return fail(`${error.message}${error.hint ? ` — ${error.hint}` : ''}`);
      throw error;
    }
  },
});
