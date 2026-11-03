import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { capture, requireSession, SessionError } from '../../core/browser-use-session.js';
import { boxInScreenshot } from '../../core/browser-use-coordinates.js';
import { paintAnnotation, type AnnotationSpec } from '../../core/browser-use-visual.js';
import { optionalStr, bool, num } from '../../core/input.js';
import { imageResult } from './_shared.js';

/**
 * pro_browser_use_screenshot — Capture a session's page, optionally annotated
 * Pack: browser_use (pro-fetch)
 */
export default defineTool({
  name: 'pro_browser_use_screenshot',
  description:
    'Take a viewport, full-page or element screenshot from an open session and return it as base64 PNG, with the geometry needed to map DOM boxes onto its pixels. With annotate=true the interactable elements are outlined and numbered with the same indices the outline used.',
  category: 'browser_use',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Open session' },
      kind: {
        type: 'string',
        enum: ['viewport', 'full-page', 'element'],
        description: 'Capture kind (default viewport)',
      },
      identity: { type: 'string', description: 'For kind=element: which element to capture' },
      annotate: { type: 'boolean', description: 'Draw the numbered boxes (default false)' },
      max_labels: { type: 'number', description: 'How many elements to label (default 25)' },
    },
    required: ['session_id'],
    additionalProperties: false,
  },
  async handler(input) {
    try {
      const session = requireSession(optionalStr(input, 'session_id'));
      const kind = (optionalStr(input, 'kind') ?? 'viewport') as 'viewport' | 'full-page' | 'element';
      const snapshot = session.model.latest;
      let elementBox: { x: number; y: number; width: number; height: number } | undefined;
      if (kind === 'element') {
        const identity = optionalStr(input, 'identity');
        if (!identity) return fail('kind=element needs the identity of the element to capture');
        const node = snapshot.nodes.find((n) => n.identity === identity);
        if (!node) return fail(`"${identity}" is not in the session's latest read — take a fresh snapshot first`);
        elementBox = node.rect;
      }
      const png = await capture(session, kind, elementBox);
      const sharp = (await import('sharp')).default;
      const info = await sharp(png).metadata();
      const geometry = {
        kind,
        deviceScaleFactor: snapshot.deviceScaleFactor,
        image: { width: info.width ?? 0, height: info.height ?? 0 },
        scroll: snapshot.scroll,
      };
      let out = png;
      let labelled = 0;
      if (bool(input, 'annotate')) {
        const raw = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const maxLabels = num(input, 'max_labels', 25);
        const specs: AnnotationSpec[] = snapshot.nodes
          .filter((n) => n.interactable)
          .slice(0, maxLabels)
          .map((n) => ({ rect: boxInScreenshot(n.rect, geometry), index: snapshot.nodes.indexOf(n) + 1 }));
        const painted = paintAnnotation(
          { width: raw.info.width, height: raw.info.height, data: new Uint8Array(raw.data) },
          specs,
          { thickness: 2, labelScale: Math.max(1, Math.round(2 / (snapshot.deviceScaleFactor || 1))) },
        );
        labelled = painted.boxes;
        out = await sharp(Buffer.from(painted.image.data), {
          raw: { width: raw.info.width, height: raw.info.height, channels: 4 },
        })
          .png()
          .toBuffer();
      }
      return imageResult(
        {
          ok: true,
          width: geometry.image.width,
          height: geometry.image.height,
          bytes: out.length,
          geometry,
          annotated_labels: labelled,
          note: 'boxInScreenshot(DOM rect, geometry) gives the pixels of any element in this image. A viewport shot starts at the scroll position, a full-page shot at the top of the document, an element shot at the element. The base64 PNG is the next content item.',
        },
        out.toString('base64'),
      );
    } catch (error) {
      if (error instanceof SessionError) return fail(error.message);
      throw error;
    }
  },
});
