import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { capture, livePage, refresh, requireSession, SessionError } from '../../core/browser-use-session.js';
import { optionalStr, num } from '../../core/input.js';

/**
 * pro_browser_use_resize — Change the viewport and prove the page followed
 * Pack: browser_use (pro-fetch)
 */
export default defineTool({
  name: 'pro_browser_use_resize',
  description:
    'Set the viewport size and pixel ratio of an open session, then re-read: innerWidth from the page, the size of a fresh capture, and whether geometry moved with it. A layout is only emulated if the numbers agree.',
  category: 'browser_use',
  annotations: { readOnlyHint: false, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Open session' },
      width: { type: 'number', description: 'Viewport width in CSS pixels (320–4000)' },
      height: { type: 'number', description: 'Viewport height in CSS pixels (240–4000)' },
      capture_check: { type: 'boolean', description: 'Take a screenshot and compare its size (default true)' },
    },
    required: ['session_id', 'width', 'height'],
    additionalProperties: false,
  },
  async handler(input) {
    try {
      const session = requireSession(optionalStr(input, 'session_id'));
      const width = num(input, 'width', 0, 0);
      const height = num(input, 'height', 0, 0);
      if (width < 320 || width > 4000 || height < 240 || height > 4000) {
        return fail(`refusing ${width}x${height}: the sane range is 320-4000 wide and 240-4000 tall`);
      }
      const page = livePage(session);
      await page.setViewportSize({ width, height });
      const inner = (await page.evaluate(
        `(() => ({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio }))()`,
      )) as { w: number; h: number; dpr: number };
      const { snapshot } = await refresh(session, {});
      const shot = input.capture_check === false ? null : await capture(session, 'viewport');
      let imageSize: { width: number; height: number } | null = null;
      if (shot) {
        const sharp = (await import('sharp')).default;
        const meta = await sharp(shot).metadata();
        imageSize = { width: meta.width ?? 0, height: meta.height ?? 0 };
      }
      const consistent =
        inner.w === width &&
        inner.h === height &&
        (!imageSize || (imageSize.width === width * inner.dpr && imageSize.height === height * inner.dpr));
      return jsonBlock(consistent ? `viewport is ${width}x${height}` : 'viewport numbers disagree', {
        ok: true,
        asked: { width, height },
        inner: { width: inner.w, height: inner.h },
        device_scale_factor: inner.dpr,
        capture: imageSize,
        consistent,
        version: session.model.version,
        viewport: snapshot.viewport,
        interactable_now: snapshot.nodes.filter((n) => n.interactable).length,
        note: consistent
          ? 'The page, the capture and the request agree, so a layout claim made at this size means something.'
          : 'These disagree. Treat geometry from this session as suspect until they match.',
      });
    } catch (error) {
      if (error instanceof SessionError) return fail(error.message);
      throw error;
    }
  },
});
