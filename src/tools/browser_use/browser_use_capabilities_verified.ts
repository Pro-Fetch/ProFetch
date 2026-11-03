import { defineTool } from '../../core/tool.js';
import { jsonBlock } from '../../core/format.js';
import { VERIFIED } from '../../core/browser-use-verified.js';
import { existsSync } from 'node:fs';
import { optionalStr } from '../../core/input.js';

/**
 * pro_browser_use_capabilities_verified — Which capability rows this project has actually run
 * Pack: browser_use (pro-fetch)
 */
export default defineTool({
  name: 'pro_browser_use_capabilities_verified',
  description:
    'The verified-facts overlay: which capability rows were run on a real browser, on which OS and version, and the probe artifact and step that prove each one. Rows only read from a specification are excluded by definition.',
  category: 'browser_use',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      product: { type: 'string', description: 'Limit to one product' },
      check_artifacts: { type: 'boolean', description: 'Verify each cited run log is still on disk (default true)' },
    },
    required: [],
    additionalProperties: false,
  },
  async handler(input) {
    const product = optionalStr(input, 'product');
    const rows = VERIFIED.filter((f) => !product || f.product === product).map((f) => ({
      product: f.product,
      capability: f.capability,
      os: f.os,
      browser_version: f.browserVersion,
      probe_step: f.probeStep,
      evidence: f.evidence,
      evidence_present: input.check_artifacts === false ? undefined : existsSync(f.evidence),
      date: f.date,
      note: f.note,
    }));
    return jsonBlock(`${rows.length} verified capability rows`, {
      count: rows.length,
      products: [...new Set(rows.map((r) => r.product))],
      rows,
      // Without this the overlay reads as a claim about browsers in general.
      note: 'Every row is a fact about one host. Nothing here is true of Firefox, Safari or a Linux box until it is run there.',
    });
  },
});
