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

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { assertSafeUrl, UrlSecurityError } from './ssrf-guard.js';
import { COLLECTOR_SCRIPT } from './browser-use-collector.js';
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
    super(message);
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
  if (!session) {
    const known = sessionIds();
    throw new SessionError(
      `no session "${id}"`,
      known.length ? `open sessions: ${known.join(', ')}` : 'no session is currently open',
    );
  }
  return session;
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
  const collected = await collectAllFrames(
    {
      frames: () => live.page.frames(),
    },
    async (frame) => {
      const data = (await evaluateIn(frame, COLLECTOR_SCRIPT)) as {
        nodes: unknown[];
        url: string;
        title: string;
      };
      return {
        nodes: data.nodes as never,
        url: typeof data.url === 'string' ? data.url : live.page.url(),
        title: typeof data.title === 'string' ? data.title : await live.page.title().catch(() => ''),
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
