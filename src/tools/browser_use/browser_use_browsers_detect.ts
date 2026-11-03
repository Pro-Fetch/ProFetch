import { defineTool } from '../../core/tool.js';
import { jsonBlock } from '../../core/format.js';
import { detectInstalled, currentOs } from '../../core/browser-use-runtime.js';
import { adapterFor } from '../../core/browser-use-adapters.js';

/**
 * pro_browser_use_browsers_detect — List the browsers this machine actually has
 * Pack: browser_use (pro-fetch)
 */
export default defineTool({
  name: 'pro_browser_use_browsers_detect',
  description:
    'Installed browsers on this host: product, engine, version, protocols and the executable path each was found at. Reports "not found" per product rather than a shorter list.',
  category: 'browser_use',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      versions: { type: 'boolean', description: 'Read each executable version (slower, default true)' },
    },
    required: [],
    additionalProperties: false,
  },
  async handler(input) {
    const readVersions = input.versions !== false;
    const found = await detectInstalled({ readVersions });
    return jsonBlock(`browsers on ${currentOs()}`, {
      os: currentOs(),
      found: found.map((b) => ({
        product: b.product,
        label: b.label,
        engine: b.engine,
        family: b.family,
        channel: b.channel,
        version: b.version || (readVersions ? 'found but unreadable' : 'not read'),
        // The protocols come from the adapter: a browser that is merely installed has not been asked
        // which protocol it speaks, and claiming otherwise would be a guess about the machine.
        protocols: adapterFor(b.product)?.protocols ?? [],
        executable: b.executablePath,
      })),
      // The absence list is the useful half: a caller choosing a browser needs to know what is *not*
      // here, not just what happened to be detected.
      not_found: readVersions && !found.length ? 'nothing the registry recognises is installed' : undefined,
      note: 'Detection is a fact about this host. A capability row that depends on it is only verified here.',
    });
  },
});
