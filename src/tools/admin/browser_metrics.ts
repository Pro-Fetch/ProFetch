import { defineTool } from '../../core/tool.js';
import { view, strOrEmpty } from '../../core/input.js';
import { jsonBlock, fail } from '../../core/format.js';
import { browserPoolStats, poolSettings } from '../../core/browser-pool.js';
import { breakerReport, breakerSettings } from '../../core/circuit-breaker.js';
import { readerBlockSetting, parseBlockKinds } from '../../core/resource-policy.js';
import { playwrightAvailable } from '../../core/browser-tools.js';

/**
 * pro_fetch_browser_metrics — Report the browser pool, the per-host circuit breakers and the reader policy
 * Pack: admin (REAL ✅) (pro-fetch)
 *
 * Every number here is counted by the code that uses it: the pool counts its own launches, reads, restarts
 * and queue waits; the breaker counts its own failures and trips. Nothing in this answer is estimated, and
 * an empty pool says zero rather than omitting the section — a report that hides an idle subsystem looks
 * identical to one that never ran, and those are different facts.
 */
const SECTIONS = ['pool', 'breaker', 'policy'] as const;

export default defineTool({
  name: 'pro_fetch_browser_metrics',
  description: 'Brauzer havzasi, host bo‘yicha circuit breaker va o‘quvchi siyosati hisobotlari',
  category: 'admin',
  inputSchema: {
    type: 'object',
    properties: {
      include: {
        type: 'string',
        description: 'Faqat shu bo‘limlar: pool, breaker, policy (vergul bilan)',
      },
      host: { type: 'string', description: 'breaker bo‘limida bitta hostga filtr' },
    },
  },
  async handler(input) {
    const p = view(input);
    const requested = strOrEmpty(p, 'include')
      .split(',')
      .map((name: string) => name.trim().toLowerCase())
      .filter(Boolean);
    const unknown = requested.filter((name: string) => !SECTIONS.includes(name as (typeof SECTIONS)[number]));
    if (unknown.length) {
      return fail(
        `pro_fetch_browser_metrics: nomaʼlum bo‘lim “${unknown.join(', ')}”. Ruxsat etilganlar: ${SECTIONS.join(', ')}.`,
      );
    }
    const wanted = (section: string) => requested.length === 0 || requested.includes(section);
    const report: Record<string, unknown> = {};
    if (wanted('pool')) {
      report.pool = { ...browserPoolStats(), settings: poolSettings() };
    }
    if (wanted('breaker')) {
      const full = breakerReport();
      const host = strOrEmpty(p, 'host').trim();
      report.breaker = host
        ? { ...full, entries: full.entries.filter((entry) => entry.host === host || entry.host === new URL(host).host) }
        : full;
      report.breaker_settings = breakerSettings();
    }
    if (wanted('policy')) {
      report.policy = {
        block_resources: Array.from(parseBlockKinds(readerBlockSetting()).kinds).sort(),
        playwright_available: await playwrightAvailable(),
      };
    }
    return jsonBlock('Brauzer metrikalari', report);
  },
});
