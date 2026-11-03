import { defineTool } from '../../core/tool.js';
import { jsonBlock } from '../../core/format.js';
import { getSession, sessionIds, sessionSummary } from '../../core/browser-use-session.js';

/**
 * pro_browser_use_sessions_list — Which browser sessions are open
 * Pack: browser_use (pro-fetch)
 */
export default defineTool({
  name: 'pro_browser_use_sessions_list',
  description:
    'Every browser_use session this process is holding open, with its browser, url, model version and idle time. Idle sessions are reclaimed on the next open, not by a background timer.',
  category: 'browser_use',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  async handler() {
    const open = sessionIds()
      .map((id) => getSession(id))
      .filter((s): s is NonNullable<typeof s> => !!s)
      .map((s) => sessionSummary(s));
    return jsonBlock(`${open.length} open session(s)`, { ok: true, sessions: open });
  },
});
