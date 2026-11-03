import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { historyStep, navigate, requireSession, SessionError } from '../../core/browser-use-session.js';
import { requireStr, optionalStr } from '../../core/input.js';

/**
 * pro_browser_use_navigate — Move a session through pages and history
 * Pack: browser_use (pro-fetch)
 */
export default defineTool({
  name: 'pro_browser_use_navigate',
  description:
    'Go to a URL, or step back, forward or reload in an open session. Every target passes the same SSRF guard as the first open, and the result says whether the model treated it as a new document (it should).',
  category: 'browser_use',
  annotations: { readOnlyHint: false, openWorldHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Open session' },
      to: { type: 'string', description: 'Public http(s) URL to navigate to' },
      action: { type: 'string', enum: ['back', 'forward', 'reload'], description: 'Or step through history instead' },
    },
    required: ['session_id'],
    additionalProperties: false,
  },
  async handler(input) {
    try {
      const session = requireSession(optionalStr(input, 'session_id'));
      const beforeDocument = session.model.documentSignature;
      const beforeUrl = session.url;
      const to = optionalStr(input, 'to');
      const step = optionalStr(input, 'action');
      if (to && step) return fail('to and action are alternatives: give one');
      if (!to && !step) return fail('to or action kerak');
      const result = to
        ? await navigate(session, to)
        : await historyStep(session, step as 'back' | 'forward' | 'reload');
      const transition = session.model.transitions.at(-1);
      return jsonBlock(`navigated: ${beforeUrl} → ${session.url}`, {
        ok: true,
        url: session.url,
        title: session.title,
        version: session.model.version,
        document_before: beforeDocument,
        document: session.model.documentSignature,
        new_document: session.model.documentSignature !== beforeDocument,
        transition,
        nodes: result.snapshot.nodes.length,
        identities_known: session.model.nodes.size,
        note:
          session.model.documentSignature === beforeDocument
            ? 'Same document signature: this was a same-document navigation, so old identities still mean what they meant.'
            : 'A new document: every identity from the previous page is void, and a target held from it will be refused rather than clicked by mistake.',
      });
    } catch (error) {
      if (error instanceof SessionError)
        return jsonBlock('navigation refused', { ok: false, error: error.message, hint: error.hint });
      throw error;
    }
  },
});
