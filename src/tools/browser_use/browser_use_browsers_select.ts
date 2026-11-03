import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { localRegistry } from '../../core/browser-use-runtime.js';
import { selectBrowser } from '../../core/browser-use-registry.js';
import { parseCapabilities } from './_shared.js';
import type { BrowserRequest } from '../../core/browser-use-contract.js';

/**
 * pro_browser_use_browsers_select — Choose a browser that can satisfy a capability list
 * Pack: browser_use (pro-fetch)
 */
export default defineTool({
  name: 'pro_browser_use_browsers_select',
  description:
    'Pick an installed browser for a task by required capabilities and connection mode. Refuses a browser that cannot do the job and says, per capability, why — it never substitutes a similar product.',
  category: 'browser_use',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      requires: {
        type: 'string',
        description: 'JSON array of capability names, e.g. ["accessibilityTree","hitTesting"]',
      },
      product: { type: 'string', description: 'Pin the product (chrome, edge, firefox, safari…)' },
      engine: { type: 'string', enum: ['chromium', 'firefox', 'webkit'], description: 'Limit to one engine' },
      mode: {
        type: 'string',
        enum: ['managed', 'native'],
        description: 'Launch ourselves, or attach to a running browser',
      },
      protocol: {
        type: 'string',
        enum: ['cdp', 'bidi', 'webdriver', 'playwright-webkit', 'appium', 'devtools-http'],
        description: 'Force a protocol',
      },
      endpoint: { type: 'string', description: 'Attach endpoint when mode=native' },
      min_major: { type: 'number', description: 'Minimum browser major version' },
      allow_partial: {
        type: 'boolean',
        description: 'Accept a capability only read from a specification (default true; false demands verified rows)',
      },
    },
    required: ['requires'],
    additionalProperties: false,
  },
  async handler(input) {
    const requires = parseCapabilities(input.requires);
    if (!requires.ok) return fail(requires.error!);
    const registry = await localRegistry({ readVersions: true });
    const request: BrowserRequest = {
      requires: requires.value,
      ...(typeof input.product === 'string' && input.product ? { product: input.product } : {}),
      ...(input.engine === 'chromium' || input.engine === 'firefox' || input.engine === 'webkit'
        ? { engine: input.engine }
        : {}),
      ...(input.mode === 'managed' || input.mode === 'native' ? { mode: input.mode } : {}),
      ...(typeof input.protocol === 'string' && input.protocol ? { protocol: input.protocol as never } : {}),
      ...(typeof input.endpoint === 'string' && input.endpoint ? { endpoint: input.endpoint } : {}),
      ...(typeof input.min_major === 'number' ? { minMajor: input.min_major } : {}),
    };
    const resolved = selectBrowser(registry, request, { allowPartial: input.allow_partial !== false });
    return jsonBlock(resolved.ok ? `selected ${resolved.browser?.product}` : 'no browser satisfies this request', {
      ok: resolved.ok,
      request,
      // A refusal carries the blocker and what could be used instead; a selection says what it stands on.
      ...(resolved.ok
        ? {
            product: resolved.browser!.product,
            version: resolved.browser!.version || 'unreadable',
            engine: resolved.browser!.engine,
            executable: resolved.browser!.executablePath,
            mode: resolved.mode,
            protocol: resolved.protocol,
          }
        : {
            blocker: resolved.blocker,
            closest: resolved.browser
              ? { product: resolved.browser.product, version: resolved.browser.version || 'unreadable' }
              : undefined,
            alternatives: resolved.alternatives,
            detected: registry.entries.map((e) => e.browser.product),
            note: 'A named product is never substituted. If it is not installed, that is the answer.',
          }),
    });
  },
});
