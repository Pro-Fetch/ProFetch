/**
 * The session bridge: one place where a `browser_use` session becomes a live page, a world model and a
 * coverage ledger.
 *
 * Every session-bound tool needs the same three things — a page that was reached through the SSRF guard,
 * a model that has been updated since the last call, and a ledger that says what has been read. If each
 * tool did that itself there would be eleven definitions of "what this session knows", and the interesting
 * bugs (a stale identity accepted, a snapshot recorded against the wrong document, a browser left running)
 * would live in the copies.
 *
 * Reads of the page go through the collector, so a session's node list is produced the same way the probe
 * produces it, and frame offsets are measured rather than assumed.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { assertSafeUrl, UrlSecurityError } from './ssrf-guard.js';
import { COLLECTOR_CAP, collectorScript } from './browser-use-collector.js';
import { MAX_WORDS, wordScript, type WordReport } from './browser-use-words.js';
import { buildSnapshot, type Snapshot } from './browser-use-perception.js';
import { applySnapshot, createWorldModel, type WorldModel } from './browser-use-world.js';
import { collectAllFrames, type FrameCollection } from './browser-use-frames.js';
import { createLedger, recordSnapshot, type Ledger } from './browser-use-coverage.js';
import { detectInstalled, launchManaged } from './browser-use-runtime.js';
import { localRegistry } from './browser-use-runtime.js';
import { selectBrowser } from './browser-use-registry.js';
import type { BrowserRequest, DetectedBrowser } from './browser-use-contract.js';

export interface BrowserUseSession {
  id: string;
  browser: DetectedBrowser;
  protocol: string;
  mode: string;
  dataRoot: string;
  url: string;
  title: string;
  openedAt: number;
  lastUsedAt: number;
  model: WorldModel;
  ledger: Ledger | null;
  frames: FrameCollection | null;
  /** A temporary profile is deleted on close; a caller-supplied one is left alone. */
  ownsProfile: boolean;
}

/** A browser download the session was told about, before it is saved anywhere. */
export interface DownloadHandle {
  suggestedFilename(): string;
  /** The address the bytes came from — provenance, not decoration. */
  url(): string;
  cancel(): Promise<void>;
  saveAs(target: string): Promise<string>;
  path(): Promise<string | null>;
}

