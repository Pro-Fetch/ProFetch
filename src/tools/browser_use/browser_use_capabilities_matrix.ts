import { defineTool } from '../../core/tool.js';
import { md, jsonBlock } from '../../core/format.js';
import { renderEngineSupportMatrix } from '../../core/browser-use-matrix.js';
import { currentOs } from '../../core/browser-use-runtime.js';
import { optionalStr } from '../../core/input.js';

/**
 * pro_browser_use_capabilities_matrix — The engine support matrix, as this host computed it
 * Pack: browser_use (pro-fetch)
 */
export default defineTool({
  name: 'pro_browser_use_capabilities_matrix',
  description:
    'Render the support matrix: every product against every capability, with the glyph legend. `Y*` means this host ran it, `p` means read from a specification — the difference is the point of the table.',
  category: 'browser_use',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      format: { type: 'string', enum: ['markdown', 'json'], description: 'markdown (default) or a parsed summary' },
      host_os: {
        type: 'string',
        enum: ['windows', 'macos', 'linux'],
        description: 'Compute verified rows as if on another OS (default: this one)',
      },
    },
    required: [],
    additionalProperties: false,
  },
  async handler(input) {
    const os = optionalStr(input, 'host_os');
    const rendered = renderEngineSupportMatrix((os as never) ?? currentOs());
    if (optionalStr(input, 'format') === 'json') {
      // The counts are what a caller compares between runs; the table body stays in the markdown form.
      const counts: Record<string, number> = {};
      for (const line of rendered.split('\n')) {
        const m = /^\|\s*`([A-Z_]+)`\s*\|\s*(\d+)\s*\|$/.exec(line);
        if (m) counts[m[1]!] = Number(m[2]);
      }
      return jsonBlock(`matrix as of host ${os ?? currentOs()}`, {
        os: os ?? currentOs(),
        status_counts: counts,
        chars: rendered.length,
      });
    }
    return md(rendered, 12000);
  },
});
