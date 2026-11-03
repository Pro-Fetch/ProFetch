import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { requireSession, SessionError } from '../../core/browser-use-session.js';
import { areaOfRect, containsPoint } from '../../core/browser-use-coordinates.js';
import { parseRect } from './_shared.js';
import { optionalStr, bool, num } from '../../core/input.js';

/**
 * pro_browser_use_region — What is inside this part of the page
 * Pack: browser_use (pro-fetch)
 */
export default defineTool({
  name: 'pro_browser_use_region',
  description:
    'Query the session’s current read by a rectangle or a frame: which elements fall in it, which contain it, and how much of it is covered. This is how a caller asks about a modal, a table, or a region it saw in a screenshot.',
  category: 'browser_use',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Open session' },
      rect: { type: 'string', description: 'JSON {x,y,width,height} in CSS viewport pixels' },
      frame_id: { type: 'string', description: 'Limit to one frame (default main)' },
      only_interactable: { type: 'boolean', description: 'Skip static elements (default false)' },
      contain_partial: {
        type: 'boolean',
        description: 'Also return boxes that only overlap the region (default false)',
      },
    },
    required: ['session_id', 'rect'],
    additionalProperties: false,
  },
  async handler(input) {
    try {
      const session = requireSession(optionalStr(input, 'session_id'));
      const parsed = parseRect(input.rect, 'rect');
      if (!parsed.ok) return fail(parsed.error!);
      const region = parsed.value;
      const frameId = optionalStr(input, 'frame_id') ?? 'main';
      const onlyInteractable = bool(input, 'only_interactable');
      const partial = bool(input, 'contain_partial');
      const inside = session.model.latest.nodes.filter((n) => {
        if (n.frameId !== frameId) return false;
        if (onlyInteractable && !n.interactable) return false;
        const centre = { x: n.rect.x + n.rect.width / 2, y: n.rect.y + n.rect.height / 2 };
        return partial
          ? containsPoint(n.rect, { x: region.x, y: region.y }) ||
              containsPoint(n.rect, { x: region.x + region.width, y: region.y + region.height }) ||
              containsPoint(region, centre)
          : containsPoint(region, centre);
      });
      const covering = session.model.latest.nodes.filter(
        (n) =>
          n.frameId === frameId &&
          !inside.includes(n) &&
          areaOfRect(n.rect) > areaOfRect(region) &&
          containsPoint(region, { x: n.rect.x, y: n.rect.y }),
      );
      return jsonBlock(`${inside.length} element(s) in the region`, {
        ok: true,
        version: session.model.version,
        region,
        frame_id: frameId,
        elements: inside.slice(0, 60).map((n) => ({
          identity: n.identity,
          backend_id: n.backendId,
          token: n.token,
          role: n.role,
          name: n.name || n.text.slice(0, 60),
          tag: n.tag,
          rect: n.rect,
          interactable: n.interactable,
        })),
        truncated_by: Math.max(0, inside.length - 60),
        // A box larger than the region and starting inside it is usually the container, not a find.
        larger_boxes_covering: covering.slice(0, 5).map((n) => ({ role: n.role, name: n.name, tag: n.tag })),
        empty: inside.length === 0,
        note: inside.length
          ? 'Centres decide membership unless contain_partial is set, because a box straddling the border is ambiguous.'
          : 'Nothing found. Check the coordinate space: a screenshot pixel box must be converted to CSS viewport pixels first.',
      });
    } catch (error) {
      if (error instanceof SessionError) return fail(error.message);
      throw error;
    }
  },
});
