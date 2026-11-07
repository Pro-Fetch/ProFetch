/**
 * The browser pool's bookkeeping, checked against a fake process.
 *
 * Nothing here needs Chromium. What is being pinned is the arithmetic that decides whether a run of rendered
 * reads costs one process or fifty: the size cap, the page ceiling that retires a grown process, the idle
 * sweep that must never reach into a read in flight, the queue that forms when the cap is full, and the
 * shutdown that must neither leak a process nor launch a new one after it was asked to stop.
 *
 * The live half of this — what a pool actually saves — is measured separately, because a fake process proves
 * the accounting and proves nothing about a second of startup time.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Browser, Page } from 'playwright';
import { BrowserPool, closeBrowserPool, poolSettings, type PoolSettings } from '../src/core/browser-pool.js';

const launched: Array<{ contexts: number; closed: boolean }> = [];
const contextLog: Array<{ createdFor: string; closed: boolean; pages: number }> = [];

vi.mock('playwright', () => ({
  chromium: {
    launch: async () => {
      const entry = { contexts: 0, closed: false };
      launched.push(entry);
      return {
        newContext: async () => {
          entry.contexts++;
          const record: { createdFor: string; closed: boolean; pages: number } = {
            createdFor: 'x',
            closed: false,
            pages: 0,
          };
          contextLog.push(record);
          return {
            addInitScript: async () => {},
            route: async () => {},
            close: async () => {
              record.closed = true;
            },
            newPage: async () => ({
              goto: async (url: string) => {
                record.createdFor = url;
              },
              close: async () => {
                record.pages++;
              },
              locator: async () => ({ innerText: async () => 'painted' }),
            }),
          };
        },
        close: async () => {
          entry.closed = true;
        },
      };
    },
  },
}));

describe('the guarded page path runs on the pool', () => {
  afterEach(async () => {
    await closeBrowserPool();
    launched.length = 0;
    contextLog.length = 0;
  });

  it('starts one process for a run of reads and a fresh context for every one of them', async () => {
    const { withGuardedPage } = await import('../src/core/browser-tools.js');
    const first = await withGuardedPage('http://93.184.216.34/one', {}, async () => 'a');
    const second = await withGuardedPage('http://93.184.216.34/two', {}, async () => 'b');
    const third = await withGuardedPage('http://93.184.216.34/three', {}, async () => 'c');
    expect([first, second, third]).toEqual(['a', 'b', 'c']);
    expect(launched).toHaveLength(1);
    // Reuse stops at the process. Each read navigated in a context of its own, and each of those contexts
    // was closed on the way out — that is what keeps a cookie from one site arriving in the next answer.
    expect(contextLog).toHaveLength(3);
    expect(contextLog.map((entry) => entry.createdFor)).toEqual([
      'http://93.184.216.34/one',
      'http://93.184.216.34/two',
      'http://93.184.216.34/three',
    ]);
    expect(contextLog.every((entry) => entry.closed && entry.pages === 1)).toBe(true);
  });

  it('refuses a blocked address before it costs a process', async () => {
    const { withGuardedPage } = await import('../src/core/browser-tools.js');
    await expect(withGuardedPage('http://169.254.169.254/latest/meta-data/', {}, async () => 'no')).rejects.toThrow();
    expect(launched).toHaveLength(0);
  });
});

interface FakeBrowser {
  id: number;
  closed: boolean;
  close(): Promise<void>;
}

interface Control {
  /** Hold the read inside the page until somebody resolves this. */
  hold?: Promise<void>;
  /** Which process the read actually landed on, for reuse assertions. */
  onPage?: (browser: FakeBrowser) => void;
  /** Fail after the page was handed over, to check the release path. */
  boom?: boolean;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(settings: Partial<PoolSettings> = {}) {
  const config: PoolSettings = { size: 2, maxPages: 50, idleMs: 60_000, waitMs: 30_000, ...settings };
  const processes: FakeBrowser[] = [];
  let clock = 1_000;
  const pool = new BrowserPool({
    create: async () => {
      const browser = { id: processes.length + 1, closed: false } as FakeBrowser;
      browser.close = async () => {
        browser.closed = true;
      };
      processes.push(browser);
      return browser as unknown as Browser;
    },
    withPage: async <T>(browser: Browser, input: unknown, fn: (page: Page) => Promise<T>): Promise<T> => {
      const control = (input ?? {}) as Control;
      control.onPage?.(browser as unknown as FakeBrowser);
      if (control.hold) await control.hold;
      if (control.boom) throw new Error('read failed on purpose');
      return fn({ close: async () => {} } as unknown as Page);
    },
    settings: () => config,
    now: () => clock,
  });
  return {
    pool,
    processes,
    /** Move the pool's own clock, which is what the idle sweep reads. */
    tick: (ms: number) => {
      clock += ms;
    },
    /** Operator knobs a caller can turn while a test is running. */
    set: (patch: Partial<PoolSettings>) => Object.assign(config, patch),
    live: () => processes.filter((browser) => !browser.closed).length,
  };
}

