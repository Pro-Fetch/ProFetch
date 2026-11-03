import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { requireSession, SessionError, tabs } from '../../core/browser-use-session.js';
import { optionalStr } from '../../core/input.js';

/**
 * pro_browser_use_tabs — The tabs this session's browser is holding
 * Pack: browser_use (pro-fetch)
 */
export default defineTool({
  name: 'pro_browser_use_tabs',
  description:
    'List the tabs in a session’s browser context with their urls, titles and which one this session drives. A restored profile can carry tabs of its own, and a tool that assumed otherwise would miscount.',
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
      const list = await tabs(session);
      return jsonBlock(`${list.length} tab(s)`, {
        ok: true,
        tabs: list,
        note: 'Only the active tab has a world model; the others are reported as they are.',
      });
    } catch (error) {
      if (error instanceof SessionError) return fail(error.message);
      throw error;
    }
  },
});
