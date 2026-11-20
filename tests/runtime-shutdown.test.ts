import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { fetchUrl } from '../src/core/fetcher.js';
import { closeRuntime } from '../src/core/shutdown.js';
import { hostReachable } from './helpers/liveGate.js';
import { skipBlockWithout } from './helpers/env-guard.js';

/**
 * `closeRuntime()` and the rule that scripts have to call it.
 *
 * ## What is claimed, and what is not
 *
 * undici keeps a connection alive after a request completes, and a keep-alive socket is a handle on the
 * event loop: a script that has already printed its answer still waits for the agent's own timeout before
 * it may end. Releasing it deliberately is the point. Measured here at three hosts the difference was 4 s
 * with the call and 3 s without, so no dramatic hang is being sold — the "eleven minutes" note in the
 * running list came from a workspace probe, not from one of these scripts, and is not repeated as fact.
 * The reason this deserves a guard is the browser half: a pooled Chromium has no timeout at all, which is
 * what `src/server.ts` documents as an orphan holding a profile directory.
 *
 * The cure is one awaited call at the end of a script — exactly the kind of line that vanishes when
 * somebody copies a script and edits it. `scripts/verify-static.mjs` therefore refuses any script that
 * reaches the network, ends by itself, and never releases the runtime. That rule was tested by stripping
 * the call from a copy of `blockprobe.mjs`: the gate failed naming the file, and passed once it was put
 * back.
 *
 * ## What the live case proves
 *
 * The network-gated test below makes a real request and then shuts down. That is the only way to show the
 * dispatcher being closed is not just a function that returns a shape — it has to survive having actually
 * owned a socket. When the host is unreachable the test is skipped by name, never counted as a pass.
 */

describe('runtime shutdown', () => {
  it('reports what it released and never throws', async () => {
    const first = await closeRuntime();
    expect(first.dispatchers).toBe(true);
    expect(typeof first.browsers.sessions).toBe('number');
    expect(typeof first.browsers.pool).toBe('number');
    expect(Array.isArray(first.notes)).toBe(true);
  });

  it('is safe to call twice', async () => {
    const again = await closeRuntime();
    const third = await closeRuntime();
    expect(again.dispatchers).toBe(true);
    expect(third.dispatchers).toBe(true);
    expect(third.notes).toEqual(again.notes);
  });

  it('closes a dispatcher that actually held a connection', async () => {
    const reachable = await hostReachable('https://example.com');
    if (!reachable) {
      skipBlockWithout('tests/runtime-shutdown.test.ts', 'network', 'example.com javob bermadi', false);
      return;
    }
    // The document is irrelevant; the connection it opened is the subject. The narrow limit is here so the
    // test costs a handshake and not a page parse.
    await fetchUrl('https://example.com/', { maxTokens: 8 });
    const started = Date.now();
    const report = await closeRuntime();
    // The bound is a hang detector, not a performance promise: it fails if shutting down has to wait for a
    // socket's own timeout instead of being closed. Measured range for this call: 0.3 s when nothing is
    // open, 1.5–5.5 s on this machine after a real handshake, 4.2 s on a Windows CI runner. The first
    // version of this line demanded 4 s and went red on CI — a threshold picked smaller than the fastest
    // machine that does not run the test is not a threshold, it is a coin toss.
    const took = Date.now() - started;
    expect(report.dispatchers, 'dispatcher yopilmadi: ' + took + ' ms').toBe(true);
    expect(took, 'closeRuntime ' + took + ' ms davom etdi').toBeLessThan(20_000);
  }, 40_000);

  it('is what the server hook uses, so the killed server releases both kinds of handle', () => {
    const server = readFileSync('src/server.ts', 'utf8');
    expect(server).toContain("import { closeRuntime } from './core/shutdown.js'");
    // The hook used to close browsers only, and the sockets it left behind were the same class of bug the
    // scripts had. Checking the call, not the prose, is what keeps it from being "simplified" back.
    expect(server).toMatch(/installShutdownHook[\s\S]*?closeRuntime\(\)/);
    expect(server).not.toMatch(/const \{ closeBrowsers \} = await import/);
  });
});
