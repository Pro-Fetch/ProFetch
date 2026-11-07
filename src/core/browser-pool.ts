/**
 * A bounded pool of browser processes for one-off guarded reads.
 *
 * ## Why this exists
 *
 * Launching Chromium costs about a second and several hundred megabytes. The three callers that need a page
 * drawn by scripts — the HTTP→browser escalation in `fetchUrl`, `pro_fetch_spa_render`, and the crawl
 * renderer — each used to launch a browser, read one page and close it. One page was therefore worth one
 * process, and a run of shell pages paid the launch price every single time: measured on this machine, the
 * first rendered read took 2229 ms, of which almost all was startup.
 *
 * ## What is reused and what is deliberately not
 *
 * The **browser process** is reused. The **context is not**: every read gets a fresh context, which is what
 * keeps cookies, localStorage and service-worker state from travelling between two unrelated sites. A pool
 * that handed site B the session site A left behind would be a cross-site leak built for the sake of a
 * millisecond, and this file exists for the wrong reason if it ever did that. Contexts are cheap next to
 * processes; the launch is what this pool saves.
 *
 * Three bounds keep the pool from becoming the thing that eats the machine: a size cap, a page count after
 * which a process is thrown away (Chromium grows as it works, and a restart is cheaper than debugging an
 * out of memory runner), and an idle sweep for processes nobody has touched lately. All three are operator
 * settings, all three are clamped, and the sweep runs on acquisition rather than on a timer — a timer would
 * keep a process that is meant to be finishing alive by itself.
 *
 * A slot is measured with a count of reads in flight, not a busy flag, because two callers can legitimately
 * share one process (each in its own context). A boolean would have let the first one to finish mark the
 * process free, and the idle sweep would then close a browser out from under a read still using it.
 *
 * ## Reporting
 *
 * `stats()` is the observable half: launches, restarts, sweeps, queue waits and the page count of the
 * liveliest process. A pool without those numbers is a claim about performance, and this repository does
 * not ship claims.
 */

import type { Browser, Page } from 'playwright';
import { boundedEnv } from './bounded-env.js';

/** One reusable process plus the bookkeeping that decides when it is thrown away. */
interface Slot {
  browser: Browser;
  /** Reads this process has ever served. Past `maxPages` the slot is retired. */
  pages: number;
  /** Reads inside it right now. A slot with any read in flight is never swept or closed. */
  inflight: number;
  /** Last moment a read finished in it, for the idle sweep. */
  idleSince: number;
}

interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export interface PoolStats {
  /** Live processes, in use or idle. */
  size: number;
  /** Processes with at least one read in flight. */
  busy: number;
  /** Reads in flight altogether — one process can carry several. */
  inflight: number;
  /** Configured ceiling, after clamping. */
  limit: number;
  launches: number;
  /** Retirements made because of the page count. */
  restarts: number;
  swept_idle: number;
  /** Calls that had to wait because every process was at full tilt. */
  waited: number;
  wait_ms_max: number;
  wait_ms_total: number;
  reads: number;
  /** Reads served by the liveliest process ever held. */
  max_pages_per_process: number;
  /** Refusals because the queue deadline passed. */
  queue_timeouts: number;
  launch_ms_total: number;
  /** Callers waiting right now. */
  queued: number;
}

export interface PoolSettings {
  size: number;
  maxPages: number;
  idleMs: number;
  waitMs: number;
}

/**
 * Operator bounds. Each is clamped: a pool size of 5000 is a fork bomb with a config file, and a page
 * ceiling of 0 would retire every process before it served anything.
 */
export function poolSettings(): PoolSettings {
  return {
    size: boundedEnv('PRO_FETCH_BROWSER_POOL_SIZE', 2, 1, 8),
    maxPages: boundedEnv('PRO_FETCH_BROWSER_POOL_MAX_PAGES', 50, 1, 10_000),
    idleMs: boundedEnv('PRO_FETCH_BROWSER_POOL_IDLE_MS', 60_000, 1_000, 3_600_000),
    waitMs: boundedEnv('PRO_FETCH_BROWSER_POOL_WAIT_MS', 30_000, 0, 600_000),
  };
}

const emptyStats = (): PoolStats => ({
  size: 0,
  busy: 0,
  inflight: 0,
  limit: 0,
  launches: 0,
  restarts: 0,
  swept_idle: 0,
  waited: 0,
  wait_ms_max: 0,
  wait_ms_total: 0,
  reads: 0,
  max_pages_per_process: 0,
  queue_timeouts: 0,
  launch_ms_total: 0,
  queued: 0,
});

export interface PoolDeps {
  /** Start one browser process. */
  create: () => Promise<Browser>;
  /** Take one page out of a process in a context that belongs to nobody else, and dispose both. */
  withPage: <T>(browser: Browser, input: unknown, fn: (page: Page) => Promise<T>) => Promise<T>;
  settings?: () => PoolSettings;
  now?: () => number;
}

