import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { diffSnapshots } from '../../core/browser-use-perception.js';
import { snapshotFromInput } from './_shared.js';
import { optionalStr, num } from '../../core/input.js';

/**
 * pro_browser_use_diff_lists — What changed between two reads you already hold
 * Pack: browser_use (pro-fetch)
 */
export default defineTool({
  name: 'pro_browser_use_diff_lists',
  description:
    'Compare two node lists by identity and report added, removed, moved and relabelled elements, with counts. Useful to diff a saved before/after pair without a live session.',
  category: 'browser_use',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      before: { type: 'string', description: 'JSON node array of the earlier read' },
      after: { type: 'string', description: 'JSON node array of the later read' },
      before_url: { type: 'string', description: 'Url of the earlier read (default about:blank)' },
      after_url: { type: 'string', description: 'Url of the later read (default about:blank)' },
      detail_limit: { type: 'number', description: 'How many names to list per category (default 15)' },
    },
    required: ['before', 'after'],
    additionalProperties: false,
  },
  async handler(input) {
    const a = snapshotFromInput(input.before, optionalStr(input, 'before_url') ?? 'about:blank');
    if (!a.ok) return fail(`before: ${a.error}`);
    const b = snapshotFromInput(input.after, optionalStr(input, 'after_url') ?? 'about:blank');
    if (!b.ok) return fail(`after: ${b.error}`);
    const limit = num(input, 'detail_limit', 15);
    const diff = diffSnapshots(a.value.snapshot, b.value.snapshot);
    const label = (n: { name: string; text: string; role: string; tag: string }): string =>
      n.name || n.text || n.role || n.tag;
    return jsonBlock(
      `+${diff.added.length} −${diff.removed.length} ↔${diff.moved.length} ⟲${diff.relabelled.length} ~${diff.changed.length}`,
      {
        ok: true,
        added: diff.added.slice(0, limit).map(label),
        removed: diff.removed.slice(0, limit).map(label),
        moved: diff.moved.slice(0, limit).map((m) => `${m.from.x},${m.from.y} → ${m.to.x},${m.to.y}`),
        relabelled: diff.relabelled.slice(0, limit).map((r) => `${r.fromLabel} → ${r.toLabel}`),
        changed: diff.changed.slice(0, limit).map((c) => c.fields.join('+')),
        counts: {
          added: diff.added.length,
          removed: diff.removed.length,
          moved: diff.moved.length,
          relabelled: diff.relabelled.length,
          changed: diff.changed.length,
        },
        same_document: a.value.snapshot.url === b.value.snapshot.url,
        note: 'Relabelled means the same DOM node with different words; a changed entry is the same identity whose visibility, state or interactability moved.',
      },
    );
  },
});
