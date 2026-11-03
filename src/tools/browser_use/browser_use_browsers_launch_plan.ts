import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { adapterFor, planFor } from '../../core/browser-use-adapters.js';
import { currentOs, detectInstalled } from '../../core/browser-use-runtime.js';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { requireStr } from '../../core/input.js';

/**
 * pro_browser_use_browsers_launch_plan — Show how a browser would be launched, without launching it
 * Pack: browser_use (pro-fetch)
 */
export default defineTool({
  name: 'pro_browser_use_browsers_launch_plan',
  description:
    'The exact executable, profile directory, arguments and warnings a product would be started with — inspected before anything runs, so a wrong flag is found here rather than in a crashed browser.',
  category: 'browser_use',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      product: { type: 'string', description: 'Browser product, e.g. chrome, edge, firefox, opera_gx' },
      headless: { type: 'boolean', description: 'Headless launch (default true)' },
      debugging_port: { type: 'number', description: 'Expose a CDP debugging port on this number' },
      profile_root: {
        type: 'string',
        description: 'Directory to keep the isolated profile in (default: the system temp dir)',
      },
    },
    required: ['product'],
    additionalProperties: false,
  },
  async handler(input) {
    const product = requireStr(input, 'product');
    const adapter = adapterFor(product);
    if (!adapter) {
      const detected = (await detectInstalled({ readVersions: false })).map((b) => b.product);
      return fail(
        `No adapter for "${product}". Recognised here: ${detected.join(', ') || 'nothing installed'}; the full registry lists ${
          adapterFor('chrome') ? '21' : '?'
        } products.`,
      );
    }
    const root =
      typeof input.profile_root === 'string' && input.profile_root
        ? input.profile_root
        : path.join(tmpdir(), 'pro-fetch-browser-use');
    const candidates = adapter.candidates(currentOs());
    const found = candidates.find((p) => {
      try {
        return existsSync(p);
      } catch {
        return false;
      }
    });
    const planned = planFor(
      product,
      {
        headless: input.headless !== false,
        executablePath: found ?? candidates[0] ?? '',
        ...(typeof input.debugging_port === 'number' ? { debuggingPort: input.debugging_port } : {}),
      },
      root,
    );
    if (!planned.ok)
      return jsonBlock(`${product}: cannot be planned`, { ok: false, reason: planned.reason, adapter: adapter.label });
    const { plan } = planned;
    return jsonBlock(`${product}: launch plan`, {
      ok: true,
      label: adapter.label,
      engine: adapter.engine,
      executable: plan.executablePath || '(no candidate found on this host)',
      executable_exists: !!found,
      user_data_dir: plan.userDataDir,
      args: plan.args,
      env: plan.env,
      notes: plan.notes,
      checked_candidates: candidates,
      // A product that cannot be automated on this OS surfaces through the plan's notes and an absent
      // executable; there is no separate platform flag to consult.
      executable_required: true,
    });
  },
});
