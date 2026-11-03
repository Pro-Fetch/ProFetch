import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { requireSession, SessionError } from '../../core/browser-use-session.js';
import { revalidatePoint, whatIsAt } from '../../core/browser-use-coordinates.js';
import { optionalStr, num } from '../../core/input.js';

/**
 * pro_browser_use_hit_test — Which element a point actually belongs to
 * Pack: browser_use (pro-fetch)
 */
export default defineTool({
  name: 'pro_browser_use_hit_test',
  description:
    "Ask the session's latest read what sits at a coordinate: the stack of boxes covering the point, the topmost one, and whether a stored element still owns its own centre after the page moved.",
  category: 'browser_use',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Open session' },
      x: { type: 'number', description: 'X in CSS viewport pixels (omit with identity to test the element centre)' },
      y: { type: 'number', description: 'Y in CSS viewport pixels' },
      identity: { type: 'string', description: 'Optional: revalidate that this element still owns its own centre' },
      frame_id: { type: 'string', description: 'Frame the point belongs to (default main)' },
    },
    required: ['session_id'],
    additionalProperties: false,
  },
  async handler(input) {
    try {
      const session = requireSession(optionalStr(input, 'session_id'));
      const snapshot = session.model.latest;
      const identity = optionalStr(input, 'identity');
      const node = identity ? snapshot.nodes.find((n) => n.identity === identity) : undefined;
      if (identity && !node) return fail(`"${identity}" is not in the latest read — take a fresh snapshot`);
      const hasPoint = typeof input.x === 'number' && typeof input.y === 'number';
      if (!hasPoint && !node) return fail('give x and y, or an identity whose centre to test');
      const point = hasPoint
        ? { x: num(input, 'x', 0), y: num(input, 'y', 0) }
        : { x: node!.rect.x + node!.rect.width / 2, y: node!.rect.y + node!.rect.height / 2 };
      const frameId = optionalStr(input, 'frame_id') ?? node?.frameId ?? 'main';
      const verdict = whatIsAt(snapshot, point, frameId);
      const revalidation = node
        ? revalidatePoint(snapshot, { identity: node.identity, rect: node.rect, frameId: node.frameId })
        : undefined;
      return jsonBlock(verdict.ok ? 'the point is usable' : 'the point is not usable', {
        ok: true,
        point,
        frame_id: frameId,
        top: verdict.at,
        stack: verdict.stack,
        reason: verdict.reason,
        revalidation: revalidation
          ? { identity_matches: revalidation.identityMatches, drift: revalidation.drift, reason: revalidation.reason }
          : undefined,
        note: 'A point over the right place but the wrong element is the failure this answers; the stack shows what a click would have hit instead.',
      });
    } catch (error) {
      if (error instanceof SessionError) return fail(error.message);
      throw error;
    }
  },
});
