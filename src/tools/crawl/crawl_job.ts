import { defineTool } from '../../core/tool.js';
import { view, strOrEmpty, num } from '../../core/input.js';
import { jsonBlock, fail } from '../../core/format.js';
import { enqueueUrls, markResult, nextBatch, queueStats, reclaimStale } from '../../core/crawl-queue.js';

/**
 * pro_fetch_crawl_job — Change the persistent crawl queue: enqueue, claim, mark, reclaim
 * Pack: crawl (REAL ✅) (pro-fetch)
 *
 * Every action here writes. Reading the queue is a separate tool (`pro_fetch_crawl_job_status`) so that
 * `PRO_FETCH_READ_ONLY` keeps one available and the other refused, rather than refusing both because the
 * name belongs to a writer.
 */
const ACTIONS = ['enqueue', 'next', 'mark', 'reclaim'] as const;

export default defineTool({
  name: 'pro_fetch_crawl_job',
  description:
    'Saqlanadigan crawl navbatiga URL qoʻshish, daʼvo qilish, natijani belgilash, eskirgan daʼvolarni qaytarish',
  category: 'crawl',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...ACTIONS], description: 'enqueue | next | mark | reclaim' },
      urls: { type: 'array', description: 'enqueue uchun URL roʻyxati', items: { type: 'string' } },
      url: { type: 'string', description: 'mark uchun bitta URL' },
      depth: { type: 'number', description: 'enqueue uchun chuqurlik (default 0)' },
      source_url: { type: 'string', description: 'Bu URLʼni qaysi sahifa topdi (crawl grafigi)' },
      limit: { type: 'number', description: 'next uchun satrlar soni' },
      document_id: { type: 'string', description: 'mark uchun hujjat content-id (pro_fetch_document)' },
      error: { type: 'string', description: 'mark uchun oʻqish xatosi (muvaffaqiyatsizlik)' },
      older_than_ms: { type: 'number', description: 'reclaim: qancha vaqtdan band daʼvolar qaytarilsin' },
    },
    required: ['action'],
  },
  async handler(input) {
    const p = view(input);
    const action = strOrEmpty(p, 'action').trim().toLowerCase();
    if (!ACTIONS.includes(action as (typeof ACTIONS)[number])) {
      return fail(
        `pro_fetch_crawl_job: nomaʼlum action “${action}”. Ruxsat etilganlar: ${ACTIONS.join(', ')}. ` +
          `O‘qish uchun: pro_fetch_crawl_job_status.`,
      );
    }
    if (action === 'enqueue') {
      const urls = Array.isArray(input.urls) ? (input.urls as unknown[]) : [];
      if (urls.length === 0) return fail('enqueue uchun `urls` roʻyxati kerak (kamida bitta URL).');
      const report = await enqueueUrls(urls, {
        depth: num(p, 'depth', 0),
        source_url: typeof input.source_url === 'string' ? input.source_url : undefined,
      });
      return jsonBlock('Navbatga qoʻshildi', { action, ...report, queue: await queueStats() });
    }
    if (action === 'next') {
      const rows = await nextBatch(num(p, 'limit', 10));
      return jsonBlock('Daʼvo qilinganlar', {
        action,
        count: rows.length,
        rows,
        ...(rows.length ? {} : { note: 'pending qator qolmadi' }),
      });
    }
    if (action === 'mark') {
      const url = strOrEmpty(p, 'url').trim();
      if (!url) return fail('mark uchun `url` kerak.');
      const outcome = await markResult(url, {
        document_id: typeof input.document_id === 'string' ? input.document_id : null,
        error: typeof input.error === 'string' ? input.error : null,
      });
      return jsonBlock('Natija belgilandi', { action, url, ...outcome });
    }
    const reclaimed = await reclaimStale(num(p, 'older_than_ms', 300_000));
    return jsonBlock('Qayta daʼvo', { action, reclaimed, queue: await queueStats() });
  },
});
