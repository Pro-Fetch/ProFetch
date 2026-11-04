import { defineTool } from '../../core/tool.js';
import { fail } from '../../core/format.js';
import { capture, requireSession, SessionError, type BrowserUseSession } from '../../core/browser-use-session.js';
import { boxInScreenshot, type ScreenshotGeometry } from '../../core/browser-use-coordinates.js';
import { paintAnnotation, type AnnotationSpec } from '../../core/browser-use-visual.js';
import { selectNodes, type ElementFilter } from '../../core/browser-use-elements.js';
import type { Snapshot } from '../../core/browser-use-perception.js';
import { optionalStr, bool, num } from '../../core/input.js';
import { imageResult } from './_shared.js';

/** Ledger rows are capped so the JSON summary stays parseable next to a megabyte of image. */
const MAX_LEDGER = 400;
const MAX_LEDGER_CHARS = 20_000;

/**
 * pro_browser_use_screenshot — Capture a session's page, annotated down to every element
 * Pack: browser_use (pro-fetch)
 */
export default defineTool({
  name: 'pro_browser_use_screenshot',
  description:
    'Take a viewport, full-page or element screenshot from an open session and return it as base64 PNG, with the geometry needed to map DOM boxes onto its pixels. With annotate=true boxes are outlined and numbered; `targets` chooses what gets a box (interactable only, or every element the read reached, or text-owning elements), and `coordinates` draws each box’s x,y,w,h under its number. The response carries the ledger that maps every drawn number back to its element, so the picture is machine-readable as well as human-readable.',
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
      targets: {
        type: 'string',
        enum: ['interactable', 'all', 'visible', 'text'],
        description: 'What gets a box (default interactable). "all" is the whole read.',
      },
      coordinates: { type: 'boolean', description: 'Under each number, draw that box as x,y,w,h in image pixels' },
      max_labels: { type: 'number', description: 'How many elements to box (default 25, 0 for every match)' },
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
      // `origin` decides where an element shot's (0,0) is. Leaving it out made every annotation on an
      // element capture land at its viewport position instead of inside the crop, which is the one case the
      // field exists for.
      const geometry: ScreenshotGeometry = {
        kind,
        deviceScaleFactor: snapshot.deviceScaleFactor,
        image: { width: info.width ?? 0, height: info.height ?? 0 },
        scroll: snapshot.scroll,
        ...(elementBox ? { origin: elementBox } : {}),
      };
      let out = png;
      let labelled = 0;
      let ledger: Array<Record<string, unknown>> = [];
      let stats = { boxes: 0, labels_drawn: 0, labels_outside: 0, labels_collided: 0, painted: 0 };
      if (bool(input, 'annotate')) {
        const filter = (optionalStr(input, 'targets') ?? 'interactable') as ElementFilter;
        const pool = poolFor(session, filter);
        // `max_labels: 0` means every match, so the argument must be read with a floor of zero — the shared
        // helper defaults to 1, and a 1 here silently means "the caller asked for no limit and got one box".
        const maxLabels = num(input, 'max_labels', 25, 0);
        const chosen = maxLabels === 0 ? pool : pool.slice(0, maxLabels);
        const wantCoordinates = bool(input, 'coordinates');
        const specs: AnnotationSpec[] = [];
        const seen: Snapshot['nodes'] = [];
        for (const node of chosen) {
          const box = boxInScreenshot(node.rect, geometry);
          if (box.width <= 0 || box.height <= 0) continue;
          specs.push({
            rect: box,
            index: snapshot.nodes.indexOf(node) + 1,
            ...(wantCoordinates
              ? {
                  label: `${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.width)},${Math.round(box.height)}`,
                }
              : {}),
          });
          seen.push(node);
        }
        const raw = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const painted = paintAnnotation(
          { width: raw.info.width, height: raw.info.height, data: new Uint8Array(raw.data) },
          specs,
          { thickness: 2, labelScale: Math.max(1, Math.round(2 / (snapshot.deviceScaleFactor || 1))) },
        );
        labelled = painted.labelsDrawn;
        stats = {
          boxes: painted.boxes,
          labels_drawn: painted.labelsDrawn,
          labels_outside: painted.labelsOutside,
          labels_collided: painted.labelsCollided,
          painted: painted.painted,
        };
        out = await sharp(Buffer.from(painted.image.data), {
          raw: { width: raw.info.width, height: raw.info.height, channels: 4 },
        })
          .png()
          .toBuffer();
        ledger = ledgerFor(seen, specs);
      }
      return imageResult(
        {
          ok: true,
          width: geometry.image.width,
          height: geometry.image.height,
          bytes: out.length,
          geometry,
          annotated_labels: labelled,
          annotation: stats,
          label_ledger: ledger,
          note: 'boxInScreenshot(DOM rect, geometry) gives the pixels of any element in this image. A viewport shot starts at the scroll position, a full-page shot at the top of the document, an element shot at the element. label_ledger maps each drawn number to its element and box. Every requested box is drawn; a number that would sit on another number is skipped and counted in annotation.labels_collided, so label_ledger — not the picture — is the complete list. The base64 PNG is the next content item.',
        },
        out.toString('base64'),
      );
    } catch (error) {
      if (error instanceof SessionError) return fail(error.message);
      throw error;
    }
  },
});

/**
 * Which nodes get a box.
 *
 * `interactable` keeps the historic behaviour — a picture of what can be clicked. `all` and `visible` come
 * from the same selection the elements listing uses, so a number drawn on an image means the same row in the
 * listing, and the two answers cannot disagree about what is on the page.
 */
function poolFor(session: BrowserUseSession, filter: ElementFilter) {
  const snapshot = session.model.latest;
  if (filter === 'interactable') return snapshot.nodes.filter((n) => n.interactable);
  return selectNodes(snapshot, { filter });
}

/**
 * The number → element table.
 *
 * Built after painting, from the boxes that were actually kept, and capped twice: by row count and by
 * serialized size. A ledger that pushed the JSON block past the renderer's cut would leave the caller with a
 * truncated summary and an image whose numbers mean nothing.
 */
function ledgerFor(
  nodes: Array<{ identity: string; tag: string; role: string; name: string; text: string; rect: unknown }>,
  specs: AnnotationSpec[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let used = 0;
  for (const [position, node] of nodes.entries()) {
    const spec = specs[position];
    if (!spec) continue;
    const row = {
      label: spec.index,
      identity: node.identity,
      tag: node.tag,
      role: node.role,
      name: (node.name || node.text || '').slice(0, 60),
      rect: node.rect,
      image_box: spec.rect,
    };
    const size = JSON.stringify(row).length + 2;
    if (out.length >= MAX_LEDGER || used + size > MAX_LEDGER_CHARS) break;
    used += size;
    out.push(row);
  }
  return out;
}
