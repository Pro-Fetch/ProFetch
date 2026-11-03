import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { requireSession, SessionError } from '../../core/browser-use-session.js';
import { optionalStr, bool, num } from '../../core/input.js';

/**

 * pro_browser_use_read — The page as text a model can quote
 * Pack: browser_use (pro-fetch)
 */
export default defineTool({
  name: 'pro_browser_use_read',
  description:
    'Render the session’s current read as reading-order text, with the index of each element that can be acted on inline. Costs no new read of the page and respects the snapshot budget, so what is missing stays visible as a gap.',
  category: 'browser_use',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Open session' },
      max_chars: { type: 'number', description: 'Character budget (default 6000)' },
      interactive_only: { type: 'boolean', description: 'Only lines that carry an actionable element (default false)' },
    },
    required: ['session_id'],
    additionalProperties: false,
  },
  async handler(input) {
    try {
      const session = requireSession(optionalStr(input, 'session_id'));
      const snapshot = session.model.latest;
      const maxChars = Math.max(200, num(input, 'max_chars', 6000));
      const interactiveOnly = bool(input, 'interactive_only');
      const ordered = [...snapshot.nodes].sort((a, b) => {
        if (a.frameId !== b.frameId)
          return a.frameId === 'main' ? -1 : b.frameId === 'main' ? 1 : a.frameId.localeCompare(b.frameId);
        return a.rect.y - b.rect.y || a.rect.x - b.rect.x;
      });
      const lines: string[] = [];
      let used = 0;
      let dropped = 0;
      for (const n of ordered) {
        if (interactiveOnly && !n.interactable) continue;
        const label = n.name || n.text || n.placeholder || n.role || n.tag;
        if (!label) continue;
        const line = `${n.interactable ? `[${snapshot.nodes.indexOf(n) + 1}]` : '     '} ${n.role || n.tag}: ${label.slice(0, 160)}${n.inViewport ? '' : '  (outside the read viewport)'}`;
        if (used + line.length + 1 > maxChars) {
          dropped++;
          continue;
        }
        lines.push(line);
        used += line.length + 1;
      }
      return jsonBlock(`${lines.length} line(s), ${dropped} dropped by the budget`, {
        ok: true,
        version: session.model.version,
        url: session.url,
        title: session.title,
        text: lines.join(String.fromCharCode(10)),
        lines: lines.length,
        dropped,
        truncated_nodes: snapshot.truncated,
        note: snapshot.truncated
          ? `The last read dropped ${snapshot.truncated} node(s) to respect its budget: absent lines are unknown, not absent.`
          : 'Every node from the last read is represented here.',
      });
    } catch (error) {
      if (error instanceof SessionError) return fail(error.message);
      throw error;
    }
  },
});
