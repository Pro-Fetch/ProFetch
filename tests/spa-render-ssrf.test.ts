import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import '../src/loader.js';
import { callTool } from '../src/router.js';
import { UrlSecurityError } from '../src/core/ssrf-guard.js';
import type { ToolResult } from '../src/core/types.js';

const text = (r: ToolResult): string =>
  (r.content ?? [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');

/**
 * `pro_fetch_spa_render` was the one browser path that did not go through the SSRF guard.
 *
 * It called `chromium.launch()` itself and handed the caller's URL straight to `page.goto()`, so
 * Chromium resolved and fetched whatever was asked: `http://169.254.169.254/latest/meta-data/`,
 * `http://127.0.0.1:6379/`, anything on the operator's internal network. Every other browser entry
 * point routes through `createSession`, which validates the navigation and serves sub-resources over
 * a pinned connection — the boundary was correct everywhere except at the one door nobody was
 * watching. The repository audit found it by reading the launch sites rather than the descriptions.
 *
 * These tests hold the door shut. They are offline by construction: the address is refused before a
 * browser is spawned, so nothing binds a socket and nothing depends on the machine's network.
 */
describe('spa_render cannot reach a private address', () => {
  it('refuses loopback and names the SSRF guard', async () => {
    const result = await callTool('pro_fetch_spa_render', { url: 'http://127.0.0.1:6379/' });
    expect(result.isError).toBeTruthy();
    expect(text(result)).toMatch(/SSRF|Ichki host|Ichki yoki maxsus IP/i);
  }, 30_000);

  it('refuses the cloud metadata address', async () => {
    const result = await callTool('pro_fetch_spa_render', { url: 'http://169.254.169.254/latest/meta-data/' });
    expect(result.isError).toBeTruthy();
    expect(text(result)).toMatch(/SSRF|Ichki yoki maxsus IP/i);
  }, 30_000);

  it('refuses a non-HTTP scheme instead of opening the local filesystem', async () => {
    const result = await callTool('pro_fetch_spa_render', { url: 'file:///etc/passwd' });
    expect(result.isError).toBeTruthy();
    expect(text(result)).toMatch(/protokol|protocol/i);
  }, 30_000);

  it('reports a blocked URL as a policy decision, not as a missing Playwright install', async () => {
    // The old wrapper caught everything and re-threw "check that Playwright is installed". A caller
    // told that would go reinstall a dependency that was never the problem.
    const result = await callTool('pro_fetch_spa_render', { url: 'http://localhost:8080/' });
    const body = text(result);
    expect(result.isError).toBeTruthy();
    expect(body).not.toMatch(/Playwright o'rnatilganini tekshiring/);
  }, 30_000);
});

describe('spa_render has no private launch path left', () => {
  const source = readFileSync('src/core/crawl-tools.ts', 'utf8');

  it('routes through the guarded session helper instead of launching its own browser', () => {
    expect(source).toContain('withGuardedPage');
    expect(source).not.toMatch(/chromium\.launch/);
  });

  it('keeps the guard type importable so the policy error survives wrapping', () => {
    // The wrapper distinguishes a refused URL from a missing dependency by error identity; if
    // `UrlSecurityError` stopped being exported, that branch would silently match nothing.
    expect(typeof UrlSecurityError).toBe('function');
    expect(new UrlSecurityError('x', 'SSRF_BLOCKED').code).toBe('SSRF_BLOCKED');
  });
});
