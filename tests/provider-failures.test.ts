import { describe, it, expect } from 'vitest';
import '../src/loader.js';
import { dispatch } from '../src/core/tool.js';
import type { ToolResult } from '../src/core/types.js';
import { hostReachable } from './helpers/liveGate.js';

const text = (r: ToolResult): string =>
  (r.content ?? [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');

/**
 * Failures the credential matrix surfaced against live providers.
 *
 * Each of these looked like a broken tool until the argument or the upstream was examined: a
 * redirect loop that reported a hop count, and a missing identifier that reported a 404. Both now
 * say what actually happened.
 */
// Reachability is probed once per host. A 403 from GitHub, or a portal that answers with HTML, is
// the product behaviour these tests exist to pin; not reaching the host at all is not.
const githubReachable = await hostReachable('https://api.github.com/zen');
const webReachable = await hostReachable('https://example.com/');

describe.skipIf(!webReachable)('redirect loops name the loop', () => {
  it('reports bot protection instead of a hop count, then falls back honestly', async () => {
    // remoteok.com answers an unknown user-agent with `302 /` from `/` itself, forever. The old
    // message — `HTTP redirect limit exceeded (5)` — sent the caller counting redirects. There is a
    // second provider now, so the answer must still name the loop and say which provider served it.
    const result = await dispatch('pro_fetch_jobs_search', { query: 'nodejs', limit: 3 });
    // A successful tool result leaves `isError` undefined, not false.
    expect(result.isError, text(result)).not.toBe(true);
    const body = text(result);
    // Which provider answers depends on whether Remote OK is blocking right now, so the contract is
    // asserted, not today's network: the data came from one of the two, and if it came from the second
    // one the reason says it was a redirect loop at remoteok.com, never a hop count.
    expect(body).toMatch(/"provider": "(Remote OK|Remotive)"/);
    expect(body).not.toMatch(/limit exceeded/);
    if (body.includes('"provider": "Remotive"')) {
      expect(body).toMatch(/redirect loop/i);
      expect(body).toMatch(/remoteok\.com/);
      expect(body).toContain('"fallback_from": "Remote OK"');
    }
  }, 30_000);
});

describe.skipIf(!githubReachable)('a repository without `main` still downloads', () => {
  it('falls back to `master` when no ref was requested', async () => {
    // octocat/Hello-World defaults to `master`. Asking for `main` only used to fail it with a 404
    // that read as "repository not found".
    const result = await dispatch('pro_gh_repo_full_clone', { owner: 'octocat', repo: 'Hello-World' });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toMatch(/\(master\)/);
  }, 90_000);

  it('names the tried branches instead of reporting a bare 404', async () => {
    const result = await dispatch('pro_gh_repo_full_clone', { owner: 'nodejs', repo: 'no-such-repo-xyz' });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/sinab ko‘rildi/);
    expect(text(result)).not.toMatch(/Download HTTP 404/);
  }, 90_000);

  it('honours an explicit ref exactly and does not retry it', async () => {
    const result = await dispatch('pro_gh_repo_full_clone', { owner: 'nodejs', repo: 'node', ref: 'nope' });
    expect(result.isError).toBe(true);
    // Only the requested ref was tried — the fallback applies to the default, not to an override.
    expect(text(result)).toMatch(/nope/);
    expect(text(result)).not.toMatch(/master/);
  }, 90_000);
});

describe('a missing identifier fails before the network', () => {
  it('gist_read names gist_id instead of reporting a 404', async () => {
    // Without the guard the call went out as `/gists/undefined` and came back 404, which reads as
    // "gist not found" when the truth is "no gist was named".
    for (const args of [{}, { gist_id: '' }, { gist_id: '   ' }]) {
      const result = await dispatch('pro_gh_gist_read', args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(text(result), JSON.stringify(args)).toMatch(/gist_id/);
    }
  });
});
