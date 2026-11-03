import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import {
  CAPABILITY_PROFILES,
  capabilityOf,
  missingFor,
  profileFor,
  supports,
} from '../../core/browser-use-capabilities.js';
import { parseCapabilities } from './_shared.js';
import { requireStr, optionalStr } from '../../core/input.js';
import type { BrowserProtocol } from '../../core/browser-use-contract.js';

/**
 * pro_browser_use_capabilities_check — Can this product do these things, and what says so
 * Pack: browser_use (pro-fetch)
 */
export default defineTool({
  name: 'pro_browser_use_capabilities_check',
  description:
    'Per-capability answer for one product: status, evidence class, the protocol it goes over, and the reason. UNKNOWN is a no — an unread specification is not a promise.',
  category: 'browser_use',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      product: { type: 'string', description: 'Browser product key, e.g. chrome, firefox, safari, edge' },
      capabilities: { type: 'string', description: 'JSON array of capability names to check' },
      via: { type: 'string', description: 'Restrict to one protocol (cdp, bidi, webdriver…)' },
      require_verified: {
        type: 'boolean',
        description: 'Only count rows actually run somewhere as a yes (default false)',
      },
    },
    required: ['product', 'capabilities'],
    additionalProperties: false,
  },
  async handler(input) {
    const product = requireStr(input, 'product');
    if (!profileFor(product)) {
      return fail(
        `"${product}" has no capability profile. Known products: ${Object.keys(CAPABILITY_PROFILES).sort().join(', ')}`,
      );
    }
    const requested = parseCapabilities(input.capabilities);
    if (!requested.ok) return fail(requested.error!);
    const via = optionalStr(input, 'via') as BrowserProtocol | undefined;
    const answers = requested.value.map((capability) => {
      const result = supports(product, capability, {
        allowPartial: input.require_verified !== true,
        ...(via ? { via } : {}),
      });
      const full = capabilityOf(product, capability);
      return {
        capability,
        yes: result.yes,
        status: full?.status ?? 'ABSENT',
        evidence: full?.evidence ?? 'no profile row',
        via: full?.via,
        reason: full?.reason ?? 'this product has no entry for the capability',
      };
    });
    return jsonBlock(`${product}: ${answers.filter((a) => a.yes).length}/${answers.length} supported`, {
      product,
      engine: profileFor(product)!.engine,
      protocols: profileFor(product)!.protocols,
      answers,
      missing: missingFor(product, requested.value),
      note: 'A `p` row is read from a specification or source, not run on a machine; `require_verified=true` treats those as a no.',
    });
  },
});
