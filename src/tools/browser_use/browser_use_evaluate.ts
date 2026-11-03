import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { livePage, requireSession, SessionError } from '../../core/browser-use-session.js';
import { requireStr } from '../../core/input.js';

/**
 * pro_browser_use_evaluate — Run script in the page, when the operator allows it
 * Pack: browser_use (pro-fetch)
 *
 * The JS kill switch is enforced by dispatch (`security-policy`), not here: a tool that re-implements a
 * policy is how a policy starts to disagree with itself.
 */
export default defineTool({
  name: 'pro_browser_use_evaluate',
  description:
    'Evaluate a JavaScript expression inside a session page and return the JSON result. Refused unless PRO_FETCH_ALLOW_JS is set: arbitrary script in an authenticated browser session can read tokens, submit forms and exfiltrate, which is a different risk class from every other tool here.',
  category: 'browser_use',
  annotations: { readOnlyHint: false, openWorldHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Open session' },
      expression: { type: 'string', description: 'An expression, e.g. (() => document.title)()' },
      max_chars: { type: 'number', description: 'Truncate a stringified result past this (default 8000)' },
    },
    required: ['session_id', 'expression'],
    additionalProperties: false,
  },
  async handler(input) {
    try {
      const session = requireSession(String(input.session_id ?? ''));
      const expression = requireStr(input, 'expression');
      if (expression.length > 4000) return fail(`expression is ${expression.length} characters; 4000 is the cap`);
      const page = livePage(session);
      const value = await page.evaluate(`(() => { return (${expression}); })()`);
      const rendered = JSON.stringify(value, null, 2) ?? 'null';
      const maxChars = Math.max(200, Number(input.max_chars ?? 8000));
      return jsonBlock('evaluated', {
        ok: true,
        value: rendered.length > maxChars ? rendered.slice(0, maxChars) + `\n…truncated at ${maxChars}` : rendered,
        type: Array.isArray(value) ? 'array' : typeof value,
        version: session.model.version,
        note: 'The model was not updated by this call: if the script changed the page, take a snapshot to fold the change in.',
      });
    } catch (error) {
      if (error instanceof SessionError) return fail(error.message);
      return fail(`evaluate failed: ${(error as Error).message}`);
    }
  },
});
