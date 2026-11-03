import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { diagnose, describeDiagnosis, type PageMeta } from '../../core/browser-use-health.js';
import { snapshotFromInput, parseJsonArray } from './_shared.js';
import { createLedger, recordSnapshot } from '../../core/browser-use-coverage.js';
import { num, optionalStr } from '../../core/input.js';

/**
 * pro_browser_use_health_diagnose — What is wrong with this page, from the read you have
 * Pack: browser_use (pro-fetch)
 */
export default defineTool({
  name: 'pro_browser_use_health_diagnose',
  description:
    'Diagnose a page from an injected node list plus document metadata: unnamed controls, unlabelled fields, unreachable interactables, tiny tap targets, missing alt text, no lang, horizontal overflow, duplicate ids, insecure origin. Findings carry evidence and the recovery this engine would attempt.',
  category: 'browser_use',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      nodes: { type: 'string', description: 'JSON node array as the last snapshot reported it' },
      meta: {
        type: 'string',
        description:
          'JSON {title,lang,hasViewportMeta,doctype,horizontalOverflow,duplicateIdCount,images,imagesWithoutAlt,frameCount}',
      },
      url: { type: 'string', description: 'Page url (default about:blank)' },
      content_height: {
        type: 'number',
        description: 'Document height in CSS pixels, if known — lets the report say the page was read to the bottom',
      },
      scroll_positions: {
        type: 'string',
        description: 'JSON array of scroll y values already read, to credit coverage without a live session',
      },
    },
    required: ['nodes', 'meta'],
    additionalProperties: false,
  },
  async handler(input) {
    const built = snapshotFromInput(input.nodes, optionalStr(input, 'url') ?? 'about:blank');
    if (!built.ok) return fail(built.error!);
    const meta = await parseMeta(input.meta, optionalStr(input, 'url') ?? 'about:blank');
    if ('error' in meta) return fail(meta.error);
    const parsed = meta.value;

    let ledger = null;
    const height = num(input, 'content_height', 0, 0);
    if (height > 0) {
      ledger = createLedger(built.value.snapshot, { contentHeight: height });
      const positions = parseJsonArray(input.scroll_positions ?? '[]', 'scroll_positions');
      if (positions.ok) {
        for (const y of positions.value) {
          const scrollY = Number(y);
          if (!Number.isFinite(scrollY)) continue;
          ledger = recordSnapshot(
            ledger,
            { ...built.value.snapshot, scroll: { x: 0, y: scrollY }, id: `${built.value.snapshot.id}+${scrollY}` },
            { stepCosts: false },
          );
        }
      }
    }

    const result = diagnose(built.value.snapshot, parsed, ledger);
    const described = describeDiagnosis(result, 1600);
    return jsonBlock(`${result.blocking} blocking, ${result.degraded} degraded, ${result.notice} notice`, {
      ...result,
      text: described.text,
      note: 'Findings describe the read, not the whole page: anything the budget dropped or a scroll never reached is listed in `skipped` and the gaps.',
    });
  },
});

/** `meta` is an object, so the array parser is not used for it; a wrong shape is a readable refusal. */
function parseMeta(raw: unknown, url: string): { value: PageMeta } | { error: string } {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch (error) {
      return { error: `meta: JSON ajratib bo'lmadi — ${(error as Error).message}` };
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { error: 'meta: JSON obyekti kerak {title,lang,hasViewportMeta,…}' };
  const rec = value as Record<string, unknown>;
  const text = (key: string): string => (typeof rec[key] === 'string' ? (rec[key] as string) : '');
  const count = (key: string): number =>
    typeof rec[key] === 'number' && Number.isFinite(rec[key] as number) ? (rec[key] as number) : 0;
  return {
    value: {
      url: typeof rec.url === 'string' && rec.url ? rec.url : url,
      title: text('title'),
      lang: text('lang'),
      hasViewportMeta: rec.hasViewportMeta === true,
      doctype: text('doctype'),
      horizontalOverflow: count('horizontalOverflow'),
      duplicateIdCount: count('duplicateIdCount'),
      images: count('images'),
      imagesWithoutAlt: count('imagesWithoutAlt'),
      frameCount: count('frameCount'),
      ...(typeof rec.loadSeconds === 'number' ? { loadSeconds: rec.loadSeconds } : {}),
    },
  };
}