/** A file handed to a control as bytes the caller already holds, so no local path is ever read. */
export interface FilePayload {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

interface LiveHandles {
  context: {
    pages(): Array<LiveHandles['page']>;
    newPage(): Promise<LiveHandles['page']>;
    close(): Promise<void>;
    browser(): { close(): Promise<void> } | null;
  };
  page: {
    url(): string;
    title(): Promise<string>;
    frames(): FrameLike[];
    goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
    evaluate(script: string): Promise<unknown>;
    setViewportSize(o: { width: number; height: number }): Promise<void>;
    screenshot(options?: {
      fullPage?: boolean;
      animations?: string;
      clip?: { x: number; y: number; width: number; height: number };
    }): Promise<Buffer>;
    mouse: { click(x: number, y: number): Promise<void>; move(x: number, y: number): Promise<void> };
    keyboard: { type(text: string): Promise<void>; press(key: string): Promise<void> };
    waitForTimeout(ms: number): Promise<void>;
    waitForEvent(event: 'download', options?: { timeout?: number }): Promise<DownloadHandle>;
    setInputFiles(selector: string, files: FilePayload | FilePayload[], options?: { timeout?: number }): Promise<void>;
  };
}

const sessions = new Map<string, BrowserUseSession>();
const handles = new WeakMap<BrowserUseSession, LiveHandles>();

/** Sessions idle for longer than this are closed automatically, so a forgotten tab cannot pin a browser. */
const IDLE_MS = 15 * 60 * 1000;

export class SessionError extends Error {
  constructor(
    message: string,
    readonly hint: string = '',
  ) {
    // The hint is part of the message, on purpose. Every tool in this pack answers a failure with
    // `fail(error.message)`, so a hint that lived only on a second field was written for a reader who never
    // saw it — including the one that tells a caller their session id came from the other engine.
    super(hint ? `${message} — ${hint}` : message);
    this.name = 'SessionError';
  }
}

export function sessionIds(): string[] {
  return [...sessions.keys()];
}

export function getSession(id: string): BrowserUseSession | undefined {
  const session = sessions.get(id);
  if (!session) return undefined;
  session.lastUsedAt = Date.now();
  return session;
}

/** Close every session that has been idle too long. Called before a new open, not on a timer. */
export async function reapIdle(): Promise<number> {
  const now = Date.now();
  let closed = 0;
  for (const [id, session] of [...sessions]) {
    if (now - session.lastUsedAt < IDLE_MS) continue;
    await closeSession(id);
    closed++;
  }
  return closed;
}

export async function closeSession(id: string): Promise<boolean> {
  const session = sessions.get(id);
  if (!session) return false;
  const live = handles.get(session);
  handles.delete(session);
  sessions.delete(id);
  try {
    await live?.context.close();
  } catch {
    /* the browser may already be gone */
  }
  try {
    await live?.context.browser()?.close();
  } catch {
    /* as above */
  }
  if (session.ownsProfile) await rm(session.dataRoot, { recursive: true, force: true }).catch(() => {});
  return true;
}

export async function closeAll(): Promise<number> {
  const ids = [...sessions.keys()];
  for (const id of ids) await closeSession(id);
  return ids.length;
}

export interface OpenOptions {
  url: string;
  request?: BrowserRequest;
  headless?: boolean;
  viewport?: { width: number; height: number };
  /** Reuse a caller's profile directory instead of a temporary one. */
  profileRoot?: string;
  budget?: number;
  declaredContentHeight?: boolean;
}

/**
 * Open a session: choose a browser, launch it, navigate, and take the first snapshot.
 *
 * The navigation happens before the collector runs, and the URL is checked first. A refusal is a
 * `SessionError` with the reason the guard gave, because "cannot browse that" is the answer the caller
 * needs and not an internal failure to hide behind a stack trace.
 */
export async function openSession(options: OpenOptions): Promise<BrowserUseSession> {
  await reapIdle();
  let safe: URL;
  try {
    safe = await assertSafeUrl(options.url);
  } catch (error) {
    if (error instanceof UrlSecurityError) {
      throw new SessionError(
        error.message,
        'only public http(s) targets are opened; the guard refuses private addresses and other schemes',
      );
    }
    throw error;
  }
  const registry = await localRegistry({ readVersions: true });
  const resolved = selectBrowser(registry, options.request ?? {}, { allowPartial: true });
  if (!resolved.ok || !resolved.browser) {
    const installed = registry.entries.map((e) => e.browser.product);
    throw new SessionError(
      `no browser available for this session: ${resolved.blocker ?? 'the request could not be satisfied'}`,
      installed.length
        ? `installed: ${installed.join(', ')}`
        : 'nothing the registry recognises is installed on this host',
    );
  }
  const ownsProfile = !options.profileRoot;
  const dataRoot = options.profileRoot ?? (await mkdtemp(path.join(tmpdir(), 'pro-fetch-bu-session-')));
  const launched = await launchManaged(resolved.browser.product, {
    dataRoot,
    headless: options.headless !== false,
  });
  if (!launched.ok) {
    if (ownsProfile) await rm(dataRoot, { recursive: true, force: true }).catch(() => {});
    throw new SessionError(
      `launch failed: ${launched.reason}`,
      'the browser exists but did not start — see browser_use_browsers_launch_plan for the exact arguments',
    );
  }

  const context = launched.session.context as unknown as LiveHandles['context'];
  let page: LiveHandles['page'];
  try {
    const existing = context.pages()[0];
    page = existing ?? ((await context.newPage()) as LiveHandles['page']);
    if (options.viewport) await page.setViewportSize(options.viewport);
    await page.goto(safe.toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 });
  } catch (error) {
    await context.close().catch(() => {});
    if (ownsProfile) await rm(dataRoot, { recursive: true, force: true }).catch(() => {});
    if (error instanceof UrlSecurityError)
      throw new SessionError(error.message, 'the guard refused this target before the browser was started');
    throw new SessionError(
      `navigation failed: ${(error as Error).message}`,
      'the page may need longer than 45s, or it may not exist',
    );
  }

