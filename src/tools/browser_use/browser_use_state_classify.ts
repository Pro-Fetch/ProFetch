import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { classifyReveal, revealCandidates, type RevealCandidate } from '../../core/browser-use-coverage.js';
import { snapshotFromInput } from './_shared.js';
import { optionalStr } from '../../core/input.js';

/**
 * pro_browser_use_state_classify — Is revealing this state safe to do?
 * Pack: browser_use (pro-fetch)
 */
export default defineTool({
  name: 'pro_browser_use_state_classify',
  description:
    'Classify a UI reveal as reversible, needing confirmation, or refused — a closed disclosure and a hover are offered, a submit, navigation or a destructive label is not. Can also list the reveal candidates of an injected node list.',
  category: 'browser_use',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['expand', 'collapse', 'hover', 'focus', 'click-toggle', 'submit', 'navigate', 'unknown'],
        description: 'How the state would be revealed',
      },
      node: {
        type: 'string',
        description:
          'JSON object describing the element: {tag,role,name,text,placeholder,href,expanded,inViewport,visible}',
      },
      nodes: {
        type: 'string',
        description: 'Instead of one node: a full node list, to get every candidate in page order',
      },
    },
    required: [],
    additionalProperties: false,
  },
  async handler(input) {
    const kind = optionalStr(input, 'kind');
    if (input.nodes !== undefined) {
      const built = snapshotFromInput(input.nodes);
      if (!built.ok) return fail(built.error!);
      const candidates: RevealCandidate[] = revealCandidates(built.value.snapshot);
      return jsonBlock(`${candidates.length} reveal candidate(s)`, {
        ok: true,
        candidates,
        tokens_synthesised: built.value.tokensGuessed,
        note: 'Candidates are elements that are hidden, outside the read region, or a closed disclosure. Ones already contributing are left out.',
      });
    }
    if (!kind) return fail('kind kerak (yoki butun ro‘yxat uchun nodes yuboring)');
    // A single node arrives as an object; the snapshot builder wants a list either way.
    const single = typeof input.node === 'string' && input.node.trim().startsWith('{') ? `[${input.node}]` : input.node;
    const built = snapshotFromInput(single ?? input.nodes, 'about:blank', 'injected');
    if (!built.ok) return fail(built.error!);
    const node = built.value.snapshot.nodes[0];
    if (!node) return fail('node: bitta element obyekti kerak');
    const result = classifyReveal(node, kind as RevealCandidate['kind']);
    return jsonBlock(`${result.safety}`, {
      ok: true,
      ...result,
      note: 'Fail-closed: an unrecognised element is never assumed harmless, and a label that sends or destroys is refused before anything is planned.',
    });
  },
});
