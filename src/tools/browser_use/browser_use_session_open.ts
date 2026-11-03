import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail } from '../../core/format.js';
import { openSession, SessionError, sessionSummary, type OpenOptions } from '../../core/browser-use-session.js';
import { serializeOutline } from '../../core/browser-use-perception.js';
import { summarizeModel } from '../../core/browser-use-world.js';
import type { BrowserRequest } from '../../core/browser-use-contract.js';
import { requireStr, optionalStr, num, bool } from '../../core/input.js';

/**
 * pro_browser_use_session_open — Open a page in a chosen browser and read it once
 * Pack: browser_use (pro-fetch)
 */
export default defineTool({
  name: 'pro_browser_use_session_open',
  description:
    'Start a browser session for a URL through the capability-aware selector, then take the first snapshot: model version, element outline and coverage. The url is checked by the SSRF guard before any browser starts.',
  category: 'browser_use',
  annotations: { readOnlyHint: false, openWorldHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'http(s) page to open' },
      product: { type: 'string', description: 'Pin the browser product (chrome, edge, firefox…)' },
      requires: { type: 'string', description: 'JSON array of capabilities the session must have' },
      mode: {
        type: 'string',
        enum: ['managed', 'native'],
        description: 'Launch it ourselves, or attach to a running browser',
      },
      endpoint: { type: 'string', description: 'Attach endpoint when mode=native' },
      headless: { type: 'boolean', description: 'Headless launch (default true)' },
      width: { type: 'number', description: 'Viewport width (default 1280)' },
      height: { type: 'number', description: 'Viewport height (default 720)' },
      budget: { type: 'number', description: 'Max elements in the first outline (default 400)' },
      outline: { type: 'boolean', description: 'Include the element outline text (default true)' },
    },
    required: ['url'],
    additionalProperties: false,
  },
  async handler(input) {
    const url = requireStr(input, 'url');
    const request: BrowserRequest = {
      ...(optionalStr(input, 'product') ? { product: optionalStr(input, 'product') } : {}),
      ...(optionalStr(input, 'mode') === 'native' || optionalStr(input, 'mode') === 'managed'
        ? { mode: optionalStr(input, 'mode') as 'native' | 'managed' }
        : {}),
      ...(optionalStr(input, 'endpoint') ? { endpoint: optionalStr(input, 'endpoint') } : {}),
    };
    if (input.requires !== undefined) {
      try {
        const parsed = JSON.parse(String(input.requires));
        if (!Array.isArray(parsed)) return fail('requires: JSON massiv kerak');
        request.requires = parsed as never;
      } catch (error) {
        return fail(`requires: JSON ajratib bo'lmadi — ${(error as Error).message}`);
      }
    }
    const options: OpenOptions = {
      url,
      request,
      headless: input.headless !== false,
      viewport: { width: num(input, 'width', 1280), height: num(input, 'height', 720) },
      budget: num(input, 'budget', 400),
    };
    try {
      const session = await openSession(options);
      const outline = serializeOutline(session.model.latest);
      const summary = summarizeModel(session.model, 900);
      return jsonBlock(`session ${session.id}`, {
        ok: true,
        ...sessionSummary(session),
        coverage: session.ledger
          ? { gaps: session.ledger.gaps, content_height: session.ledger.contentHeight }
          : undefined,
        frames: session.frames?.frames.map((f) => f.frameId),
        unlifted: session.frames?.unlifted,
        elements: session.model.latest.nodes
          .filter((n) => n.interactable)
          .slice(0, 80)
          .map((n) => ({
            index: session.model.latest.nodes.indexOf(n) + 1,
            identity: n.identity,
            backend_id: n.backendId,
            token: n.token,
            role: n.role,
            name: n.name || n.text.slice(0, 60),
            tag: n.tag,
            rect: n.rect,
            in_viewport: n.inViewport,
          })),
        interactable_count: session.model.latest.nodes.filter((n) => n.interactable).length,
        outline: input.outline === false ? undefined : outline.text,
        model: summary.text,
        note: 'Keep the session_id: every later call reads the model this one started.',
      });
    } catch (error) {
      if (error instanceof SessionError)
        return jsonBlock('session refused', { ok: false, error: error.message, hint: error.hint });
      return fail(`session open failed: ${(error as Error).message}`);
    }
  },
});
