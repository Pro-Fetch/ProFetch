import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { refresh, requireSession, SessionError } from '../../core/browser-use-session.js';
import { serializeOutline } from '../../core/browser-use-perception.js';
import { optionalStr, num } from '../../core/input.js';

/**
 * pro_browser_use_outline — The actionable elements, cheaply
 * Pack: browser_use (pro-fetch)
 */
export default defineTool({
  name: 'pro_browser_use_outline',
  description:
    'Render the last read of a session as a budgeted outline: one line per element, indices the caller can quote, and an explicit count of what the budget left out. Costs no round trip to the page.',
  category: 'browser_use',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Open session' },
      max_chars: { type: 'number', description: 'Character budget (default 6000)' },
      interactable_only: { type: 'boolean', description: 'Only elements that can be acted on (default true)' },
      fresh: { type: 'boolean', description: 'Re-read the page first (default false)' },
      budget: { type: 'number', description: 'Element cap for a fresh read (default 400)' },
    },
    required: ['session_id'],
    additionalProperties: false,
  },
  async handler(input) {
    try {
      const session = requireSession(optionalStr(input, 'session_id'));
      if (input.fresh === true) await refresh(session, { budget: num(input, 'budget', 400) });
      const snapshot = session.model.latest;
      const outline = serializeOutline(snapshot, {
        maxChars: num(input, 'max_chars', 6000),
        includeNonInteractable: input.interactable_only === false,
      });
      return jsonBlock(`${outline.lines} line(s), ${outline.omitted} omitted`, {
        ok: true,
        version: session.model.version,
        lines: outline.lines,
        omitted: outline.omitted,
        truncated: outline.truncated,
        budget: snapshot.budget,
        outline: outline.text,
        note: outline.truncated
          ? `The character budget dropped ${outline.omitted} line(s); raise max_chars or query a region.`
          : 'Every element that qualified for the filter is listed.',
      });
    } catch (error) {
      if (error instanceof SessionError) return fail(`${error.message}${error.hint ? ` — ${error.hint}` : ''}`);
      throw error;
    }
  },
});
