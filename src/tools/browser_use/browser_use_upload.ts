import { defineTool } from '../../core/tool.js';
import { jsonBlock, fail, failJson } from '../../core/format.js';
import {
  listFileInputs,
  refresh,
  requireSession,
  uploadFiles,
  SessionError,
  type FilePayload,
} from '../../core/browser-use-session.js';
import { optionalStr, bool, asRecordArray } from '../../core/input.js';

/** A hand-off this engine will not attempt: more than this is a payload, not a form upload. */
const MAX_FILES = 8;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

/**
 * pro_browser_use_upload — Hand bytes to a file control and ask the page what it holds
 * Pack: browser_use (pro-fetch)
 *
 * Called with no files it is a read: it lists every `input[type=file]` the page has, including the ones a
 * styled widget hides, which is the answer a caller needs because the ordinary visibility filter is correct
 * to leave those controls out of a click list.
 */
export default defineTool({
  name: 'pro_browser_use_upload',
  description:
    'With no files argument, list the file controls of the session (accept, multiple, visible or hidden, and the id to address them by). With files, hand caller-supplied bytes (name + base64) to one control and verify by reading the control’s own FileList back. Local paths are never accepted: this tool can only send what the caller already holds.',
  category: 'browser_use',
  annotations: { readOnlyHint: false, openWorldHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Open session' },
      upload_id: { type: 'string', description: 'Control from the listing, e.g. pfu-1' },
      backend_id: { type: 'string', description: 'Or the collector node id of a visible file control, e.g. pf-42' },
      files: {
        type: 'string',
        description: 'JSON array of {name, mime?, base64}: the bytes to hand over (max 8 files, 25 MB total)',
      },
      list: { type: 'boolean', description: 'Only report the controls, changing nothing' },
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
    const raw = input.files;
    if (raw === undefined || bool(input, 'list')) {
      const found = await listFileInputs(session);
      return jsonBlock(found.length ? `${found.length} file control(s) on the page` : 'no file controls', {
        ok: true,
        session_id: session.id,
        url: session.url,
        controls: found,
        note: found.length
          ? 'address a control with its upload_id; a control listed as visible=false is normally the real input behind a styled button'
          : 'this page has no input[type=file] in its top frame — a widget inside an iframe would not appear here',
      });
    }

    const parsedPayload = parseUploadPayload(raw);
    if ('error' in parsedPayload) return fail(parsedPayload.error);
    const payloads = parsedPayload.files;

    const uploadId = optionalStr(input, 'upload_id');
    const backendId = optionalStr(input, 'backend_id');
    if (!uploadId && !backendId)
      return fail('upload_id yoki backend_id kerak — avval filessiz chaqirib ro‘yxatni oling');
    if (uploadId && backendId) return fail('upload_id va backend_id bir vaqtda berilmaydi — bittani tanlang');
    const control = uploadId
      ? { kind: 'data-pf-upload' as const, value: uploadId }
      : { kind: 'data-pf-id' as const, value: backendId! };

    const outcome = await uploadFiles(session, control, payloads);
    if (!outcome.ok)
      return failJson('upload not accepted', {
        ...outcome,
        note: 'the hand-off did not leave bytes in the control; the page may have cleared it, or the id no longer exists',
      });
    // The read-back is the whole claim, so the page is re-read: a control that now reports a file has
    // changed state, and the session's model should know that before anything else acts on it.
    const after = await refresh(session, {}).catch(() => null);
    return jsonBlock(`control accepted ${outcome.accepted.length} file(s)`, {
      ok: true,
      control: outcome.control,
      handed: outcome.handed,
      accepted: outcome.accepted,
      matched:
        outcome.accepted.length === payloads.length &&
        outcome.accepted.every((file, index) => file.size === payloads[index]!.buffer.byteLength),
      model_version: session.model.version,
      reread: after !== null,
      note: 'accepted is what the control reports after the hand-off, not what was sent to it',
    });
  },
});

/**
 * Validate a `files` argument into the bytes this tool is willing to hand over.
 *
 * Exported because these are the rules that keep an upload tool from becoming something else: a name that
 * contains a path is a caller asking the browser to read a file it chose, and a payload with no ceiling is a
 * denial of service against the session's own host. The checks have to be somewhere testable, and the
 * session lookup happens first in the handler, so they live here rather than inline.
 */
export function parseUploadPayload(raw: unknown): { files: FilePayload[] } | { error: string } {
  let parsed: unknown;
  if (Array.isArray(raw)) parsed = raw;
  else if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return { error: `files: JSON ajratib bo'lmadi: ${(error as Error).message}` };
    }
  } else return { error: 'files: JSON massivi kerak ({name, mime?, base64})' };
  if (!Array.isArray(parsed) || !parsed.length) return { error: 'files: bo‘sh bo‘lmagan massiv kerak' };
  if (parsed.length > MAX_FILES) return { error: `files: ${parsed.length} ta juda ko'p, chegara ${MAX_FILES}` };
  const entries = asRecordArray(parsed);
  if (entries.length !== parsed.length)
    return { error: 'files: har bir element {name, base64} obyekti bo‘lishi kerak' };

  const files: FilePayload[] = [];
  let total = 0;
  for (const [index, entry] of entries.entries()) {
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    const base64 = typeof entry.base64 === 'string' ? entry.base64 : '';
    if (!name) return { error: `files[${index}]: name kerak` };
    if (name.includes('/') || name.includes('\\') || name.includes('..'))
      return { error: `files[${index}]: name faqat fayl nomi bo‘lishi kerak — yo‘l emas` };
    if (!base64) return { error: `files[${index}]: base64 bo‘sh — baytlarni ham yuboring` };
    // `Buffer.from(x, 'base64')` is forgiving by design: it discards characters outside the alphabet and
    // returns whatever bytes it could read. A truncated or double-encoded payload would therefore arrive at
    // the site as a shorter, different file with nothing reported. So the text is checked, and the bytes are
    // re-encoded to prove the decode was the whole story.
    const cleaned = base64.replace(/\s/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned))
      return { error: `files[${index}]: base64 alifbosi buziq — fayl buzilgan holda yuborilmaydi` };
    const buffer = Buffer.from(cleaned, 'base64');
    if (!buffer.byteLength) return { error: `files[${index}]: base64 bo‘sh baytlarga aylandi` };
    if (buffer.toString('base64').replace(/=+$/, '') !== cleaned.replace(/=+$/, ''))
      return { error: `files[${index}]: base64 qayta o‘qilganda boshqa baytlarni berdi — yuborilmaydi` };
    total += buffer.byteLength;
    if (total > MAX_TOTAL_BYTES)
      return { error: `files: jami ${total} bayt chegaradan oshdi (${MAX_TOTAL_BYTES}) — bu yuborilmaydi` };
    files.push({
      name: name.slice(0, 200),
      mimeType:
        typeof entry.mime === 'string' && entry.mime.trim()
          ? entry.mime.trim().slice(0, 100)
          : 'application/octet-stream',
      buffer,
    });
  }
  return { files };
}
