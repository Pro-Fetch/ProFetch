/**
 * The input surface: the only place ProHuman touches a browser engine.
 *
 * ## Why an interface at all
 *
 * The pack is a layer over an existing engine, not a third engine. If the behaviour model called Playwright
 * directly it would be welded to `browser_use`, and the point of the design — that any engine able to move a
 * cursor can be humanised — would be lost. `InputSurface` is the contract; `browserUseSurface()` is the first
 * implementation of it.
 *
 * ## The seam is narrow on purpose, and it is documented where it is dishonest
 *
 * `livePage()` returns the few methods the session bridge uses, typed that way deliberately. ProHuman needs
 * pointer buttons, wheel and per-key down/up as well. The cast below is the honest place to say so: the
 * surface assumes a Playwright-shaped page, and if that assumption stops being true the methods throw — they
 * cannot silently do nothing, because a driver that reports a movement it never made is worse than one that
 * fails.
 */

import { livePage, type BrowserUseSession } from './browser-use-session.js';
import type { TraceEvent } from './prohuman-metrics.js';

export interface Viewport {
  width: number;
  height: number;
}

export interface TabInfo {
  index: number;
  url: string;
  title: string;
  active: boolean;
}

export interface InputSurface {
  /** Which engine this surface drives, for the report. */
  engine: string;
  pointerMove(x: number, y: number): Promise<void>;
  pointerDown(): Promise<void>;
  pointerUp(): Promise<void>;
  wheel(deltaY: number): Promise<void>;
  keyDown(key: string): Promise<void>;
  keyUp(key: string): Promise<void>;
  /** Install the recorder on the current document and on every document a navigation creates. */
  installRecorder(): Promise<string>;
  /** The events the page recorded. One document's worth — see `prohuman-metrics`. */
  readTrace(): Promise<TraceEvent[]>;
  /** Drop the recorded events, e.g. after a navigation, so a measurement covers one document. */
  clearTrace(): Promise<void>;
  viewport(): Promise<Viewport>;
  listTabs(): Promise<TabInfo[]>;
  activateTab(index: number): Promise<{ ok: boolean; reason?: string }>;
  currentUrl(): Promise<string>;
}

/**
 * The page-side recorder, as a string.
 *
 * It is a string for two reasons: the engine's other page-evaluated scripts are strings, and a transpiled
 * function carries a helper (`__name`) that does not exist inside the page — which is how the first spike run
 * died before it recorded anything. No backticks and no interpolation inside the body, same rule as the
 * collector and the word pass.
 */
export const PROHUMAN_RECORDER_SCRIPT = `(function () {
  if (window.__pfHumanRecorderInstalled) return 'already';
  window.__pfHumanRecorderInstalled = true;
  window.__pfHumanTrace = [];
  var push = function (e) {
    var row = {
      type: e.type,
      t: e.timeStamp,
      trusted: e.isTrusted,
      x: null,
      y: null,
      key: null,
      dy: null,
    };
    if (typeof e.clientX === 'number') { row.x = Math.round(e.clientX * 100) / 100; row.y = Math.round(e.clientY * 100) / 100; }
    if (typeof e.key === 'string') { row.key = e.key; }
    if (typeof e.deltaY === 'number') { row.dy = e.deltaY; }
    window.__pfHumanTrace.push(row);
    if (window.__pfHumanTrace.length > 20000) { window.__pfHumanTrace.shift(); }
  };
  var kinds = ['mousemove','mousedown','mouseup','click','keydown','keyup','wheel','blur','focus','visibilitychange'];
  for (var i = 0; i < kinds.length; i++) {
    window.addEventListener(kinds[i], push, { capture: true, passive: true });
  }
  return 'installed';
})()`;

const READ_TRACE_SCRIPT = `(function () {
  var out = [];
  var src = window.__pfHumanTrace || [];
  for (var i = 0; i < src.length; i++) out.push(src[i]);
  return out;
})()`;

const CLEAR_TRACE_SCRIPT = `(function () { window.__pfHumanTrace = []; return 0; })()`;

const VIEWPORT_SCRIPT = `(function () { return { width: window.innerWidth, height: window.innerHeight }; })()`;

/**
 * The page shape ProHuman needs. Structural, not imported from Playwright: the pack should compile against
 * an engine that satisfies it, not against one particular library's types. The same type describes the
 * driven page and the other tabs, because `active` is decided by identity and that only works if both sides
 * are the same shape.
 */
type PageLike = {
  evaluate<T>(script: string): Promise<T>;
  addInitScript(script: { content: string } | string): Promise<void>;
  mouse: {
    move(x: number, y: number): Promise<void>;
    down(): Promise<void>;
    up(): Promise<void>;
    wheel(dx: number, dy: number): Promise<void>;
  };
  keyboard: { down(key: string): Promise<void>; up(key: string): Promise<void> };
  url(): string;
  title(): Promise<string>;
  bringToFront(): Promise<void>;
  context(): { pages(): PageLike[] };
};

export class SurfaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SurfaceError';
  }
}

/**
 * Wrap a `browser_use` session as an input surface.
 *
 * The session is captured, not the page: a session can be closed and reopened by the bridge, and a surface
 * holding a stale page would drive nothing while reporting success.
 */
export function browserUseSurface(session: BrowserUseSession): InputSurface {
  const page = livePage(session) as unknown as PageLike;
  const pages = () => {
    try {
      return page.context().pages();
    } catch (error) {
      throw new SurfaceError(`the engine does not expose its pages: ${(error as Error).message}`);
    }
  };

  return {
    engine: 'browser_use',
    async pointerMove(x, y) {
      await page.mouse.move(x, y);
    },
    async pointerDown() {
      await page.mouse.down();
    },
    async pointerUp() {
      await page.mouse.up();
    },
    async wheel(deltaY) {
      await page.mouse.wheel(0, deltaY);
    },
    async keyDown(key) {
      await page.keyboard.down(key);
    },
    async keyUp(key) {
      await page.keyboard.up(key);
    },
    async installRecorder() {
      // Both calls matter. `addInitScript` alone does not touch the document that is already open; a plain
      // evaluate alone dies with the next navigation, which is what the spike measured the hard way.
      await page.addInitScript(PROHUMAN_RECORDER_SCRIPT);
      return page.evaluate<string>(PROHUMAN_RECORDER_SCRIPT);
    },
    async readTrace() {
      return page.evaluate<TraceEvent[]>(READ_TRACE_SCRIPT);
    },
    async clearTrace() {
      await page.evaluate<number>(CLEAR_TRACE_SCRIPT);
    },
    async viewport() {
      return page.evaluate<Viewport>(VIEWPORT_SCRIPT);
    },
    async listTabs() {
      const all = pages();
      const out: TabInfo[] = [];
      for (const [index, p] of all.entries()) {
        out.push({ index, url: p.url(), title: await p.title().catch(() => ''), active: p === page });
      }
      return out;
    },
    async activateTab(index) {
      const all = pages();
      const target = all[index];
      if (!target) return { ok: false, reason: `no tab at index ${index} (${all.length} open)` };
      await target.bringToFront();
      return { ok: true };
    },
    async currentUrl() {
      return page.url();
    },
  };
}
