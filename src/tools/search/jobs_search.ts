import { defineTool } from '../../core/tool.js';
import { fetchWithOptions } from '../../core/http-client.js';
import { SEARCH_TOOL_TIMEOUT_MS } from '../../core/search-engines.js';
import { result, fail } from '../../core/format.js';
import { USER_AGENT } from '../../core/version.js';
import { parseUpstreamJson } from '../../core/json-response.js';

/**
 * pro_fetch_jobs_search — Search remote job postings by role.
 *
 * Two providers, in a stated order. Remote OK is first because its records are richer, but it is a
 * bot-walled site: it answers an unknown client with a `302 → /` loop, and no header trickery is
 * worth trying against someone's bot protection. An HR persona driving the workflow hit exactly that
 * and could only return "0 results, blocked" — an honest answer, but a useless one.
 *
 * So a blocked primary falls back to Remotive's public JSON API and the answer says which provider
 * served it and why the switch happened. Silently swapping providers would be the failure here: a
 * different number of listings is a different dataset, not the same one fetched another way.
 */

/** One shaped result, so the caller does not care which provider answered. */
interface JobResult {
  id: string;
  title: string;
  company: string;
  location: string;
  url: string;
  postedAt: string;
  tags: string[];
}

interface RemoteOkRow {
  id?: string | number;
  position?: string;
  company?: string;
  location?: string;
  url?: string;
  date?: string;
  tags?: string[];
}

interface RemotiveRow {
  id?: string | number;
  title?: string;
  company_name?: string;
  location?: string;
  url?: string;
  publication_date?: string;
  category?: string;
  tags?: string[];
  job_type?: string;
}

/** Remotive rows into the shared shape. Exported because the mapping, not the network, is what breaks. */
export function mapRemotiveRows(payload: unknown, limit: number): JobResult[] {
  const jobs = Array.isArray(payload) ? payload : ((payload as { jobs?: unknown[] })?.jobs ?? []);
  return (jobs as RemotiveRow[])
    .filter((item) => Boolean(item?.title))
    .slice(0, limit)
    .map((item) => ({
      id: String(item.id ?? ''),
      title: String(item.title ?? ''),
      company: String(item.company_name ?? ''),
      location: String(item.location ?? ''),
      url: String(item.url ?? ''),
      postedAt: String(item.publication_date ?? ''),
      tags: [
        ...(item.tags ?? []),
        ...(item.category ? [item.category] : []),
        ...(item.job_type ? [item.job_type] : []),
      ],
    }));
}

function mapRemoteOkRows(payload: unknown, limit: number): JobResult[] {
  return (payload as RemoteOkRow[])
    .filter((item) => Boolean(item?.position))
    .slice(0, limit)
    .map((item) => ({
      id: String(item.id ?? ''),
      title: String(item.position ?? ''),
      company: String(item.company ?? ''),
      location: String(item.location ?? ''),
      url: String(item.url ?? ''),
      postedAt: String(item.date ?? ''),
      tags: item.tags ?? [],
    }));
}

async function fromRemoteOk(query: string, limit: number): Promise<{ results: JobResult[] }> {
  const url = new URL('https://remoteok.com/api');
  url.searchParams.set('tag', query);
  url.searchParams.set('limit', String(limit));
  const response = await fetchWithOptions(url.toString(), {
    timeoutMs: SEARCH_TOOL_TIMEOUT_MS,
    headers: { accept: 'application/json', 'user-agent': `${USER_AGENT} (+https://remoteok.com)` },
    maxBytes: 3_000_000,
  });
  if (response.status >= 400) throw new Error(`Remote OK HTTP ${response.status}`);
  const payload = parseUpstreamJson(response, 'Remote OK');
  return { results: mapRemoteOkRows(payload, limit) };
}

async function fromRemotive(query: string, limit: number): Promise<{ results: JobResult[] }> {
  const url = new URL('https://remotive.com/api/remote-jobs');
  url.searchParams.set('search', query);
  url.searchParams.set('limit', String(Math.max(10, limit)));
  const response = await fetchWithOptions(url.toString(), {
    timeoutMs: SEARCH_TOOL_TIMEOUT_MS,
    headers: { accept: 'application/json' },
    maxBytes: 3_000_000,
  });
  if (response.status >= 400) throw new Error(`Remotive HTTP ${response.status}`);
  return { results: mapRemotiveRows(parseUpstreamJson(response, 'Remotive'), limit) };
}

export default defineTool({
  name: 'pro_fetch_jobs_search',
  description:
    'Search remote job listings. Primary provider: Remote OK; if it is bot-blocking, the public Remotive API answers and the result says so.',
  category: 'search',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: "So'rov matni (rol nomi)" },
      limit: { type: 'number', description: 'Natijalar soni (1-25)' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async handler(input) {
    const p = input as Record<string, unknown>;
    const query = typeof p.query === 'string' ? p.query.trim() : '';
    if (!query) return fail('query kerak.');
    const limitValue = Number(p.limit ?? 10);
    const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(25, Math.floor(limitValue))) : 10;

    let provider = 'Remote OK';
    let fallbackReason: string | undefined;
    let results: JobResult[] = [];
    try {
      results = (await fromRemoteOk(query, limit)).results;
      if (results.length === 0) {
        // An empty Remote OK answer is either no such role or a soft block; only the second is worth
        // paying a second request for, so the fallback triggers on an error or on `position`-less JSON.
        fallbackReason = 'Remote OK bu so‘rovga bo‘sh ro‘yxat qaytardi';
      }
    } catch (error) {
      fallbackReason = `Remote OK javab bermadi: ${(error as Error).message}`;
    }

    if (fallbackReason) {
      provider = 'Remotive';
      try {
        results = (await fromRemotive(query, limit)).results;
      } catch (error) {
        // Both providers down is a failure, and it should read as one.
        return fail(`${fallbackReason}; Remotive ham yiqildi: ${(error as Error).message}`);
      }
    }

    return result(
      JSON.stringify(
        {
          provider,
          query,
          count: results.length,
          ...(fallbackReason ? { fallback_from: 'Remote OK', fallback_reason: fallbackReason } : {}),
          results,
        },
        null,
        2,
      ),
    );
  },
});