  const session: BrowserUseSession = {
    id: 'bu-' + randomUUID().slice(0, 8),
    browser: resolved.browser,
    protocol: resolved.protocol ?? 'unknown',
    mode: resolved.mode ?? 'managed',
    dataRoot,
    url: page.url(),
    title: await page.title().catch(() => ''),
    openedAt: Date.now(),
    lastUsedAt: Date.now(),
    model: null as unknown as WorldModel,
    ledger: null,
    frames: null,
    ownsProfile,
  };
  handles.set(session, { context, page });
  sessions.set(session.id, session);
  try {
    await refresh(session, { budget: options.budget });
  } catch (error) {
    await closeSession(session.id);
    throw error instanceof SessionError
      ? error
      : new SessionError(
          `the page opened but could not be read: ${(error as Error).message}`,
          'a frame or dialog may have taken over; try again after closing dialogs',
        );
  }
  return session;
}

/** Look up a session or fail with the ids that do exist, so a typo is not a mystery. */
export function requireSession(id: string | undefined): BrowserUseSession {
  if (!id) {
    const known = sessionIds();
    throw new SessionError(
      'session_id is required',
      known.length ? `open sessions: ${known.join(', ')}` : 'none are open — call browser_use_session_open first',
    );
  }
  const session = getSession(id);
  if (session) return session;
  const known = sessionIds();
  // The two session families are not interchangeable, and the confusing case is an id from the other one.
  // `bu-` is this engine's shape, so an id without it never came from here, and one with it came from here
  // and has since been closed or idle-reaped. Saying which is the difference between a fixable call and a
  // search for a session that was never missing.
  const foreign = !id.startsWith('bu-');
  const where = foreign
    ? 'this id did not come from browser_use: ids from pro_browser_open belong to the `browser` engine and are only accepted by pro_browser_* tools'
    : 'browser_use ids are issued by browser_use_session_open and look like bu-1a2b3c4d';
  throw new SessionError(
    `no session "${id}"`,
    [where, known.length ? `open here: ${known.join(', ')}` : 'no browser_use session is currently open'].join('; '),
  );
}

export interface RefreshResult {
  snapshot: Snapshot;
  transition: string;
  version: number;
  contentHeight: number | null;
}

/**
 * Read the page again and fold it into the model and the ledger.
 *
 * The content height is measured here rather than trusted from the last call: a page that grows when a
 * disclosure opens is a page whose coverage changed, and a ledger that kept the old height would report
 * full coverage of a document it has not finished reading.
 */
export async function refresh(session: BrowserUseSession, options: { budget?: number } = {}): Promise<RefreshResult> {
  const live = handles.get(session);
  if (!live) throw new SessionError(`session ${session.id} has no live page`, 'it was closed — open it again');
  // The ceiling moves with the requested budget, because ranking cannot recover what the walk never saw: a
  // caller asking for 4000 nodes would still get the first 1500 the document happened to yield, in document
  // order, and a "visible elements" listing would quietly be the top of the DOM rather than the page.
  const script = collectorScript(Math.max(COLLECTOR_CAP, Math.floor(options.budget ?? 0)));
  const collected = await collectAllFrames(
    {
      frames: () => live.page.frames(),
    },
    async (frame) => {
      const data = (await evaluateIn(frame, script)) as {
        nodes: unknown[];
        url: string;
        title: string;
        scanned?: number;
        capped?: boolean;
      };
      return {
        nodes: data.nodes as never,
        url: typeof data.url === 'string' ? data.url : live.page.url(),
        title: typeof data.title === 'string' ? data.title : await live.page.title().catch(() => ''),
        scanned: typeof data.scanned === 'number' ? data.scanned : undefined,
        capped: data.capped === true,
      };
    },
    async (frame) => {
      try {
        return (await evaluateIn(frame, HOP_SCRIPT)) as { ok: boolean; x?: number; y?: number; reason?: string };
      } catch (error) {
        return { ok: false, reason: (error as Error).message.slice(0, 120) };
      }
    },
  );
  session.url = live.page.url();
  session.title = await live.page.title().catch(() => session.title);
  session.frames = collected;

  const geometry = (await live.page.evaluate(GEOMETRY_SCRIPT)) as {
    scroll: { x: number; y: number };
    viewport: { width: number; height: number };
    deviceScaleFactor: number;
    contentHeight: number;
    truncated: number;
  };
  const snapshot = buildSnapshot(collected.nodes, {
    snapshotId: `${session.id}:${Date.now()}`,
    url: session.url,
    title: session.title,
    viewport: geometry.viewport,
    deviceScaleFactor: geometry.deviceScaleFactor,
    scroll: geometry.scroll,
    capturedAt: Date.now(),
    budget: options.budget ?? 400,
    walk: collected.walk,
  });
  if (!session.model) {
    session.model = createWorldModel(snapshot, {
      tabId: session.id,
      contentHeight: geometry.contentHeight,
      declaredFrames: collected.frames.map((f) => f.frameId),
    });
    session.ledger = createLedger(snapshot, {
      contentHeight: geometry.contentHeight,
      declaredFrames: collected.frames.map((f) => ({
        frameId: f.frameId,
        positionKnown: (collected.offsets.get(f.frameId) ?? null) !== null,
      })),
    });
  } else {
    const update = applySnapshot(session.model, snapshot, {
      tabId: session.id,
      contentHeight: geometry.contentHeight,
      declaredFrames: collected.frames.map((f) => f.frameId),
    });
    session.model = update.model;
    if (session.ledger) session.ledger = recordSnapshot(session.ledger, snapshot, { stepCosts: false });
  }
  return {
    snapshot,
    transition: `${session.model.version}: ${session.model.transitions.at(-1)?.kind}`,
    version: session.model.version,
    contentHeight: geometry.contentHeight,
  };
}

