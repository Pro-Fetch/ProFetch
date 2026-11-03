import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { cookies, requireSession, SessionError, storageState } from '../../core/browser-use-session.js';
import { optionalStr, bool } from '../../core/input.js';

/**
 * pro_browser_use_state_read — Cookies and storage state of the session’s origin
 * Pack: browser_use (pro-fetch)
 */
export default defineTool({
  name: 'pro_browser_use_state_read',
  description:
    "Read the cookies the session's origin currently holds, and optionally its storage state (per-origin localStorage). Read-only: this engine does not write another site's jar.",
  category: 'browser_use',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Open session' },
      include_storage: { type: 'boolean', description: 'Also return the storage state document (default false)' },
    },
    required: ['session_id'],
    additionalProperties: false,
  },
  async handler(input) {
    try {
      const session = requireSession(optionalStr(input, 'session_id'));
      const jar = await cookies(session);
      return jsonBlock(`${jar.length} cookie(s) for ${session.url}`, {
        ok: true,
        origin: session.url,
        cookies: jar.map((c) => {
          const value = typeof c.value === 'string' ? c.value : String(c.value ?? '');
          return {
            name: c.name,
            // The presence of a session cookie is a fact about the page; its value is a credential.
            value: value.length > 24 ? `${value.slice(0, 24)}…` : value,
            value_length: value.length,
            domain: c.domain,
            path: c.path,
            http_only: c.httpOnly,
            secure: c.secure,
            same_site: c.sameSite,
            expires: c.expires,
          };
        }),
        storage: bool(input, 'include_storage') ? await storageState(session) : undefined,
        note: 'Values are clipped to 24 characters and their length is reported instead.',
      });
    } catch (error) {
      if (error instanceof SessionError) return fail(error.message);
      throw error;
    }
  },
});