describe('processes a run of reads costs', () => {
  it('serves every sequential read from one process', async () => {
    const h = harness();
    for (let i = 0; i < 5; i++) expect(await h.pool.run({}, async () => i)).toBe(i);
    const stats = h.pool.stats();
    expect(stats.reads).toBe(5);
    expect(stats.launches).toBe(1);
    expect(stats.size).toBe(1);
    expect(stats.max_pages_per_process).toBe(5);
    expect(stats.waited).toBe(0);
    expect(h.processes).toHaveLength(1);
  });

  it('never exceeds the cap: the third caller waits for the first to finish', async () => {
    const h = harness({ size: 2 });
    const first = deferred();
    const second = deferred();
    const third = deferred();
    const landed: number[] = [];
    const on = (browser: FakeBrowser) => landed.push(browser.id);

    const a = h.pool.run({ hold: first.promise, onPage: on }, async () => 'a');
    const b = h.pool.run({ hold: second.promise, onPage: on }, async () => 'b');
    const c = h.pool.run({ hold: third.promise, onPage: on }, async () => 'c');
    await new Promise((done) => setTimeout(done, 20));
    expect(h.pool.stats().size).toBe(2);
    expect(h.pool.stats().queued).toBe(1);

    first.resolve();
    expect(await a).toBe('a');
    await new Promise((done) => setTimeout(done, 20));
    expect(h.pool.stats().queued).toBe(0);
    second.resolve();
    third.resolve();
    expect(await Promise.all([b, c])).toEqual(['b', 'c']);
    const stats = h.pool.stats();
    expect(stats.reads).toBe(3);
    expect(stats.launches).toBe(2);
    expect(stats.waited).toBe(1);
    // The caller that waited was handed the process that came free, not a third one.
    expect(landed.filter((id) => id === 1).length + landed.filter((id) => id === 2).length).toBe(3);
    expect(landed).not.toContain(3);
  });

  it('releases the process when the read throws, so one failure cannot wedge the pool', async () => {
    const h = harness({ size: 1 });
    await expect(h.pool.run({ boom: true }, async () => 'no')).rejects.toThrow('read failed on purpose');
    expect(h.pool.stats().busy).toBe(0);
    expect(h.pool.stats().inflight).toBe(0);
    expect(await h.pool.run({}, async () => 'second works')).toBe('second works');
    expect(h.pool.stats().launches).toBe(1);
  });
});

describe('retirement', () => {
  it('throws away a process after its page ceiling and starts a fresh one', async () => {
    const h = harness({ maxPages: 2 });
    for (let i = 0; i < 3; i++) await h.pool.run({}, async () => i);
    const stats = h.pool.stats();
    expect(stats.launches).toBe(2);
    expect(stats.restarts).toBe(1);
    expect(stats.swept_idle).toBe(0);
    expect(stats.max_pages_per_process).toBe(2);
    expect(h.processes[0].closed).toBe(true);
    expect(h.live()).toBe(1);
  });

  it('sweeps a process nobody has touched, on the next acquisition rather than on a timer', async () => {
    const h = harness({ idleMs: 1_000 });
    await h.pool.run({}, async () => 1);
    expect(h.pool.stats().size).toBe(1);
    h.tick(2_000);
    await h.pool.run({}, async () => 2);
    const stats = h.pool.stats();
    expect(stats.swept_idle).toBe(1);
    expect(stats.launches).toBe(2);
    expect(h.processes[0].closed).toBe(true);
    // A sweep is not a restart: the retired process is not counted as having reached its page ceiling.
    expect(stats.restarts).toBe(0);
  });

  it('never reaches into a process with a read in flight, however long it has been idle', async () => {
    const h = harness({ size: 2, idleMs: 1_000 });
    const held = deferred();
    const running = h.pool.run({ hold: held.promise }, async () => 'inside');
    await new Promise((done) => setTimeout(done, 20));
    h.tick(30_000);
    await h.pool.run({}, async () => 'next');
    expect(h.pool.stats().swept_idle).toBe(0);
    expect(h.processes[0].closed).toBe(false);
    expect(h.live()).toBe(2);
    held.resolve();
    expect(await running).toBe('inside');
  });

  it('leaves nothing behind when nothing is asked of it', async () => {
    const h = harness();
    expect(await h.pool.sweep()).toBe(0);
    expect(h.pool.stats().size).toBe(0);
  });
});