/** Playwright's frame objects are not ours to model, so the page exposes them through a narrow shape. */
interface FrameLike {
  url(): string;
  name(): string;
  parentFrame(): FrameLike | null;
}

/**
 * Every real Playwright frame can evaluate a script; the frame type in `browser-use-frames` is deliberately
 * smaller than that because the collector contract only needs identity. This is the one place the two meet.
 */
async function evaluateIn(frame: FrameLike, script: string): Promise<unknown> {
  const evaluatable = frame as unknown as { evaluate(source: string): Promise<unknown> };
  return evaluatable.evaluate(script);
}

/** Measured inside each frame: its own position in the parent, or the reason it cannot report one. */
export const HOP_SCRIPT = `(() => {
  try {
    const el = window.frameElement;
    if (!el) return { ok: true, x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    return { ok: true, x: Math.round(r.left * 100) / 100, y: Math.round(r.top * 100) / 100 };
  } catch (error) {
    return { ok: false, reason: String((error && error.message) || error) };
  }
})()`;

/** Scroll, viewport, pixel ratio and document height, read in one round trip. */
export const GEOMETRY_SCRIPT = `(() => ({
  scroll: { x: window.scrollX, y: window.scrollY },
  viewport: { width: window.innerWidth, height: window.innerHeight },
  deviceScaleFactor: window.devicePixelRatio || 1,
  contentHeight: document.documentElement.scrollHeight,
}))()`;

/** The live page, for the few tools that must act on it. */
export function livePage(session: BrowserUseSession): LiveHandles['page'] {
  const live = handles.get(session);
  if (!live) throw new SessionError(`session ${session.id} has no live page`, 'it was closed — open it again');
  return live.page;
}

/** Scroll to a page position and read again. Returns the new model version. */
export async function scrollTo(session: BrowserUseSession, y: number): Promise<RefreshResult> {
  const live = handles.get(session);
  if (!live) throw new SessionError(`session ${session.id} has no live page`, 'it was closed — open it again');
  await live.page.evaluate(`(() => { window.scrollTo(0, ${Math.max(0, Math.round(y))}); return window.scrollY; })()`);
  await live.page.waitForTimeout(60);
  return refresh(session, {});
}

/**
 * Navigate the session. The target goes through the same guard as the first open, because a session that
 * could be sent anywhere by a later call would have undone the check that opened it.
 */
export async function navigate(session: BrowserUseSession, url: string): Promise<RefreshResult> {
  const live = handles.get(session);
  if (!live) throw new SessionError(`session ${session.id} has no live page`, 'it was closed — open it again');
  let safe: URL;
  try {
    safe = await assertSafeUrl(url);
  } catch (error) {
    if (error instanceof UrlSecurityError)
      throw new SessionError(error.message, 'only public http(s) targets are navigated to');
    throw error;
  }
  await live.page.goto(safe.toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 });
  return refresh(session, {});
}

