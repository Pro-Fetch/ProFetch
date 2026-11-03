import { describe, it, expect } from 'vitest';
import '../src/loader.js';
import { callTool } from '../src/router.js';
import { allTools } from '../src/core/tool.js';
import { isToolVisibleInProfile } from '../src/core/profile.js';
import { requireSession, SessionError } from '../src/core/browser-use-session.js';
import { parseUploadPayload } from '../src/tools/browser_use/browser_use_upload.js';
import type { ToolResult } from '../src/core/types.js';

/**
 * The four newest tools, and the two failure modes they exist to close.
 *
 * `elements`, `words`, `download` and `upload` are tested here rather than in the pack's own test file
 * because they share a concern the older tools do not: each answers a question that a caller gets *wrong*
 * by mixing up two things — two coordinate origins, two session families, or "the click resolved" and "the
 * file arrived".
 */

const NEW = ['pro_browser_use_elements', 'pro_browser_use_words', 'pro_browser_use_download', 'pro_browser_use_upload'];

function text(result: ToolResult): string {
  return (result.content ?? [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text ?? '')
    .join('\n');
}

describe('the four new tools are part of the pack', () => {
  it('every one is registered exactly once', () => {
    const names = allTools().map((t) => t.name);
    for (const name of NEW) expect(names.filter((n) => n === name)).toHaveLength(1);
  });

  it('each is hidden from the small profiles and visible in full', () => {
    // The pack is level 3: `elements` and `words` return lists a model should not see unless it asked for a
    // browser, and a profile that advertised them while refusing to open one would be a tool with no input.
    for (const name of NEW) {
      const tool = allTools().find((t) => t.name === name)!;
      expect(isToolVisibleInProfile(tool, 'full')).toBe(true);
      expect(isToolVisibleInProfile(tool, 'standard')).toBe(false);
      expect(isToolVisibleInProfile(tool, 'minimal')).toBe(false);
      expect(isToolVisibleInProfile(tool, 'smart')).toBe(false);
    }
  });

  it('each says what it returns, not just what it takes', () => {
    for (const name of NEW) {
      const tool = allTools().find((t) => t.name === name)!;
      expect(tool.description.length).toBeGreaterThan(120);
      expect(tool.inputSchema.properties).toBeTruthy();
    }
  });

  it('marks the two that change something as not read-only', () => {
    expect(allTools().find((t) => t.name === 'pro_browser_use_download')!.annotations?.readOnlyHint).toBe(false);
    expect(allTools().find((t) => t.name === 'pro_browser_use_upload')!.annotations?.readOnlyHint).toBe(false);
    expect(allTools().find((t) => t.name === 'pro_browser_use_elements')!.annotations?.readOnlyHint).toBe(true);
    expect(allTools().find((t) => t.name === 'pro_browser_use_words')!.annotations?.readOnlyHint).toBe(true);
  });
});

describe('a session id from the wrong engine', () => {
  it('refuses an id that never came from this engine and names the one that did', () => {
    // The observed failure: a `pro_browser_open` id sent to a `browser_use` tool, which answered "no session"
    // and left the caller hunting for a session that was never missing.
    expect(() => requireSession('not-a-bu-id')).toThrow(SessionError);
    try {
      requireSession('not-a-bu-id');
    } catch (error) {
      const failure = error as SessionError;
      expect(failure.hint).toContain('did not come from browser_use');
      expect(failure.hint).toContain('pro_browser_');
    }
  });

  it('distinguishes a closed browser_use session from a foreign id', () => {
    try {
      requireSession('bu-deadbeef');
      expect.unreachable();
    } catch (error) {
      const failure = error as SessionError;
      expect(failure.hint).toContain('browser_use_session_open');
      expect(failure.hint).not.toContain('did not come from browser_use');
    }
  });

  it('says so through the router too, for the tools a model actually calls', async () => {
    const result = await callTool('pro_browser_use_elements', { session_id: 'abcdef-1234' });
    expect(text(result)).toContain('did not come from browser_use');
    expect(result.isError).toBe(true);
  });

  it('asks for the session before it touches the page for download and upload', async () => {
    for (const name of ['pro_browser_use_download', 'pro_browser_use_upload']) {
      const result = await callTool(name, { session_id: 'bu-nosuch' });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('bu-nosuch');
    }
  });

  it('names both engines when a browser_use id reaches the browser family', async () => {
    // The mirror image of the case above, in the tool that a caller reaches first.
    const result = await callTool('pro_browser_browser_screenshot', { session_id: 'bu-12345678' });
    const body = text(result);
    expect(result.isError).toBe(true);
    expect(body).toContain('browser_use');
    expect(body).toContain('pro_browser_use_*');
  });
});

describe('an upload payload is checked before anything is handed over', () => {
  const b64 = (bytes: number): string => Buffer.alloc(bytes, 7).toString('base64');

  it('accepts the shape it documents and keeps the mime type the caller gave', () => {
    const parsed = parseUploadPayload([{ name: 'notes.txt', mime: 'text/plain', base64: b64(64) }]);
    expect('error' in parsed).toBe(false);
    const files = (parsed as { files: never[] }).files;
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe('notes.txt');
    expect(files[0]!.mimeType).toBe('text/plain');
    expect(files[0]!.buffer.byteLength).toBe(64);
  });

  it('defaults the mime type rather than sending an empty one', () => {
    const parsed = parseUploadPayload(JSON.stringify([{ name: 'a.bin', base64: b64(8) }]));
    const files = (parsed as { files: { mimeType: string }[] }).files;
    expect(files[0]!.mimeType).toBe('application/octet-stream');
  });

  it('refuses a name that is a path, because that is a local file request wearing an upload', () => {
    for (const name of ['../../secrets.env', 'C:\\Users\\user\\key.pem', 'dir/notes.txt']) {
      const parsed = parseUploadPayload([{ name, base64: b64(4) }]);
      expect('error' in parsed).toBe(true);
      expect((parsed as { error: string }).error).toContain('yo‘l emas');
    }
  });

  it('refuses an empty or unparsable base64 field instead of uploading a zero-byte file', () => {
    expect('error' in parseUploadPayload([{ name: 'a.txt', base64: '' }])).toBe(true);
    expect('error' in parseUploadPayload([{ name: 'a.txt', base64: '!!not base64!!' }])).toBe(true);
    expect('error' in parseUploadPayload('{"name":"a"}')).toBe(true);
  });

  it('holds the line between a form upload and a payload', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ name: `f${i}.txt`, base64: b64(16) }));
    expect((parseUploadPayload(many) as { error: string }).error).toContain('chegara 8');
    const huge = [{ name: 'big.bin', base64: b64(25 * 1024 * 1024 + 1) }];
    expect((parseUploadPayload(huge) as { error: string }).error).toContain('chegaradan oshdi');
  });

  it('adds the bytes of every file together, not just the largest', () => {
    // Nine files of 3 MB each are 27 MB: a per-file check would let them through and the session would
    // buffer all of them in memory to hand to one control.
    const eight = Array.from({ length: 8 }, (_, i) => ({ name: `f${i}.bin`, base64: b64(4 * 1024 * 1024) }));
    expect('error' in parseUploadPayload(eight)).toBe(true);
  });

  it('refuses an empty list rather than treating it as "list the controls"', () => {
    expect('error' in parseUploadPayload([])).toBe(true);
    expect('error' in parseUploadPayload('[]')).toBe(true);
  });
});

describe('a download asks for a trigger it can name', () => {
  it('refuses a call that names neither an element nor an address', async () => {
    // Session first, so this needs a session that does not exist; the argument rule is checked after it, and
    // the ordering is deliberate: a typo in the session id should not look like a typo in the target.
    const missing = await callTool('pro_browser_use_download', { session_id: 'bu-nosuch' });
    expect(missing.isError).toBe(true);
    const schema = allTools().find((t) => t.name === 'pro_browser_use_download')!;
    const properties = Object.keys((schema.inputSchema.properties ?? {}) as Record<string, unknown>);
    expect(properties).toContain('identity');
    expect(properties).toContain('url');
    expect(schema.inputSchema.additionalProperties).toBe(false);
  });
});
