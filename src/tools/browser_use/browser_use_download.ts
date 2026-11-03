import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail, failJson } from '../../core/format.js';
import {
  downloadByClick,
  downloadByUrl,
  refresh,
  requireSession,
  SessionError,
} from '../../core/browser-use-session.js';
import { preflight, type Action, type ActionPolicy } from '../../core/browser-use-actions.js';
import { assertWritablePath } from '../../core/path-containment.js';
import { optionalStr, bool, num } from '../../core/input.js';

/**
 * pro_browser_use_download — Take a file the page offers, and prove what arrived
 * Pack: browser_use (pro-fetch)
 *
 * A download is the action where "no error was thrown" means least: the click resolves, the browser starts
 * a transfer in another process, and the tool that reported success has never looked at the bytes. This one
 * reports size and sha256 measured from the saved file, or says what failed.
 */
export default defineTool({
  name: 'pro_browser_use_download',
  description:
    'Start a download from the session — either by clicking an element the session reported (preflighted by the same policy as browser_use_act) or by asking the page to fetch a direct URL — then save it and report the suggested filename, source URL, byte count and sha256 of what actually landed. Without save_path the file goes into the session profile and is deleted when the session closes.',
  category: 'browser_use',
  annotations: { readOnlyHint: false, openWorldHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Open session' },
      identity: { type: 'string', description: 'Element to click: identity from the last snapshot' },
      backend_id: { type: 'string', description: 'Element to click: node id from the same read' },
      token: { type: 'string', description: 'Element to click: lifetime token (recommended)' },
      url: { type: 'string', description: 'Instead of clicking: a direct file address the page may fetch' },
      save_path: {
        type: 'string',
        description: 'Where to keep the file. Checked before the click; inside the configured output root only',
      },
      timeout_ms: { type: 'number', description: 'How long to wait for the transfer (default 30000, max 120000)' },
      confirmed: { type: 'boolean', description: 'Set when the preflight asked for confirmation' },
    },
    required: ['session_id'],
    additionalProperties: false,
  },
  async handler(input) {
    let session;
    try {
      session = requireSession(optionalStr(input, 'session_id'));
    } catch (error) {
      if (error instanceof SessionError) return fail(error.message);
      throw error;
    }
    const url = optionalStr(input, 'url');
    const identity = optionalStr(input, 'identity');
    const backendId = optionalStr(input, 'backend_id');
    if (!url && !(identity && backendId))
      return fail('either url, or the identity and backend_id of the control to click, must be given');
    if (url && identity) return fail('url and an element target are two different triggers — choose one');
    const timeoutMs = num(input, 'timeout_ms', 30_000, 1_000, 120_000);

    // Destination first, trigger second. A refused path that is discovered after the click has still
    // clicked: the form submitted, the link navigated, the transfer started. The check that can prevent an
    // effect has to run before the effect, which is the same lesson the browser pack learned the hard way.
    let saveTo = '';
    if (optionalStr(input, 'save_path')) {
      const candidate = optionalStr(input, 'save_path')!;
      try {
        assertWritablePath(candidate, 'save_path', 'yuklab olingan faylni saqlash');
      } catch (error) {
        return fail((error as Error).message);
      }
      saveTo = candidate;
    }

    if (url) {
      try {
        const outcome = await downloadByUrl(session, url, { timeoutMs, saveTo });
        // An anchor click that produced no download may still have navigated the page, so the session's own
        // read is refreshed and the response reports where the tab actually ended up.
        const after = await refresh(session, {}).catch(() => null);
        return jsonBlock(outcome.ok ? `downloaded ${outcome.bytes} bytes` : 'download failed', {
          ...outcome,
          mode: 'url',
          model_version: session.model.version,
          page_url_after: after ? session.url : 'the page could not be re-read after the attempt',
        });
      } catch (error) {
        if (error instanceof SessionError) return fail(error.message);
        return failJson('download did not complete', {
          ok: false,
          mode: 'url',
          error: (error as Error).message.slice(0, 300),
          note: 'no download event arrived before the timeout — the address may be a page rather than a file, or the server refused it',
        });
      }
    }

    const snapshot = session.model.latest;
    const node = snapshot.nodes.find((n) => n.identity === identity);
    if (!node)
      return fail(
        `"${identity}" is not in the session's latest read — take a snapshot first, since a click needs a box that exists now`,
      );
    const action: Action = {
      kind: 'click',
      target: {
        identity: identity!,
        backendId: backendId!,
        ...(optionalStr(input, 'token') ? { token: optionalStr(input, 'token')! } : {}),
      },
    };
    const policy: ActionPolicy = {
      confirmed: bool(input, 'confirmed'),
      allowReveal: true,
      readOnly: process.env.PRO_FETCH_READ_ONLY === 'true' || process.env.PRO_FETCH_READ_ONLY === '1',
    };
    const decision = preflight(action, session.model, snapshot, policy);
    if (decision.decision !== 'ALLOW' || !decision.point) {
      return failJson(`download ${decision.decision.toLowerCase()}`, {
        ok: false,
        mode: 'click',
        decision: decision.decision,
        reason: decision.reason,
        scroll_hint: decision.scrollHint,
        note:
          decision.decision === 'NEEDS_CONFIRMATION'
            ? 'pass confirmed=true when the caller has decided this download should happen'
            : 'nothing was clicked',
      });
    }
    try {
      const outcome = await downloadByClick(
        session,
        { x: decision.point.x, y: decision.point.y },
        { timeoutMs, saveTo },
      );
      return jsonBlock(outcome.ok ? `downloaded ${outcome.bytes} bytes` : 'download failed', {
        ...outcome,
        mode: 'click',
        element: { identity: node.identity, tag: node.tag, role: node.role, name: node.name || node.text.slice(0, 60) },
        point: decision.point,
        model_version: session.model.version,
      });
    } catch (error) {
      if (error instanceof SessionError) return fail(error.message);
      return failJson('download did not complete', {
        ok: false,
        mode: 'click',
        error: (error as Error).message.slice(0, 300),
        note: 'the click happened and no download event arrived before the timeout; the control may open a viewer instead of transferring a file',
      });
    }
  },
});
