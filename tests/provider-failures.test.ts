import { describe, it, expect } from 'vitest';
import '../src/loader.js';
import { dispatch } from '../src/core/tool.js';
import type { ToolResult } from '../src/core/types.js';
import { hostReachable, skipIfUnreachable } from './helpers/liveGate.js';

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
// Each probe names the host its suite actually talks to. A run once resolved `api.github.com` and then
// failed on `codeload.github.com`, which is where a clone is downloaded from — one host answering is
// not evidence that another will.
const githubReachable =
  (await hostReachable('https://api.github.com/zen')) && (await hostReachable('https://codeload.github.com/'));
const webReachable = await hostReachable('https://example.com/');

describe.skipIf(!webReachable)('a provider switch is always explained', () => {
  it('names the provider that answered and never reduces a block to a hop count', async (ctx) => {
    // remoteok.com answered an unknown client with `302 /` from `/` itself for a long time, and the
    // old message — `HTTP redirect limit exceeded (5)` — sent the caller counting redirects. It now
    // answers with JSON that carries no `position` rows for a tag query, which is a different reason
    // to fall back and a different reason to report. Either way the answer names its source.
    const result = await dispatch('pro_fetch_jobs_search', { query: 'nodejs', limit: 3 });
    // A successful tool result leaves `isError` undefined, not false.
    if (skipIfUnreachable(ctx.skip, text(result), 'remoteok.com / remotive.com unreachable')) return;
    expect(result.isError, text(result)).not.toBe(true);
    const body = text(result);
    // Which provider answers depends on what Remote OK is doing right now — it has answered this query
    // with a `302` loop and with an empty listing, and both are legitimate reasons to fall back. The
    // contract is therefore about the *shape* of the answer, not about today's upstream mood: name the
    // provider that served it, and if a switch happened, say where from and why. What must never
    // appear again is the hop count that used to stand in for an explanation.
    expect(body).toMatch(/"provider": "(Remote OK|Remotive)"/);
    expect(body).not.toMatch(/limit exceeded/);
    if (body.includes('"provider": "Remotive"')) {
      expect(body).toContain('"fallback_from": "Remote OK"');
      expect(body).toMatch(/"fallback_reason": ".*Remote OK/);
      expect(body).toMatch(/remoteok|Remote OK/);
    }
  }, 30_000);
});

describe.skipIf(!githubReachable)('a repository without `main` still downloads', () => {
  it('falls back to `master` when no ref was requested', async (ctx) => {
    // octocat/Hello-World defaults to `master`. Asking for `main` only used to fail it with a 404
    // that read as "repository not found".
    const result = await dispatch('pro_gh_repo_full_clone', { owner: 'octocat', repo: 'Hello-World' });
    if (skipIfUnreachable(ctx.skip, text(result), 'codeload.github.com unreachable')) return;
    expect(result.isError).toBeFalsy();
    expect(text(result)).toMatch(/\(master\)/);
  }, 90_000);

  it('names the tried branches instead of reporting a bare 404', async (ctx) => {
    const result = await dispatch('pro_gh_repo_full_clone', { owner: 'nodejs', repo: 'no-such-repo-xyz' });
    if (skipIfUnreachable(ctx.skip, text(result), 'codeload.github.com unreachable')) return;
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/sinab ko‘rildi/);
    expect(text(result)).not.toMatch(/Download HTTP 404/);
  }, 90_000);

  it('honours an explicit ref exactly and does not retry it', async (ctx) => {
    const result = await dispatch('pro_gh_repo_full_clone', { owner: 'nodejs', repo: 'node', ref: 'nope' });
    // Without this line the case passed on a DNS error, because a network message happens to contain the
    // word `nope` and not the word `master`. An assertion a network outage satisfies is not an assertion.
    if (skipIfUnreachable(ctx.skip, text(result), 'codeload.github.com unreachable')) return;
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
