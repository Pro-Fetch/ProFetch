import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { requireSession, SessionError } from '../../core/browser-use-session.js';
import { optionalStr } from '../../core/input.js';

/**
 * pro_browser_use_frames — The frame tree and what is known about each frame
 * Pack: browser_use (pro-fetch)
 */
export default defineTool({
  name: 'pro_browser_use_frames',
  description:
    'The frames a session read, with the offset measured for each, how many nodes came from it, and the reason when a frame cannot report its own position (a cross-origin frame). Coordinates from an unpositioned frame are refused, not guessed.',
  category: 'browser_use',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: { session_id: { type: 'string', description: 'Open session' } },
    required: ['session_id'],
    additionalProperties: false,
  },
  async handler(input) {
    try {
      const session = requireSession(optionalStr(input, 'session_id'));
      const collected = session.frames;
      if (!collected) throw new SessionError('the session has not read any frames yet', 'take a snapshot first');
      return jsonBlock(`${collected.frames.length} frame(s)`, {
        ok: true,
        frames: collected.frames.map((f) => ({
          frame_id: f.frameId,
          parent: f.parentFrameId,
          url: f.url,
          depth: f.depth,
          url_inherited: f.inheritedUrl,
          offset: collected.offsets.get(f.frameId) ?? null,
          reason: collected.hops.get(f.frameId)?.reason,
          nodes: collected.nodes.filter((n) => n.frameId === f.frameId).length,
        })),
        unlifted: collected.unlifted,
        warnings: collected.warnings,
        note: 'A frame whose offset is unknown is reported, not silently flattened to the top frame: clicking its coordinates in the parent hits whatever is at that spot there.',
      });
    } catch (error) {
      if (error instanceof SessionError) return fail(error.message);
      throw error;
    }
  },
});