export class BrowserPool {
  private slots: Slot[] = [];
  private queue: Waiter[] = [];
  private counters = emptyStats();
  /** Set by `close()`: no new acquisition is promised, and a read that finishes releases its own process. */
  private draining = false;
  /** Serialises process creation so two simultaneous misses cannot both launch while one slot fits. */
  private building: Promise<Slot> | null = null;

  constructor(private deps: PoolDeps) {}

  private get config(): PoolSettings {
    return this.deps.settings ? this.deps.settings() : poolSettings();
  }

  private nowValue(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** A free process, oldest-read first. One read at a time per process — that is what makes the size cap honest. */
  private findIdle(): Slot | undefined {
    const candidates = this.slots.filter((slot) => slot.inflight === 0);
    candidates.sort((a, b) => a.idleSince - b.idleSince);
    return candidates[0];
  }

  /**
   * Retire idle processes. Called on every acquisition rather than from a timer, so a pool that is not being
   * used is not being kept alive by its own housekeeping.
   */
  async sweep(now = this.nowValue()): Promise<number> {
    const { idleMs } = this.config;
    const doomed = this.slots.filter((slot) => slot.inflight === 0 && now - slot.idleSince >= idleMs);
    for (const slot of doomed) await this.retire(slot, 'idle');
    return doomed.length;
  }

  private async retire(slot: Slot, reason: 'idle' | 'pages'): Promise<void> {
    const at = this.slots.indexOf(slot);
    if (at >= 0) this.slots.splice(at, 1);
    if (reason === 'idle') this.counters.swept_idle++;
    else this.counters.restarts++;
    await this.closeSlot(slot);
    this.handToQueue();
  }

  private async closeSlot(slot: Slot): Promise<void> {
    try {
      await slot.browser.close();
    } catch {
      // A browser that will not close is not a reason to fail the read that already finished. The slot has
      // already left the pool, so nothing can inherit it; the operating system gets the process on exit.
    }
  }

  /** Wake a waiting caller when a process is free or the cap has room; it re-checks everything itself. */
  private handToQueue(): void {
    if (this.queue.length === 0) return;
    if (!this.canAcceptWork()) return;
    const waiter = this.queue.shift();
    if (!waiter) return;
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.resolve();
  }

  /** Room means a free process or a slot still under the size cap — and never while shutting down. */
  private canAcceptWork(): boolean {
    if (this.draining) return false;
    return this.slots.some((slot) => slot.inflight === 0) || this.slots.length < this.config.size;
  }

  /**
   * Serve one read. `fn` receives a page inside a context created for it alone.
   *
   * The accounting is deliberately outside the policy: this method does not know what a guarded context is,
   * which is why the same numbers can be tested against a fake process in under a second.
   */
  async run<T>(input: unknown, fn: (page: Page) => Promise<T>): Promise<T> {
    const { slot, waited } = await this.acquire();
    if (waited > 0) {
      this.counters.wait_ms_total += waited;
      if (waited > this.counters.wait_ms_max) this.counters.wait_ms_max = waited;
    }
    try {
      return await this.deps.withPage(slot.browser, input, fn);
    } finally {
      slot.inflight--;
      slot.idleSince = this.nowValue();
      // The pool may have been closed while this read was running: `close` refuses to pull a browser out
      // from under a read in flight, so the process that was allowed to finish is the one that must go now.
      // Written as a chain rather than as an early `return`, because a return inside `finally` replaces the
      // completion value of the `try` — it would hand the caller `undefined` instead of the document, and
      // swallow the error of a read that failed.
      if (this.draining) await this.closeSlot(slot);
      else if (slot.pages >= this.config.maxPages && slot.inflight === 0) await this.retire(slot, 'pages');
      // A process that has read enough is retired rather than nursed: Chromium keeps memory it has taken,
      // and an afternoon of crawling on one process is how a runner dies.
      else this.handToQueue();
    }
  }

  /**
   * A process to read in, claimed before this returns.
   *
   * The claim happens here rather than at the call site for two reasons. An `await` between resolving and
   * marking busy would let a second caller pick the same free process, so a slot is out of circulation the
   * moment it is handed over. And the slot that came free may be at its page ceiling — retiring it and
   * launching is then the only correct move, while launching past the size cap would not be a move at all but
   * a leak with a config file.
   */
  private async acquire(): Promise<{ slot: Slot; waited: number }> {
    const started = this.nowValue();
    for (;;) {
      if (this.draining) throw new Error('BRAUSER_HAVZASI_YOPILDI: server to‘xtayapti, yangi brauzer ochilmaydi.');
      await this.sweep(started);
      const idle = this.findIdle();
      if (idle) {
        if (idle.pages >= this.config.maxPages) {
          // Outlived its page ceiling while nobody was looking; retire it rather than reading a fifty-first
          // page into a process that was meant to be thrown away.
          await this.retire(idle, 'pages');
          continue;
        }
        idle.inflight++;
        idle.pages++;
        this.countedRead(idle);
        return { slot: idle, waited: this.nowValue() - started };
      }
      if (this.slots.length < this.config.size) {
        // Somebody else is already starting a process for this same gap: wait for it and look again, rather
        // than claiming the process it is about to hand back a second time.
        if (this.building) {
          await this.building.catch(() => {});
          continue;
        }
        const fresh = await this.launch();
        fresh.inflight++;
        fresh.pages++;
        this.countedRead(fresh);
        return { slot: fresh, waited: this.nowValue() - started };
      }
      await this.waitForCapacity();
    }
  }

  private countedRead(slot: Slot): void {
    this.counters.reads++;
    if (slot.pages > this.counters.max_pages_per_process) this.counters.max_pages_per_process = slot.pages;
  }

  /** Park on the queue until something frees up, or refuse by name when the operator's deadline passes. */
  private waitForCapacity(): Promise<void> {
    const { waitMs } = this.config;
    this.counters.waited++;
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      if (waitMs > 0) {
        waiter.timer = setTimeout(() => {
          const at = this.queue.indexOf(waiter);
          if (at >= 0) this.queue.splice(at, 1);
          this.counters.queue_timeouts++;
          reject(
            new Error(
              `BRAUSER_HAVZASI_TOYIB: ${this.config.size} jarayon band va ${waitMs} ms bo‘shini kutildi. ` +
                `PRO_FETCH_BROWSER_POOL_SIZE ni oshiring yoki PRO_FETCH_BROWSER_POOL_WAIT_MS ni uzaytiring.`,
            ),
          );
        }, waitMs);
        // A deadline must not be the reason a process that is otherwise finished stays alive.
        waiter.timer.unref?.();
      }
      this.queue.push(waiter);
      // Whatever made this caller wait may already have freed up between the check and the queueing.
      this.handToQueue();
    });
  }

  private async launch(): Promise<Slot> {
    // The acquire loop cannot be the only guard: every `await` on the way here can hand control to `close()`,
    // and a pool that has been emptied then looks like a pool with room.
    if (this.draining) throw new Error('BRAUSER_HAVZASI_YOPILDI: server to‘xtayapti, yangi brauzer ochilmaydi.');
    // Two simultaneous misses must not both start a process when the pool has room for one.
    if (this.building) return this.building;
    const started = this.nowValue();
    this.building = (async () => {
      const browser = await this.deps.create();
      this.counters.launches++;
      this.counters.launch_ms_total += this.nowValue() - started;
      const slot: Slot = { browser, pages: 0, inflight: 0, idleSince: this.nowValue() };
      this.slots.push(slot);
      return slot;
    })().finally(() => {
      this.building = null;
    });
    return this.building;
  }

  stats(): PoolStats {
    return {
      ...this.counters,
      size: this.slots.length,
      busy: this.slots.filter((slot) => slot.inflight > 0).length,
      inflight: this.slots.reduce((total, slot) => total + slot.inflight, 0),
      limit: this.config.size,
      queued: this.queue.length,
    };
  }

  /** Every process this pool owns, for a clean shutdown. Waiting callers are refused, not left hanging. */
  async close(): Promise<void> {
    this.draining = true;
    const held = this.slots.slice();
    this.slots = [];
    const waiting = this.queue.splice(0);
    for (const waiter of waiting) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(new Error('BRAUSER_HAVZASI_YOPILDI: server to‘xtayotgani uchun navbat bekor qilindi.'));
    }
    for (const slot of held) {
      if (slot.inflight > 0) {
        // A read in flight is allowed to finish; closing its browser underneath it would turn a shutdown
        // into a reported failure of somebody's document. The process goes when the read returns itself.
        slot.idleSince = 0;
        continue;
      }
      await this.closeSlot(slot);
    }
  }
}

/**
 * The process-wide pool.
 *
 * Both halves arrive through a lazy import of `browser-tools.js`, which is what keeps Playwright off the
 * module graph of every path that merely *might* render: a server that never escalates to a browser never
 * loads it, and the pool costs nothing until a shell is actually found.
 */
let defaultPool: BrowserPool | null = null;

export function browserPool(): BrowserPool {
  if (defaultPool) return defaultPool;
  defaultPool = new BrowserPool({
    create: async () => {
      const { launchGuardedBrowser } = await import('./browser-tools.js');
      return launchGuardedBrowser();
    },
    withPage: async <T>(browser: Browser, input: unknown, fn: (page: Page) => Promise<T>): Promise<T> => {
      const { withFreshContext } = await import('./browser-tools.js');
      return withFreshContext(browser, input as Record<string, unknown>, fn);
    },
  });
  return defaultPool;
}

/** Statistics of the pool that exists, or zeroes if no browser was ever needed. */
export function browserPoolStats(): PoolStats {
  return defaultPool ? defaultPool.stats() : emptyStats();
}

export async function closeBrowserPool(): Promise<void> {
  const pool = defaultPool;
  defaultPool = null;
  if (pool) await pool.close();
}