/** Step through the browser's own history, then re-read so the model follows. */
export async function historyStep(
  session: BrowserUseSession,
  step: 'back' | 'forward' | 'reload',
): Promise<RefreshResult> {
  const live = handles.get(session);
  if (!live) throw new SessionError(`session ${session.id} has no live page`, 'it was closed — open it again');
  const script = step === 'back' ? 'history.back()' : step === 'forward' ? 'history.forward()' : 'location.reload()';
  await live.page.evaluate(`(() => { ${script}; return true; })()`);
  await live.page.waitForTimeout(250);
  return refresh(session, {});
}

/**
 * Wait for a condition by polling real reads, not by sleeping.
 *
 * The predicate is evaluated against the snapshot the session last read plus a fresh one, so "the element
 * appeared" means the collector saw it, not that a selector resolved once.
 */
export async function waitFor(
  session: BrowserUseSession,
  predicate: (snapshot: Snapshot) => boolean,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<{ satisfied: boolean; waitedMs: number; reads: number; snapshot: Snapshot }> {
  const deadline = Date.now() + (options.timeoutMs ?? 5000);
  const interval = Math.max(50, options.intervalMs ?? 250);
  let reads = 0;
  for (;;) {
    const { snapshot } = await refresh(session, {});
    reads++;
    if (predicate(snapshot))
      return { satisfied: true, waitedMs: Date.now() - (deadline - (options.timeoutMs ?? 5000)), reads, snapshot };
    if (Date.now() >= deadline) return { satisfied: false, waitedMs: options.timeoutMs ?? 5000, reads, snapshot };
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/** One capture, in the geometry the caller asked for. */
export async function capture(
  session: BrowserUseSession,
  kind: 'viewport' | 'full-page' | 'element',
  box?: { x: number; y: number; width: number; height: number },
): Promise<Buffer> {
  const live = handles.get(session);
  if (!live) throw new SessionError(`session ${session.id} has no live page`, 'it was closed — open it again');
  if (kind === 'element' && !box)
    throw new SessionError('an element capture needs its box', 'pass rect from the last snapshot');
  if (kind === 'full-page') return live.page.screenshot({ fullPage: true, animations: 'disabled' });
  if (kind === 'element') return live.page.screenshot({ clip: box, animations: 'disabled' });
  return live.page.screenshot({ animations: 'disabled' });
}

/** The tabs of a session's browser context. */
export async function tabs(
  session: BrowserUseSession,
): Promise<Array<{ index: number; url: string; title: string; active: boolean }>> {
  const live = handles.get(session);
  if (!live) throw new SessionError(`session ${session.id} has no live page`, 'it was closed — open it again');
  const pages = live.context.pages();
  const out: Array<{ index: number; url: string; title: string; active: boolean }> = [];
  for (const [index, page] of pages.entries()) {
    out.push({
      index,
      url: page.url(),
      title: await page.title().catch(() => ''),
      active: page === live.page,
    });
  }
  return out;
}

/** Cookies for a session's own origin. Read-only: this engine does not write another site's jar. */
export async function cookies(session: BrowserUseSession): Promise<Array<Record<string, unknown>>> {
  const live = handles.get(session);
  if (!live) throw new SessionError(`session ${session.id} has no live page`, 'it was closed — open it again');
  const ctx = live.context as unknown as { cookies(url?: string): Promise<Array<Record<string, unknown>>> };
  return ctx.cookies(session.url);
}

/** The session's storage state (cookies plus per-origin storage), written into the session's own root. */
export async function storageState(session: BrowserUseSession): Promise<unknown> {
  const live = handles.get(session);
  if (!live) throw new SessionError(`session ${session.id} has no live page`, 'it was closed — open it again');
  const target = path.join(session.dataRoot, `state-${Date.now()}.json`);
  const ctx = live.context as unknown as { storageState(options: { path: string }): Promise<unknown> };
  await ctx.storageState({ path: target });
  const { readFileSync } = await import('node:fs');
  return JSON.parse(readFileSync(target, 'utf8')) as unknown;
}

/**
 * Word geometry for the page the session last read.
 *
 * The collector must have run first: words are joined to elements through the `data-pf-id` the collector
 * stamps, so measuring words before a read would produce boxes with no owners. Only the top frame is
 * measured — a word inside a cross-origin iframe is not reachable from here, and a listing that quietly
 * omitted it would be a wrong transcript rather than a partial one. The caller is told which frames were
 * left out.
 */
export async function readWords(
  session: BrowserUseSession,
  options: { cap?: number } = {},
): Promise<WordReport & { frames_skipped: string[] }> {
  const live = handles.get(session);
  if (!live) throw new SessionError(`session ${session.id} has no live page`, 'it was closed — open it again');
  const script = wordScript(Math.max(MAX_WORDS, Math.floor(options.cap ?? 0)));
  const report = (await live.page.evaluate(script)) as WordReport;
  const frameIds = live.page.frames().map((f) => f.url());
  return { ...report, frames_skipped: frameIds.slice(1) };
}

/** Where a session's own files go. Never outside the session's data root, which is deleted on close. */
async function downloadsRoot(session: BrowserUseSession): Promise<string> {
  const dir = path.join(session.dataRoot, 'downloads');
  await mkdir(dir, { recursive: true });
  return dir;
}

/** A name a filesystem will accept, from whatever the server offered. */
function safeName(suggested: string, fallback: string): string {
  const base = path
    .basename(suggested || '')
    .replace(/[^\w.\-+() ]+/g, '_')
    .replace(/^[.\s]+/, '')
    .slice(0, 120);
  return base || fallback;
}

/** Size and sha256 of a file that is claimed to exist, measured from the bytes. */
async function measure(file: string): Promise<{ bytes: number; sha256: string }> {
  const { stat } = await import('node:fs/promises');
  const hash = createHash('sha256');
  const info = await stat(file);
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve());
    stream.on('error', (error) => reject(error));
  });
  return { bytes: info.size, sha256: hash.digest('hex') };
}

