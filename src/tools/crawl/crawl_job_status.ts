import { existsSync } from 'node:fs';
import { defineTool } from '../../core/tool.js';
import { view, strOrEmpty, num } from '../../core/input.js';
import { jsonBlock, fail } from '../../core/format.js';
import { listState, queuePath, queueStats, type QueueState } from '../../core/crawl-queue.js';

/**
 * pro_fetch_crawl_job_status — Read the persistent crawl queue without changing it
 * Pack: crawl (REAL ✅) (pro-fetch)
 *
 * The read half of the queue, kept apart from the write half on purpose: under `PRO_FETCH_READ_ONLY` an
 * operator can still ask what is owed, what is paid and how much of it turned out to be the same document,
 * while the tool that hands out work stays refused.
 *
 * It deliberately takes no `action` parameter. The action vocabulary is shared across every multi-action
 * tool in the server, and read-only mode decides on the action's name alone — inventing `stats`, `list` and
 * `path` here would have quietly widened what those words mean for every other tool. One tool, one job:
 * report the queue. Pass `state` to get the rows in one state instead of the counts.
 */
const STATES: QueueState[] = ['pending', 'fetching', 'done', 'failed', 'skipped_duplicate'];

export default defineTool({
  name: 'pro_fetch_crawl_job_status',
  description: 'Saqlanadigan crawl navbatining hisobi, fayl manzili va bir holatdagi qatorlari (o‘qish only)',
  category: 'crawl',
  inputSchema: {
    type: 'object',
    properties: {
      state: { type: 'string', enum: STATES, description: 'Berilgan holatdagi qatorlarni ro‘yxat qilib ber' },
      limit: { type: 'number', description: 'Ro‘yxat uchun satrlar soni (1-1000)' },
    },
  },
  async handler(input) {
    const p = view(input);
    const state = strOrEmpty(p, 'state').trim();
    const path = queuePath();
    const base = { file: path, exists: existsSync(path) };
    if (!state) return jsonBlock('Navbat holati', { ...base, queue: await queueStats() });
    if (!STATES.includes(state as QueueState)) {
      return fail(`pro_fetch_crawl_job_status: “${state}” yaroqsiz holat. Ruxsat etilganlar: ${STATES.join(', ')}.`);
    }
    const rows = await listState(state as QueueState, num(p, 'limit', 50));
    return jsonBlock('Navbat qatorlari', { ...base, state, count: rows.length, rows, queue: await queueStats() });
  },
});
