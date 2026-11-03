import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { closeSession, sessionIds, SessionError } from '../../core/browser-use-session.js';
import { optionalStr, bool } from '../../core/input.js';

/**
 * pro_browser_use_session_close — End a session and delete its temporary profile
 * Pack: browser_use (pro-fetch)
 */
export default defineTool({
  name: 'pro_browser_use_session_close',
  description:
    'Close one browser session, or every session this process opened, and delete the temporary profile directory each was started with. A profile the caller supplied is left in place.',
  category: 'browser_use',
  annotations: { readOnlyHint: false, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Session to close' },
      all: { type: 'boolean', description: 'Close every open session instead' },
    },
    required: [],
    additionalProperties: false,
  },
  async handler(input) {
    if (bool(input, 'all')) {
      const ids = sessionIds();
      let closed = 0;
      for (const id of ids) if (await closeSession(id)) closed++;
      return jsonBlock('sessions closed', {
        ok: true,
        closed,
        remaining: sessionIds(),
        note: 'Nothing is left running; a later call opens a fresh session.',
      });
    }
    const id = optionalStr(input, 'session_id');
    if (!id) return fail('session_id kerak (yoki all=true)');
    try {
      const closed = await closeSession(id);
      if (!closed)
        return fail(
          `"${id}" ochiq sessiyalar orasida yo'q — ochiqlari: ${sessionIds().join(', ') || 'hech qaysi biri'}`,
        );
      return jsonBlock('session closed', { ok: true, session_id: id, remaining: sessionIds() });
    } catch (error) {
      if (error instanceof SessionError) return fail(error.message);
      throw error;
    }
  },
});