export interface DownloadOutcome {
  ok: boolean;
  trigger: string;
  suggested: string;
  saved_to: string;
  /** Whether the bytes went where the caller asked, or into a profile that dies with the session. */
  saved_within: string;
  bytes: number;
  sha256: string;
  /** The address the browser says the bytes came from. */
  source_url: string;
  failure: string;
}

/**
 * Wait for a download while something is clicked, then save and measure it.
 *
 * The listener is registered *before* the trigger: a download that finishes in the 5 ms between a click and
 * a `waitForEvent` call is a download nobody heard about. The file is saved inside the session's own root,
 * so a refused or abandoned transfer cannot leave bytes anywhere the caller did not already control, and the
 * result reports size and digest measured from the saved bytes — a download whose file is never opened is a
 * claim about a network event, not about a file.
 */
async function awaitingDownload(
  session: BrowserUseSession,
  trigger: string,
  run: () => Promise<void>,
  options: { timeoutMs: number; saveTo: string },
): Promise<DownloadOutcome> {
  const live = handles.get(session);
  if (!live) throw new SessionError(`session ${session.id} has no live page`, 'it was closed — open it again');
  const { assertWritable } = await import('./read-only-guard.js');
  assertWritable('sessiya papkasiga fayl yuklab olish');
  const waiting = live.page.waitForEvent('download', { timeout: options.timeoutMs });
  try {
    await run();
  } catch (error) {
    // Consume the pending listener, or a trigger that threw leaves an unhandled rejection behind.
    await waiting.catch(() => undefined);
    throw error;
  }
  const download = await waiting;
  const suggested = download.suggestedFilename();
  const target = options.saveTo || path.join(await downloadsRoot(session), safeName(suggested, 'download.bin'));
  try {
    await download.saveAs(target);
  } catch (error) {
    return {
      ok: false,
      trigger,
      suggested,
      saved_to: '',
      saved_within: '',
      bytes: 0,
      sha256: '',
      source_url: download.url(),
      failure: `saveAs failed: ${(error as Error).message.slice(0, 200)}`,
    };
  }
  const measured = await measure(target);
  const saved_within = options.saveTo
    ? 'the path the caller chose'
    : 'session profile — deleted when the session closes';
  if (!measured.bytes) {
    return {
      ok: false,
      trigger,
      suggested,
      saved_to: target,
      saved_within,
      bytes: 0,
      sha256: measured.sha256,
      source_url: download.url(),
      failure: 'the saved file is empty — the transfer did not deliver bytes',
    };
  }
  return {
    ok: true,
    trigger,
    suggested,
    saved_to: target,
    saved_within,
    bytes: measured.bytes,
    sha256: measured.sha256,
    source_url: download.url(),
    failure: '',
  };
}

