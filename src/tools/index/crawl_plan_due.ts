import { defineTool } from '../../core/tool.js';
import { jsonBlock } from '../../core/format.js';
import { num, view } from '../../core/input.js';
import { planDue } from '../../core/local-index.js';

/**
 * pro_crawl_plan_due — which pages are due to be read again
 * Pack: index (pro-fetch)
 *
 * ## Why this is a question and not a background job
 *
 * A crawler that revisits on its own needs a process that never exits, a clock it owns and somewhere to
 * keep running state between calls. This server is a stdio process started by an agent: it is not there
 * in an hour. So the schedule is kept — every indexed document gets a `next_due_ms`, and a page observed
 * changing three times in a row is re-planned sooner, down to a one-hour floor — but the *decision to act*
 * stays with the caller, which is the honest shape for this architecture.
 *
 * A cron, a workflow or an agent calling this every hour is a real freshness system. This tool pretending
 * to run one when it does not would be the kind of claim this repository tests against.
 */
export default defineTool({
  name: 'pro_crawl_plan_due',
  description:
    "Qayta o'qish navbatidagi sahifalar: muddati yetganlar eng avval. Interval sahifa turiga qarab " +
    '(news 1 soat, docs 1 kun, page 1 hafta, reference 1 oy) va kuzatilgan o‘zgarishlar bilan qisqaradi.',
  category: 'index',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Nechta manzil (standart 50)' },
    },
    required: [],
  },
  async handler(input) {
    const p = view(input);
    const limit = Math.max(1, Math.min(500, num(p, 'limit', 50) || 50));
    const { due, overdue, scheduled } = await planDue(Date.now(), limit);
    return jsonBlock(`Qayta o‘qish navbati (${overdue} ta)`, {
      ok: true,
      scheduled,
      due_now: overdue,
      returned: due.length,
      ...(due.length === 0
        ? {
            empty: true,
            note:
              scheduled === 0
                ? 'jadval bo‘sh — avval pro_index_fetch yoki pro_index_put bilan sahifa qo‘shing.'
                : `${scheduled} sahifa jadvalda, hozir hech birining muddati yetmagan.`,
          }
        : {}),
      due,
      how_to_use:
        "har soatda shu tool'ni chaqirib, due[] dagilarni pro_index_fetch bilan qayta o'qing — bu muntazam " +
        'qayta ko‘rishning to‘liq tsikli. Server fon jarayonini o‘zi yuritmaydi.',
    });
  },
});
