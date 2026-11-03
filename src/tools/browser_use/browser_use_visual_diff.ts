import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { readBinarySource } from '../../core/binary-source.js';
import { diffRgba, describeDiff, type RgbaImage } from '../../core/browser-use-visual.js';
import { num, bool } from '../../core/input.js';

/**
 * pro_browser_use_visual_diff — Compare two images pixel by pixel
 * Pack: browser_use (pro-fetch)
 */
export default defineTool({
  name: 'pro_browser_use_visual_diff',
  description:
    'Diff two PNG/JPEG images (base64 or URL) and report changed pixels, the bounding box of the change and a grid of hot regions. Different sizes are reported as not comparable instead of resampled.',
  category: 'browser_use',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      before_base64: { type: 'string', description: 'First image, base64 (or use before_url)' },
      before_url: { type: 'string', description: 'First image URL, fetched through the SSRF guard' },
      after_base64: { type: 'string', description: 'Second image, base64' },
      after_url: { type: 'string', description: 'Second image URL' },
      channel_tolerance: { type: 'number', description: 'Per-channel 0-255 tolerance (default 16; 0 is exact)' },
      ignore_alpha_only: { type: 'boolean', description: 'Treat an alpha-only repaint as unchanged (default true)' },
      columns: { type: 'number', description: 'Grid columns for region reporting (default 4)' },
      rows: { type: 'number', description: 'Grid rows (default 4)' },
    },
    required: [],
    additionalProperties: false,
  },
  async handler(input) {
    const a = await decode(input.before_base64, input.before_url, 'before');
    if (!a.ok) return fail(a.error!);
    const b = await decode(input.after_base64, input.after_url, 'after');
    if (!b.ok) return fail(b.error!);
    const columns = Math.max(1, num(input, 'columns', 4));
    const rows = Math.max(1, num(input, 'rows', 4));
    const result = diffRgba(a.value, b.value, {
      channelTolerance: num(input, 'channel_tolerance', 16),
      ignoreAlphaOnly: bool(input, 'ignore_alpha_only', true),
      grid: { columns, rows },
    });
    return jsonBlock(
      result.comparable ? `${result.changedPixels} of ${result.comparedPixels} pixels differ` : 'not comparable',
      {
        ...result,
        summary: describeDiff(result),
        note: 'Tolerance is per channel: font smoothing moves a channel by single digits, a real colour change by tens. A 0 tolerance makes every re-render a difference.',
      },
    );
  },
});

async function decode(
  base64: unknown,
  url: unknown,
  label: string,
): Promise<{ ok: true; value: RgbaImage } | { ok: false; error: string }> {
  if (typeof base64 !== 'string' && typeof url !== 'string') {
    return { ok: false, error: `${label}: base64 yoki url kerak` };
  }
  try {
    const bytes = await readBinarySource(
      { ...(typeof base64 === 'string' ? { base64 } : {}), ...(typeof url === 'string' ? { url } : {}) },
      label,
      32 * 1024 * 1024,
    );
    const sharp = (await import('sharp')).default;
    const raw = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return {
      ok: true,
      value: { width: raw.info.width, height: raw.info.height, data: new Uint8Array(raw.data) },
    };
  } catch (error) {
    return { ok: false, error: `${label}: rasm o‘qib bo‘lmadi — ${(error as Error).message}` };
  }
}