/** Click a point in the page and take whatever download it starts. */
export async function downloadByClick(
  session: BrowserUseSession,
  point: { x: number; y: number },
  options: { timeoutMs?: number; saveTo?: string } = {},
): Promise<DownloadOutcome> {
  const live = handles.get(session);
  if (!live) throw new SessionError(`session ${session.id} has no live page`, 'it was closed — open it again');
  return awaitingDownload(
    session,
    `click at ${Math.round(point.x)},${Math.round(point.y)}`,
    () => live.page.mouse.click(point.x, point.y),
    { timeoutMs: options.timeoutMs ?? 30_000, saveTo: options.saveTo ?? '' },
  );
}

/**
 * Ask the page itself to fetch a URL and keep the result.
 *
 * The address is put into a script string through JSON, so a URL containing a quote cannot escape its
 * literal, and it goes through the same SSRF guard as a navigation — a download tool that would fetch
 * anything the page referenced would be a wider door than the one that opened the session. The anchor is
 * clicked in the top frame, which is what makes the browser, not this server, do the fetching: cookies,
 * redirects and same-origin rules stay the browser's business.
 */
export async function downloadByUrl(
  session: BrowserUseSession,
  url: string,
  options: { timeoutMs?: number; saveTo?: string } = {},
): Promise<DownloadOutcome> {
  const live = handles.get(session);
  if (!live) throw new SessionError(`session ${session.id} has no live page`, 'it was closed — open it again');
  let safe: URL;
  try {
    safe = await assertSafeUrl(url);
  } catch (error) {
    if (error instanceof UrlSecurityError)
      throw new SessionError(error.message, 'only public http(s) targets are downloaded');
    throw error;
  }
  const href = JSON.stringify(safe.toString());
  return awaitingDownload(
    session,
    `anchor click for ${safe.host}${safe.pathname.slice(0, 60)}`,
    async () => {
      await live.page.evaluate(
        `(() => { const a = document.createElement('a'); a.href = ${href}; a.rel = 'noreferrer'; a.style.display = 'none';` +
          ` document.body.appendChild(a); a.click(); setTimeout(() => a.remove(), 2000); return true; })()`,
      );
    },
    { timeoutMs: options.timeoutMs ?? 30_000, saveTo: options.saveTo ?? '' },
  );
}

export interface UploadOutcome {
  ok: boolean;
  control: string;
  /** What the control reports after the hand-off — read back from the page, not from the request. */
  accepted: Array<{ name: string; size: number; type: string }>;
  handed: Array<{ name: string; size: number }>;
  failure: string;
}

/** The CSS attribute selector for one stamped node, with the value stripped to characters a selector accepts. */
function stampedSelector(attribute: 'data-pf-id' | 'data-pf-upload', value: string): string {
  return `[${attribute}="${value.replace(/[^A-Za-z0-9_-]/g, '')}"]`;
}

/**
 * Every file control the top frame holds, including the ones a page hides.
 *
 * A styled upload widget keeps its real `input[type=file]` at `display:none`, which the collector's
 * visibility filter is correct to drop for clicking purposes and wrong for handing it bytes: `setInputFiles`
 * does not need the control to be visible, only to exist. The probe stamps each one so the caller can name
 * it back without a CSS selector of its own.
 */
export async function listFileInputs(session: BrowserUseSession): Promise<Array<Record<string, unknown>>> {
  const live = handles.get(session);
  if (!live) throw new SessionError(`session ${session.id} has no live page`, 'it was closed — open it again');
  const found = (await live.page.evaluate(FILE_INPUT_SCRIPT)) as Array<Record<string, unknown>>;
  return Array.isArray(found) ? found : [];
}

