import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { requireSession, scrollTo, SessionError } from '../../core/browser-use-session.js';
import { optionalStr, num } from '../../core/input.js';

/**
 * pro_browser_use_scroll — Move the read window and report what the new region holds
 * Pack: browser_use (pro-fetch)
 */
export default defineTool({
  name: 'pro_browser_use_scroll',
  description:
    'Scroll a session to a page position or so that an element sits in the upper third, re-read, and report the position the browser actually ended at, with what entered and left the viewport.',
  category: 'browser_use',
  annotations: { readOnlyHint: false, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Open session' },
      to_y: { type: 'number', description: 'Absolute page position to bring the viewport top to' },
      identity: { type: 'string', description: 'Or scroll so this element is near the top third' },
    },
    required: ['session_id'],
    additionalProperties: false,
  },
  async handler(input) {
    try {
      const session = requireSession(optionalStr(input, 'session_id'));
      const identity = optionalStr(input, 'identity');
      let target: number | null = typeof input.to_y === 'number' ? num(input, 'to_y', 0) : null;
      if (target === null && identity) {
        const held = session.model.nodes.get(identity);
        if (!held) return fail(`"${identity}" is not in the model for this tab — check it with element_check`);
        // The stored rect is viewport-relative; add where the viewport was when it was measured.
        const absolute = held.rect.y + session.model.latest.scroll.y;
        target = Math.max(0, absolute - session.model.latest.viewport.height / 3);
      }
      if (target === null) return fail('to_y or identity kerak');
      const before = new Set(session.model.latest.nodes.filter((n) => n.inViewport).map((n) => n.identity));
      const result = await scrollTo(session, target);
      const after = new Set(result.snapshot.nodes.filter((n) => n.inViewport).map((n) => n.identity));
      return jsonBlock(`scrolled to ${Math.round(result.snapshot.scroll.y)}`, {
        ok: true,
        asked_for: Math.round(target),
        scroll_y: result.snapshot.scroll.y,
        version: session.model.version,
        entered_viewport: [...after].filter((i) => !before.has(i)).length,
        left_viewport: [...before].filter((i) => !after.has(i)).length,
        interactable_now: result.snapshot.nodes.filter((n) => n.interactable).length,
        note: 'The position is read back from the page: a browser clamps a scroll past the bottom, and a model that trusted its own number would aim at nothing.',
      });
    } catch (error) {
      if (error instanceof SessionError) return fail(error.message);
      throw error;
    }
  },
});
