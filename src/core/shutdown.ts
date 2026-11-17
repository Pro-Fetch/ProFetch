/**
 * Release everything that can keep a finished process alive, in the one order that works.
 *
 * ## Why browsers before sockets
 *
 * A browser pool holds a Chromium with a profile directory on purpose — that is the whole saving of
 * reusing it — and a profile lock is something another process will ask for. Closing it first means a
 * killed server does not leave an orphan holding a directory its successor cannot open. The HTTP pool has
 * no such contention, and closing it second costs nothing.
 *
 * ## Why the sockets are released rather than left to expire
 *
 * undici keeps a connection alive after a request completes, and a keep-alive socket is a handle on the
 * event loop: a script that printed its answer still waits for the agent's own timeout before the process
 * is allowed to end. Measured here at three hosts, the difference was small — 4 s with this call, 3 s
 * without — so no dramatic hang is being claimed. The browser half is where it matters: a pooled Chromium
 * has no timeout at all, and `src/server.ts` documents the orphan it leaves when a killed server does not
 * release it. One call covers both, which is why scripts and the signal hook use the same function instead
 * of each inventing a version of "finished".
 *
 * ## Why nothing here throws
 *
 * A shutdown path that can fail is a shutdown path that gets skipped, and a skipped shutdown is the bug
 * this module exists to prevent. Every failure is collected into `notes` and returned.
 */
import { closeAllDispatchers } from './http-client.js';

export interface ShutdownReport {
  /** Browser sessions and pool entries that were closed. Zero when Playwright is not installed. */
  browsers: { sessions: number; pool: number };
  /** Whether the pooled HTTP agents were released. */
  dispatchers: boolean;
  notes: string[];
}

/**
 * Close browsers, then pooled HTTP agents. Safe to call more than once, and never rejects.
 *
 * `browser-tools.js` is imported lazily: Playwright is an optional dependency, and a runtime shutdown
 * must not become a reason to require it.
 *
 * Scripts must call this themselves at the end. It deliberately does not call `process.exit`: a script
 * that still has work queued should finish it, and the only thing being released here is the handles that
 * would otherwise keep the loop alive forever.
 */
export async function closeRuntime(): Promise<ShutdownReport> {
  const report: ShutdownReport = { browsers: { sessions: 0, pool: 0 }, dispatchers: false, notes: [] };

  try {
    const { closeBrowsers } = await import('./browser-tools.js');
    const closed = await closeBrowsers();
    report.browsers = { sessions: closed.sessions, pool: closed.pool };
  } catch (error) {
    // A browser that will not close is not a reason to abandon the rest of the shutdown.
    report.notes.push('browser jarayonlari to‘liq yopilmadi: ' + reason(error));
  }

  try {
    await closeAllDispatchers();
    report.dispatchers = true;
  } catch (error) {
    report.notes.push('HTTP pool yopilmadi: ' + reason(error));
  }

  return report;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
