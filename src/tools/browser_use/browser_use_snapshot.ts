import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { refresh, requireSession, SessionError } from '../../core/browser-use-session.js';
import { serializeOutline } from '../../core/browser-use-perception.js';
import { groupObjects } from '../../core/browser-use-objects.js';
import { knownIdentities } from '../../core/browser-use-world.js';
import { describeLedger } from '../../core/browser-use-coverage.js';
import { optionalStr, num, bool } from '../../core/input.js';

/**
 * pro_browser_use_snapshot — Read the page again and say what changed
 * Pack: browser_use (pro-fetch)
 */
export default defineTool({
  name: 'pro_browser_use_snapshot',
  description:
    'Re-read a session through the collector and every frame, fold it into the world model, and return the outline plus the delta since the previous read (added, removed, moved, relabelled). This is how a caller learns what its last action did.',
  category: 'browser_use',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Open session' },
      budget: { type: 'number', description: 'Max elements in the outline (default 400)' },
      outline: { type: 'boolean', description: 'Include outline text (default true)' },
      objects: { type: 'boolean', description: 'Include the grouped page objects (default false)' },
      outline_chars: { type: 'number', description: 'Character budget for the outline text (default 6000)' },
    },
    required: ['session_id'],
    additionalProperties: false,
  },
  async handler(input) {
    try {
      const session = requireSession(optionalStr(input, 'session_id'));
      const before = session.model.version;
      const { snapshot } = await refresh(session, { budget: num(input, 'budget', 400) });
      const delta = session.model.delta;
      const outline = serializeOutline(snapshot, { maxChars: num(input, 'outline_chars', 6000) });
      const objects = bool(input, 'objects') ? groupObjects(snapshot) : [];
      return jsonBlock(`v${before} → v${session.model.version}`, {
        ok: true,
        session_id: session.id,
        version: session.model.version,
        url: session.url,
        title: session.title,
        document: session.model.documentSignature,
        transition: session.model.transitions.at(-1),
        nodes: snapshot.nodes.length,
        truncated: snapshot.truncated,
        // The outline is for reading; these are for acting. An identity, a node id and a token have to
        // travel together or `element_check` cannot tell a replacement from a move.
        elements: snapshot.nodes
          .filter((n) => n.interactable)
          .slice(0, 80)
          .map((n) => ({
            index: snapshot.nodes.indexOf(n) + 1,
            identity: n.identity,
            backend_id: n.backendId,
            token: n.token,
            role: n.role,
            name: n.name || n.text.slice(0, 60),
            tag: n.tag,
            rect: n.rect,
            in_viewport: n.inViewport,
          })),
        interactable_count: snapshot.nodes.filter((n) => n.interactable).length,
        // Any node can be the one a caller wants to re-check, not only a clickable one. An empty
        // `elements` list stays explainable: the sample shows what is there and why it is not usable.
        sample: snapshot.nodes.slice(0, 8).map((n) => ({
          identity: n.identity,
          backend_id: n.backendId,
          token: n.token,
          role: n.role,
          name: n.name || n.text.slice(0, 40),
          interactable: n.interactable,
          in_viewport: n.inViewport,
          conflicts: n.conflicts,
        })),
        delta: {
          added: delta.added.map((n) => n.name || n.tag),
          removed: delta.removed.map((n) => n.name || n.tag),
          moved: delta.moved.length,
          changed: delta.changed.length,
          relabelled: delta.relabelled.map((r) => `${r.fromLabel} → ${r.toLabel}`),
        },
        objects: objects.map((o) => ({
          kind: o.kind,
          label: o.label,
          members: o.members.length,
          repeated: o.repeated,
          evidence: o.evidence,
        })),
        coverage: session.ledger ? describeLedger(session.ledger, 900).text : undefined,
        identities_known: knownIdentities(session.model).length,
        outline: input.outline === false ? undefined : outline.text,
      });
    } catch (error) {
      if (error instanceof SessionError) return fail(`${error.message}${error.hint ? ` — ${error.hint}` : ''}`);
      throw error;
    }
  },
});
