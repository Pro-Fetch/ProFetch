import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { requireSession, SessionError } from '../../core/browser-use-session.js';
import { groupObjects, objectsContaining } from '../../core/browser-use-objects.js';
import { optionalStr } from '../../core/input.js';

/**
 * pro_browser_use_objects — The page as groups, not as a flat list
 * Pack: browser_use (pro-fetch)
 */
export default defineTool({
  name: 'pro_browser_use_objects',
  description:
    'Group the current snapshot into lists, cards, forms, tables and navigation by structure alone, and report the evidence for each label. Pass an identity to see which groups contain it.',
  category: 'browser_use',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Open session' },
      identity: { type: 'string', description: 'Optional: which groups contain this element' },
    },
    required: ['session_id'],
    additionalProperties: false,
  },
  async handler(input) {
    try {
      const session = requireSession(optionalStr(input, 'session_id'));
      const groups = groupObjects(session.model.latest);
      const wanted = optionalStr(input, 'identity');
      return jsonBlock(`${groups.length} object(s)`, {
        ok: true,
        version: session.model.version,
        objects: groups.map((o) => ({
          kind: o.kind,
          label: o.label,
          confidence: o.confidence,
          repeated: o.repeated,
          members: o.members.slice(0, 10),
          evidence: o.evidence,
        })),
        containing: wanted ? objectsContaining(groups, wanted).map((o) => o.kind) : undefined,
        note: 'Nothing here knows what your site looks like: a group is named only when a structural signal fired, and the signal is listed.',
      });
    } catch (error) {
      if (error instanceof SessionError) return fail(error.message);
      throw error;
    }
  },
});
