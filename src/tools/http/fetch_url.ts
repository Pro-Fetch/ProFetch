import { fetchUrl, fetchBatch } from '../../core/fetcher.js';
import { fetchWithOptions, traceRedirects, downloadToFile } from '../../core/http-client.js';
import { result, md, jsonBlock, fail } from '../../core/format.js';
import { clipToTokens } from '../../core/chunker.js';
import { cacheDir } from '../github/_env.js';
import path from 'node:path';

/**
 * pro_fetch_fetch_url — Fetch any URL and return clean readable content as markdown
 * Pack: http (REAL ✅) (pro-fetch)
 */
import { defineTool } from '../../core/tool.js';
import { view } from '../../core/input.js';
export default defineTool({
  name: 'pro_fetch_fetch_url',
  description: 'Fetch any URL and return clean readable content as markdown',
  category: 'http',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Manzil (URL)' },
      // `fetchUrl(url, { maxTokens: Number(p.max_tokens ?? 8000) })`. Without it the response is cut at
      // 8 000 tokens and the caller has no way to ask for more.
      max_tokens: { type: 'number', description: 'Javob uzunligi limiti, token' },
      // A 200 that returns an HTML shell is not a document. By default such a page is re-read in a headless
      // browser and the answer says it was (`method: browser`). `false` forces the pure HTTP answer even then;
      // PRO_FETCH_BROWSER_ESCALATION=0 turns the second stage off server-wide.
      escalate: { type: 'boolean', description: 'HTML shell bo‘lsa brauzerda qayta o‘qish (default true)' },
    },
    required: ['url'],
  },
  async handler(input) {
    const p = view(input);
    const escalate = typeof input.escalate === 'boolean' ? input.escalate : undefined;
    const r = await fetchUrl(String(p.url), { maxTokens: Number(p.max_tokens ?? 8000), escalate });
    if (r.blocked) {
      const excerpt = r.markdown.replace(/\s+/g, ' ').slice(0, 220);
      return fail(
        `Blok sahifasi (HTTP ${r.status}, ${r.blocked.kind}: ${r.blocked.marker}). Bu manba javob bermadi — kontent emas, rad etish qaytdi.\n` +
          `Nima qilish kerak: ${r.blocked.hint}\n` +
          `Host aytgani: ${excerpt}`,
      );
    }
    return {
      content: [
        {
          type: 'text',
          text:
            '# ' +
            r.url +
            '\n\n' +
            r.markdown +
            '\n\n---\nstatus: ' +
            r.status +
            ' | ' +
            r.contentType +
            ' | ~' +
            r.tokens +
            ' token' +
            (r.cached ? ' | cache' : '') +
            // Which artefact this is: what the server sent, or what its scripts drew. The caller cannot judge
            // a document they cannot locate, and the reason for the difference is measured, not assumed.
            ' | method: ' +
            (r.method ?? 'http') +
            (r.method === 'browser'
              ? ' (' + (r.escalation_reason ?? '') + ', ' + (r.browser_ms ?? 0) + 'ms)'
              : r.escalation_reason
                ? ' | escalation: ' + r.escalation_reason
                : '') +
            (r.compat_ua ? ' | compat_ua: brauzer User-Agent ishlatilidi (PRO_FETCH_HTTP_COMPAT_UA)' : ''),
        },
      ],
    };
  },
});
