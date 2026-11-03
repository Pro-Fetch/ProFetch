import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { requireSession, SessionError } from '../../core/browser-use-session.js';
import { groupObjects } from '../../core/browser-use-objects.js';
import { optionalStr } from '../../core/input.js';

/**
 * pro_browser_use_extract — Pull the structured content out of the current read
 * Pack: browser_use (pro-fetch)
 */
export default defineTool({
  name: 'pro_browser_use_extract',
  description:
    'Turn the session’s last read into records: repeated groups become rows with their member labels, tables become rows of cells, forms become named fields with current values. No new read of the page, no guess about what the data means.',
  category: 'browser_use',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Open session' },
      kind: {
        type: 'string',
        enum: ['auto', 'list', 'table', 'form', 'navigation'],
        description: 'Restrict to one group kind (default auto)',
      },
      max_rows: { type: 'number', description: 'Rows per record set (default 50)' },
    },
    required: ['session_id'],
    additionalProperties: false,
  },
  async handler(input) {
    try {
      const session = requireSession(optionalStr(input, 'session_id'));
      const snapshot = session.model.latest;
      const wanted = optionalStr(input, 'kind') ?? 'auto';
      const maxRows = Math.max(1, Number(input.max_rows ?? 50));
      const groups = groupObjects(snapshot).filter((o) => wanted === 'auto' || o.kind === wanted);
      const records = groups.slice(0, 20).map((o) => ({
        kind: o.kind,
        label: o.label,
        confidence: o.confidence,
        evidence: o.evidence,
        rows: o.members.slice(0, maxRows).map((m) => ({ name: m.name || m.role, identity: m.identity, why: m.why })),
        row_count: o.members.length,
      }));
      return jsonBlock(`${records.length} record set(s)`, {
        ok: true,
        version: session.model.version,
        url: session.url,
        records,
        dropped: Math.max(0, groups.length - records.length),
        note: groups.length
          ? 'Membership is structural: a row is listed with the reason it joined the group, so a wrong grouping can be argued with.'
          : 'Nothing repeated, tabulated or form-like was found in the current read. That is a statement about this read, not about the page.',
      });
    } catch (error) {
      if (error instanceof SessionError) return fail(error.message);
      throw error;
    }
  },
});