/** Evaluated in the page: find file inputs, stamp them, describe what they accept. */
export const FILE_INPUT_SCRIPT = `(() => {
  const list = Array.from(document.querySelectorAll('input[type=file]'));
  return list.map((el, index) => {
    const handle = 'pfu-' + (index + 1);
    el.setAttribute('data-pf-upload', handle);
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    const labels = el.labels ? Array.prototype.slice.call(el.labels).map((l) => (l.textContent || '').trim()).join(' ') : '';
    return {
      upload_id: handle,
      stamped_id: el.getAttribute('data-pf-id') || null,
      name: el.name || '',
      id: el.id || '',
      accept: el.getAttribute('accept') || '',
      multiple: el.multiple === true,
      disabled: el.disabled === true,
      required: el.required === true,
      rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
      visible: st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0,
      label: labels.replace(/\\s+/g, ' ').trim().slice(0, 120),
      held: el.files ? el.files.length : 0,
    };
  });
})()`;

/**
 * Hand bytes to a file control and ask the page what it now holds.
 *
 * Only caller-supplied bytes are accepted. A local path would turn this tool into a file reader with a
 * network sink attached, and the site would be the one deciding which file the session was allowed to open.
 * The read-back is the point: `setInputFiles` resolving is not evidence a page accepted the file — a script
 * can reject it, a `change` handler can clear it, and a control inside a widget that never forwards to the
 * input holds nothing. So the answer is the control's own `files` list, after the hand-off.
 */
export async function uploadFiles(
  session: BrowserUseSession,
  control: { kind: 'data-pf-id' | 'data-pf-upload'; value: string },
  files: FilePayload[],
): Promise<UploadOutcome> {
  const live = handles.get(session);
  if (!live) throw new SessionError(`session ${session.id} has no live page`, 'it was closed — open it again');
  const selector = stampedSelector(control.kind, control.value);
  try {
    await live.page.setInputFiles(selector, files.length === 1 ? files[0]! : files, { timeout: 15_000 });
  } catch (error) {
    return {
      ok: false,
      control: selector,
      accepted: [],
      handed: files.map((f) => ({ name: f.name, size: f.buffer.byteLength })),
      failure: `setInputFiles failed: ${(error as Error).message.slice(0, 200)}`,
    };
  }
  const readBack = (await live.page.evaluate(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)});` +
      ` if (!el) return { missing: true, files: [] };` +
      ` const list = el.files ? Array.from(el.files) : [];` +
      ` return { missing: false, multiple: el.multiple === true, files: list.map((f) => ({ name: f.name, size: f.size, type: f.type })) }; })()`,
  )) as { missing?: boolean; multiple?: boolean; files: Array<{ name: string; size: number; type: string }> };
  if (readBack.missing) {
    return {
      ok: false,
      control: selector,
      accepted: [],
      handed: files.map((f) => ({ name: f.name, size: f.buffer.byteLength })),
      failure: 'the control the bytes were sent to is no longer in the document',
    };
  }
  return {
    ok: readBack.files.length > 0,
    control: selector,
    accepted: readBack.files,
    handed: files.map((f) => ({ name: f.name, size: f.buffer.byteLength })),
    failure: readBack.files.length ? '' : 'the hand-off resolved but the control reports no files',
  };
}

/** The browser the session is running in, for reporting. */
export function sessionSummary(session: BrowserUseSession): Record<string, unknown> {
  return {
    session_id: session.id,
    product: session.browser.product,
    version: session.browser.version || 'unreadable',
    engine: session.browser.engine,
    protocol: session.protocol,
    mode: session.mode,
    url: session.url,
    title: session.title,
    model_version: session.model.version,
    document: session.model.documentSignature,
    identities: session.model.nodes.size,
    nodes_in_latest: session.model.latest.nodes.length,
    opened_at: session.openedAt,
    idle_seconds: Math.round((Date.now() - session.lastUsedAt) / 1000),
    profile: session.ownsProfile ? 'temporary (deleted on close)' : session.dataRoot,
  };
}

/** Only for tests and shutdown. */
export function sessionCount(): number {
  return sessions.size;
}
