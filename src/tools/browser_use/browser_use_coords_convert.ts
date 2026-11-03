import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import {
  boxInScreenshot,
  centreOf,
  clickPoint,
  cssToDevice,
  deviceToCss,
  pageToViewport,
  toTopFrame,
  viewportToPage,
  type FrameOffset,
  type ScreenshotGeometry,
} from '../../core/browser-use-coordinates.js';
import { parseRect } from './_shared.js';
import { requireStr, num, optionalStr } from '../../core/input.js';

/**
 * pro_browser_use_coords_convert — Move a box between coordinate spaces
 * Pack: browser_use (pro-fetch)
 */
export default defineTool({
  name: 'pro_browser_use_coords_convert',
  description:
    'Convert an element rect between CSS viewport, CSS page, device pixels and screenshot pixels, and lift it out of a frame when the offset is known. Use it before clicking by coordinate or before cropping a screenshot.',
  category: 'browser_use',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      rect: { type: 'string', description: 'JSON {"x","y","width","height"} in CSS viewport pixels' },
      to: {
        type: 'string',
        enum: ['css-page', 'css-viewport', 'device', 'screenshot', 'element-centre'],
        description: 'Target space. screenshot needs the capture description.',
      },
      scroll: { type: 'string', description: 'JSON {"x","y"} of the current scroll (for css-page / screenshot)' },
      device_scale_factor: { type: 'number', description: 'Pixel ratio (default 1)' },
      capture: { type: 'string', description: 'JSON {kind,image:{width,height},scroll,origin} for to=screenshot' },
      frame_id: { type: 'string', description: 'Which frame the rect belongs to (default main)' },
      frame_offsets: { type: 'string', description: 'JSON array of {frameId,x,y} measured offsets' },
    },
    required: ['rect', 'to'],
    additionalProperties: false,
  },
  async handler(input) {
    const rect = parseRect(input.rect, 'rect');
    if (!rect.ok) return fail(rect.error!);
    const to = requireStr(input, 'to');
    const dpr = num(input, 'device_scale_factor', 1);
    const scroll = parseScroll(input.scroll);
    const frameId = optionalStr(input, 'frame_id') ?? 'main';

    let value = rect.value!;
    const steps: string[] = [`css-viewport ${fmt(value)}`];

    // A nested frame's numbers are relative to that frame; lift first, or everything after is wrong.
    if (frameId !== 'main') {
      const offsets = parseOffsets(input.frame_offsets);
      if (!offsets) return fail('frame_offsets: JSON array of {frameId,x,y} kerak — offset o‘lchangan bo‘lishi shart');
      const lifted = toTopFrame(value, offsets, frameId);
      if (!lifted) {
        return jsonBlock('refused: no measured offset', {
          ok: false,
          reason: `frame ${frameId} has no measured offset in frame_offsets. Treating an unmeasured frame as if it sat at 0,0 would put this box somewhere in the parent document.`,
          asked_for: to,
        });
      }
      value = lifted;
      steps.push(`lifted from ${frameId} → ${fmt(value)}`);
    }

    switch (to) {
      case 'css-page':
        value = viewportToPage(value, scroll);
        break;
      case 'css-viewport':
        value = pageToViewport(value, scroll);
        break;
      case 'device':
        value = cssToDevice(value, dpr);
        break;
      case 'element-centre':
        return jsonBlock('element centre', {
          ok: true,
          css_viewport: centreOf(value),
          dpr,
          click: clickPoint(value, frameId),
        });
      case 'screenshot': {
        const geometry = parseCapture(input.capture, dpr, scroll);
        if (!geometry)
          return fail(
            'capture: JSON {kind:"viewport"|"full-page"|"element", image:{width,height}, scroll, origin?} kerak',
          );
        return jsonBlock('screenshot box', {
          ok: true,
          capture_kind: geometry.kind,
          image_box: boxInScreenshot(value, geometry),
          click_point: clickPoint(value, frameId),
          steps: [...steps, `device-space box in a ${geometry.kind} capture`],
          note: 'A full-page capture starts at the top of the document, a viewport capture at the scroll position, an element capture at the element. Mixing them is the usual off-by-viewport bug.',
        });
      }
      default:
        return fail(`to="${to}" noma'lum: css-page, css-viewport, device, screenshot yoki element-centre`);
    }
    steps.push(`${to} ${fmt(value)}`);
    return jsonBlock(`converted to ${to}`, {
      ok: true,
      rect: value,
      device_equivalent: cssToDevice(value, dpr),
      css_from_device: deviceToCss(cssToDevice(value, dpr), dpr),
      click_point: clickPoint(value, frameId),
      steps,
    });
  },
});

function fmt(r: { x: number; y: number; width: number; height: number }): string {
  return `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`;
}

function parseScroll(raw: unknown): { x: number; y: number } {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as { x?: number; y?: number };
      return { x: Number(parsed.x) || 0, y: Number(parsed.y) || 0 };
    } catch {
      return { x: 0, y: 0 };
    }
  }
  if (raw && typeof raw === 'object') {
    const rec = raw as { x?: number; y?: number };
    return { x: Number(rec.x) || 0, y: Number(rec.y) || 0 };
  }
  return { x: 0, y: 0 };
}

function parseOffsets(raw: unknown): FrameOffset[] | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(value)) return null;
  return value
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
    .map((e) => ({ frameId: String(e.frameId ?? ''), x: Number(e.x) || 0, y: Number(e.y) || 0 }));
}

function parseCapture(raw: unknown, dpr: number, scroll: { x: number; y: number }): ScreenshotGeometry | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  const kind = rec.kind;
  if (kind !== 'viewport' && kind !== 'full-page' && kind !== 'element') return null;
  const image = rec.image as { width?: number; height?: number } | undefined;
  if (!image || !image.width || !image.height) return null;
  const geometryScroll = rec.scroll ? parseScroll(rec.scroll) : scroll;
  const origin = rec.origin ? parseRect(rec.origin, 'capture.origin') : undefined;
  return {
    kind,
    deviceScaleFactor: Number(rec.deviceScaleFactor ?? dpr) || 1,
    image: { width: Number(image.width), height: Number(image.height) },
    scroll: geometryScroll,
    ...(origin?.ok ? { origin: origin.value } : {}),
  };
}
