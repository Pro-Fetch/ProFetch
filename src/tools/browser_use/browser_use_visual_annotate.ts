import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { readBinarySource } from '../../core/binary-source.js';
import { paintAnnotation, type AnnotationSpec, type Rgba, type RgbaImage } from '../../core/browser-use-visual.js';
import { parseJsonArray, parseRect, imageResult } from './_shared.js';
import { num } from '../../core/input.js';

/**
 * pro_browser_use_visual_annotate — Put element numbers onto a screenshot
 * Pack: browser_use (pro-fetch)
 */
export default defineTool({
  name: 'pro_browser_use_visual_annotate',
  description:
    'Draw numbered boxes for element rects onto a PNG and return it as base64, so a vision model sees the same indices the text outline used. The interior of each box is left untouched and the input image is never modified.',
  category: 'browser_use',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      image_base64: { type: 'string', description: 'PNG/JPEG to annotate (or image_url)' },
      image_url: { type: 'string', description: 'Image URL, fetched through the SSRF guard' },
      boxes: {
        type: 'string',
        description: 'JSON array of {"rect":{x,y,width,height},"index":n,"colour":[r,g,b,a]} in image pixels',
      },
      thickness: { type: 'number', description: 'Outline thickness in pixels (default 2)' },
      label_scale: { type: 'number', description: 'Digit scale; 1 = 3x5 pixels, 3 = 9x15 (default 2)' },
    },
    required: ['boxes'],
    additionalProperties: false,
  },
  async handler(input) {
    const parsed = parseBoxes(input.boxes);
    if (!parsed.ok) return fail(parsed.error!);
    const boxes = parsed.value;

    let bytes: Buffer;
    try {
      bytes = await readBinarySource(
        {
          ...(typeof input.image_base64 === 'string' ? { base64: input.image_base64 } : {}),
          ...(typeof input.image_url === 'string' ? { url: input.image_url } : {}),
        },
        'image',
        32 * 1024 * 1024,
      );
    } catch (error) {
      return fail(`image o‘qib bo‘lmadi — ${(error as Error).message}`);
    }
    const sharp = (await import('sharp')).default;
    const raw = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const image: RgbaImage = { width: raw.info.width, height: raw.info.height, data: new Uint8Array(raw.data) };

    // Which boxes the capture cannot show in full, so a caller knows the annotation is partial.
    const clipped = boxes
      .filter(
        (b) =>
          b.rect.x < 0 ||
          b.rect.y < 0 ||
          b.rect.x + b.rect.width > image.width ||
          b.rect.y + b.rect.height > image.height,
      )
      .map((b) => b.index);

    const painted = paintAnnotation(image, boxes, {
      thickness: Math.max(1, num(input, 'thickness', 2)),
      labelScale: Math.max(1, num(input, 'label_scale', 2)),
    });
    const out = await sharp(Buffer.from(painted.image.data), {
      raw: { width: image.width, height: image.height, channels: 4 },
    })
      .png()
      .toBuffer();

    return imageResult(
      {
        ok: true,
        width: image.width,
        height: image.height,
        pixels_written: painted.painted,
        boxes: painted.boxes,
        labels_outside: painted.labelsOutside,
        boxes_clipped: clipped,
        note: 'Coordinates are image pixels. Convert an element rect with browser_use_coords_convert(to=screenshot) first — CSS pixels and device pixels differ by the pixel ratio. The PNG is the next content item.',
      },
      out.toString('base64'),
    );
  },
});

function parseBoxes(raw: unknown): { ok: true; value: AnnotationSpec[] } | { ok: false; error: string } {
  const list = parseJsonArray(raw, 'boxes');
  if (!list.ok) return { ok: false, error: list.error! };
  const out: AnnotationSpec[] = [];
  list.value.forEach((entry, position) => {
    if (!entry || typeof entry !== 'object') return;
    const rec = entry as Record<string, unknown>;
    const rect = parseRect(rec.rect, `boxes[${position}].rect`);
    if (!rect.ok) return;
    const colour = Array.isArray(rec.colour) ? (rec.colour as number[]) : undefined;
    out.push({
      rect: rect.value,
      index: typeof rec.index === 'number' ? rec.index : position + 1,
      ...(colour && colour.length === 4 ? { colour: colour as unknown as Rgba } : {}),
    });
  });
  if (!out.length) return { ok: false, error: 'boxes: hech bir yaroqli rect topilmadi' };
  return { ok: true, value: out };
}
