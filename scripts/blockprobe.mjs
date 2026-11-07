/**
 * Block probe: how many real sites answer us, and which refuse.
 *
 * Run: `npm run probe:block -- --n 500` (options: `--concurrency 8`, `--escalate 1`, `--compat 1`, `--list file.txt`)
 *
 * ## What this measures
 *
 * One request per host, to the homepage, with the user agent this server really sends. It records the status,
 * whether the block-page detector fired, how long the host took, and what came back. Two user agents are
 * compared because that is the cheapest variable with the biggest effect: a named bot UA and a browser UA
 * are not equally welcome on the modern web, and a hosted service priced without knowing the difference is
 * priced on a guess.
 *
 * ## What this does not do
 *
 * It does not go around a refusal. There is no proxy rotation, no CAPTCHA solving, no header spoofing
 * beyond the opt-in browser UA the server already supports, and one request per host. A site that says no is
 * counted as "said no" — that is the finding, not an obstacle.
 *
 * ## Why it stays in the repository
 *
 * The hosted pricing question ("what does a rendered page really cost, what share is blocked") cannot be
 * answered from a README or a memory. This script is how it gets answered with numbers, on the machine and
 * network that would actually run the service.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fetchUrl } from '../dist/core/fetcher.js';

function arg(name, fallback) {
  const at = process.argv.indexOf('--' + name);
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : fallback;
}

const N = Math.max(1, Math.min(2000, Number(arg('n', 500)) || 500));
const WIDTH = Math.max(1, Math.min(16, Number(arg('concurrency', 8)) || 8));
const ESCALATE = arg('escalate', '0') === '1';
const COMPAT = arg('compat', '0') === '1';
const LIST = arg('list', '');
if (LIST) process.env.PRO_FETCH_PROBE_LIST = LIST;
if (COMPAT) process.env.PRO_FETCH_HTTP_COMPAT_UA = '1';

/** Read the host list: one URL or hostname per line, `#` comments ignored, first host wins. */
async function readHosts() {
  const source = LIST
    ? await readFile(path.resolve(LIST), 'utf8')
    : await readFile(path.resolve('scripts/blockprobe.hosts.txt'), 'utf8');
  const seen = new Set();
  const hosts = [];
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // Tranco-style rows are `rank,domain`; plain lists are just the domain.
    const candidate = trimmed.includes(',') ? trimmed.split(',')[1].trim() : trimmed;
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    hosts.push(candidate);
    if (hosts.length >= N) break;
  }
  return hosts;
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

const hosts = await readHosts();
console.error(
  `[probe] ${hosts.length} host, concurrency ${WIDTH}, escalate ${ESCALATE ? 'on' : 'off'}, UA ${COMPAT ? 'browser (compat)' : 'pro-fetch default'}`,
);

let i = 0;
const rows = [];
async function worker() {
  for (;;) {
    const idx = i++;
    if (idx >= hosts.length) return;
    const host = hosts[idx];
    const url = 'https://' + host + '/';
    const started = Date.now();
    try {
      const r = await fetchUrl(url, { escalate: ESCALATE, maxTokens: 2000, useCache: false });
      rows.push({
        host,
        url,
        status: r.status,
        contentType: r.contentType,
        blocked: r.blocked ? r.blocked.kind + ':' + r.blocked.marker : null,
        method: r.method ?? 'http',
        tokens: r.tokens,
        ms: Date.now() - started,
        finalUrl: r.url,
        error: null,
      });
    } catch (error) {
      rows.push({
        host,
        url,
        status: null,
        contentType: null,
        blocked: null,
        method: null,
        tokens: 0,
        ms: Date.now() - started,
        finalUrl: null,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 160),
      });
    }
  }
}

await Promise.all(Array.from({ length: WIDTH }, worker));

const ok = rows.filter((row) => row.error === null);
const answered = ok.filter((row) => row.status !== null && row.status < 400);
const refused = ok.filter((row) => row.blocked !== null);
const httpErrors = ok.filter((row) => row.status !== null && row.status >= 400 && row.blocked === null);
const emptyish = ok.filter((row) => row.status !== null && row.status < 400 && row.tokens < 40);
const failures = rows.filter((row) => row.error !== null);
const times = ok.map((row) => row.ms);

const summary = {
  ua: COMPAT ? 'browser (PRO_FETCH_HTTP_COMPAT_UA)' : 'pro-fetch default',
  escalate: ESCALATE,
  hosts: rows.length,
  transport_failures: failures.length,
  http_errors: httpErrors.length,
  block_pages: refused.length,
  answered_ok: answered.length,
  near_empty: emptyish.length,
  answered_pct: rows.length ? Math.round((answered.length / rows.length) * 1000) / 10 : null,
  block_pct: rows.length ? Math.round((refused.length / rows.length) * 1000) / 10 : null,
  ms_p50: percentile(times, 0.5),
  ms_p95: percentile(times, 0.95),
  ms_max: times.length ? Math.max(...times) : null,
  by_status: Object.fromEntries(
    Object.entries(
      ok.reduce((acc, row) => {
        const key = String(row.status ?? 'none');
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {}),
    ).sort((a, b) => b[1] - a[1]),
  ),
  top_refusals: Object.entries(
    refused.reduce((acc, row) => {
      acc[row.blocked] = (acc[row.blocked] ?? 0) + 1;
      return acc;
    }, {}),
  )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12),
  transport_failure_reasons: Object.entries(
    failures.reduce((acc, row) => {
      const key = (row.error ?? '').split(/[:(]/)[0].trim().slice(0, 60);
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
  )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12),
};

const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const outDir = path.resolve('reports');
await mkdir(outDir, { recursive: true });
await writeFile(
  path.join(outDir, `blockprobe-${stamp}.jsonl`),
  rows.map((row) => JSON.stringify(row)).join('\n') + '\n',
);
await writeFile(path.join(outDir, `blockprobe-${stamp}.summary.json`), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
