import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { validateAttachEndpoint } from '../../core/browser-use-registry.js';
import { requireStr, bool } from '../../core/input.js';
import { parseJsonArray } from './_shared.js';

/**
 * pro_browser_use_browsers_attach_validate — Ask whether an attach endpoint is allowed here
 * Pack: browser_use (pro-fetch)
 */
export default defineTool({
  name: 'pro_browser_use_browsers_attach_validate',
  description:
    'Check a native-attachment endpoint against this project’s policy before connecting: loopback is allowed, a private address needs an explicit opt-in, and a public host is never accepted. Returns the parsed host and port.',
  category: 'browser_use',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      endpoint: {
        type: 'string',
        description: 'http(s):// or ws(s):// debugging endpoint, e.g. http://127.0.0.1:9222',
      },
      allow_remote: {
        type: 'boolean',
        description: 'Permit a non-loopback host (default false) — a remote debugger executes JS in a real profile',
      },
      allowed_hosts: { type: 'string', description: 'JSON array of hostnames to permit even when not loopback' },
    },
    required: ['endpoint'],
    additionalProperties: false,
  },
  async handler(input) {
    const endpoint = requireStr(input, 'endpoint');
    let hosts: string[] | undefined;
    if (input.allowed_hosts !== undefined) {
      const parsed = parseJsonArray(input.allowed_hosts, 'allowed_hosts');
      if (!parsed.ok) return fail(parsed.error!);
      hosts = parsed.value.map(String);
    }
    const verdict = validateAttachEndpoint(endpoint, {
      allowRemote: bool(input, 'allow_remote'),
      ...(hosts ? { allowedHosts: hosts } : {}),
    });
    return jsonBlock(verdict.ok ? 'endpoint allowed' : 'endpoint refused', {
      ok: verdict.ok,
      endpoint: endpoint.slice(0, 200),
      host: verdict.host,
      port: verdict.port,
      scheme: verdict.scheme,
      reason: verdict.reason,
      note: 'Credentials in an endpoint are refused outright: configure the endpoint, do not embed a user in the URL.',
    });
  },
});
