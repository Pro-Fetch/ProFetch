import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { requireSession, SessionError, waitFor } from '../../core/browser-use-session.js';
import type { Snapshot } from '../../core/browser-use-perception.js';
import { optionalStr, num } from '../../core/input.js';

/**
 * pro_browser_use_wait — Wait for a condition by re-reading, not by sleeping
 * Pack: browser_use (pro-fetch)
 */
export default defineTool({
  name: 'pro_browser_use_wait',
  description:
    'Poll the page until an element with the given identity or accessible name is present (and optionally interactable), or the timeout passes. Every attempt is a real read, so the answer says how many reads it took.',
  category: 'browser_use',
  annotations: { readOnlyHint: false, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Open session' },
      identity: { type: 'string', description: 'Wait for this identity to be present' },
      name: { type: 'string', description: 'Wait for an element with this accessible name or text' },
      interactable: {
        type: 'boolean',
        description: 'Require the match to be actionable, not just present (default true)',
      },
      timeout_ms: { type: 'number', description: 'Give up after this long (default 5000, cap 30000)' },
      interval_ms: { type: 'number', description: 'Delay between reads (default 250)' },
    },
    required: ['session_id'],
    additionalProperties: false,
  },
  async handler(input) {
    try {
      const session = requireSession(optionalStr(input, 'session_id'));
      const identity = optionalStr(input, 'identity');
      const name = optionalStr(input, 'name');
      if (!identity && !name) return fail('identity or name kerak — nimani kutayotganimiz aniq bo‘lsin');
      const wantInteractable = input.interactable !== false;
      const matches = (n: Snapshot['nodes'][number]): boolean =>
        ((!!identity && n.identity === identity) || (!!name && (n.name === name || n.text === name))) &&
        (!wantInteractable || n.interactable);
      const result = await waitFor(session, (snap) => snap.nodes.some(matches), {
        timeoutMs: Math.min(30_000, num(input, 'timeout_ms', 5000)),
        intervalMs: num(input, 'interval_ms', 250),
      });
      return jsonBlock(result.satisfied ? 'condition met' : 'timed out', {
        ok: result.satisfied,
        satisfied: result.satisfied,
        reads: result.reads,
        waited_ms: result.waitedMs,
        version: session.model.version,
        found: result.snapshot.nodes
          .filter((n) => (!!identity && n.identity === identity) || (!!name && (n.name === name || n.text === name)))
          .slice(0, 5)
          .map((n) => ({
            identity: n.identity,
            backend_id: n.backendId,
            token: n.token,
            role: n.role,
            name: n.name,
            interactable: n.interactable,
          })),
        note: result.satisfied
          ? 'The collector saw it, which is a stronger claim than a selector resolving once.'
          : 'Not found. The page may still be loading, or the element may need a reveal first.',
      });
    } catch (error) {
      if (error instanceof SessionError) return fail(error.message);
      throw error;
    }
  },
});