describe('the queue has a deadline the operator owns', () => {
  it('refuses by name when every process is held past the wait', async () => {
    const h = harness({ size: 1, waitMs: 40 });
    const held = deferred();
    const running = h.pool.run({ hold: held.promise }, async () => 'held');
    await new Promise((done) => setTimeout(done, 20));
    await expect(h.pool.run({}, async () => 'never')).rejects.toThrow(/BRAUSER_HAVZASI_TOYIB/);
    expect(h.pool.stats().queue_timeouts).toBe(1);
    // The refusal said what to change; a stack trace would not have.
    held.resolve();
    expect(await running).toBe('held');
    expect(h.pool.stats().size).toBe(1);
  });

  it('names the pool being closed to a caller that was waiting on it', async () => {
    const h = harness({ size: 1 });
    const held = deferred();
    const running = h.pool.run({ hold: held.promise }, async () => 'held');
    await new Promise((done) => setTimeout(done, 20));
    const queued = h.pool.run({}, async () => 'never');
    const closing = h.pool.close();
    await expect(queued).rejects.toThrow(/BRAUSER_HAVZASI_YOPILDI/);
    held.resolve();
    // The read already inside is allowed to finish, and finishes with its answer intact: the release path
    // sits in a `finally`, and a `return` there would replace the completion value with `undefined` — or
    // swallow the error of a read that failed. This line is the pin that keeps it a chain.
    expect(await running).toBe('held');
    await closing;
    // A process that was mid-read when the pool closed is gone once that read finished, not leaked.
    expect(h.live()).toBe(0);
    expect(h.pool.stats().size).toBe(0);
    await expect(h.pool.run({}, async () => 'after')).rejects.toThrow(/BRAUSER_HAVZASI_YOPILDI/);
    // Shutting down must not have started a process on the way out.
    expect(h.processes).toHaveLength(1);
  });
});

describe('the operator bounds themselves', () => {
  const KEYS = [
    'PRO_FETCH_BROWSER_POOL_SIZE',
    'PRO_FETCH_BROWSER_POOL_MAX_PAGES',
    'PRO_FETCH_BROWSER_POOL_IDLE_MS',
    'PRO_FETCH_BROWSER_POOL_WAIT_MS',
    'PRO_FETCH_MODE',
  ];

  it('clamps a size that would be a fork bomb, and falls back on a value that is not a number', () => {
    const previous: Record<string, string | undefined> = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
    try {
      delete process.env.PRO_FETCH_MODE;
      process.env.PRO_FETCH_BROWSER_POOL_SIZE = '1000';
      expect(poolSettings().size).toBe(8);
      // A typo degrades to the documented default instead of disabling the limit: `0` and `abc` are both
      // refusals to parse, and a pool with no ceiling is not what an unanswered question should produce.
      process.env.PRO_FETCH_BROWSER_POOL_SIZE = '0';
      expect(poolSettings().size).toBe(2);
      process.env.PRO_FETCH_BROWSER_POOL_SIZE = 'abc';
      expect(poolSettings().size).toBe(2);
      process.env.PRO_FETCH_BROWSER_POOL_MAX_PAGES = '-4';
      expect(poolSettings().maxPages).toBe(50);
      process.env.PRO_FETCH_BROWSER_POOL_IDLE_MS = '5';
      expect(poolSettings().idleMs).toBe(1_000);
      process.env.PRO_FETCH_BROWSER_POOL_WAIT_MS = 'not a number';
      expect(poolSettings().waitMs).toBe(30_000);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('holds the pool ceilings down in MAX mode, where throughput knobs are lifted', () => {
    const previous = { ...process.env };
    try {
      process.env.PRO_FETCH_MODE = 'max';
      process.env.PRO_FETCH_BROWSER_POOL_SIZE = '1000';
      // MAX mode raises how much work one process may do at once. It must not raise how many separate
      // processes a server may start: each is a browser worth hundreds of megabytes, and a thousand of them
      // is an out-of-memory crash with extra steps, not a faster render.
      expect(poolSettings().size).toBe(8);
      process.env.PRO_FETCH_BROWSER_POOL_MAX_PAGES = '100000';
      expect(poolSettings().maxPages).toBe(10_000);
    } finally {
      for (const key of KEYS) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key] as string;
      }
    }
  });
});
