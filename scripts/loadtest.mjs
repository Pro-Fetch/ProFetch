/**
 * Load test: what the reader does under a queue of real URLs.
 *
 * Run: `npm run bench:load -- --n 60` (options: `--concurrency 6`, `--escalate 1`, `--list file.txt`,
 * `--out reports/load.jsonl`)
 *
 * ## What it measures, and why these numbers and not others
 *
 * Latency percentiles per request, throughput, the split between HTTP and browser stages, refused hosts,
 * transport failure classes, and the pool's own accounting at the end (launches, reads, restarts, queue
 * waits). That last block is the reason this script exists: without it a pool is a story about speed, with
 * it a pool is a measurement.
 *
 * ## What it deliberately does not do
 *
 * It does not hammer one host. Every address is used once, so the load falls on the reader and the pool
 * rather than on somebody else's server — which is the difference between a benchmark and an attack. The
 * server's own per-host limiter is left switched on for the same reason.
 *
 * ## Honesty about the numbers
 *
 * Run them on the machine that will run the service. These are single-box figures with a shared network and
 * no proxy; on a datacenter IP the refusal rate is higher, and this script is how that difference gets
 * measured instead of argued about.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fetchUrl } from '../dist/core/fetcher.js';
import { browserPoolStats } from '../dist/core/browser-pool.js';
import { breakerReport, classifyFetchError } from '../dist/core/circuit-breaker.js';

function arg(name, fallback) {
  const at = process.argv.indexOf('--' + name);
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : fallback;
}

const N = Math.max(1, Math.min(500, Number(arg('n', 60)) || 60));
const WIDTH = Math.max(1, Math.min(16, Number(arg('concurrency', 6)) || 6));
const ESCALATE = arg('escalate', '0') === '1';
const LIST = arg('list', '');

async function readUrls() {
  if (LIST) {
    const raw = await readFile(path.resolve(LIST), 'utf8');
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .slice(0, N);
  }
  // A built-in list, one host per line, so the script runs out of the box. All different hosts: the point is
  // the reader's throughput, not pressure on any single site.
  const hosts = [
    'sqlite.org/lang_wal.html',
    'developer.mozilla.org/en-US/docs/Web/HTTP',
    'docs.python.org/3/library/json.html',
    'go.dev/doc/effective_go',
    'www.rfc-editor.org/rfc/rfc9110.html',
    'nodejs.org/api/fs.html',
    'peps.python.org/pep-0008/',
    'doc.rust-lang.org/book/ch01-00-introduction.html',
    'learn.opencv.org/master/',
    'homepage.nyp.jp/wiki/?English/Wikipedia',
    'git-scm.com/book/en/v2',
    'kotlinlang.org/docs/coroutines-overview.html',
    'www.sqlite.org/c3ref/open.html',
    'en.wikipedia.org/wiki/Model%E2%80%93view%E2%80%93controller',
    'commons.apache.org/proper/commons-cli/usage.html',
    'yaml.org/spec/1.2.2/',
    'react.dev/learn',
    'vuejs.org/guide/introduction.html',
    'svelte.dev/tutorial',
    'expressjs.com/en/guide/routing.html',
    'www.postgresql.org/docs/current/mvcc.html',
    'mariadb.com/kb/en/innodb-system-variables/',
    'redis.io/docs/latest/operate/data_structures/',
    'bun.sh/docs',
    'deno.land/manual',
    'www.typescriptlang.org/docs/handbook/2/everyday-types.html',
    'stackoverflow.com/documentation',
    'docs.github.com/en/actions',
    'developer.apple.com/documentation/uikit',
    'guide.freecodecamp.org/javascript/',
    'www.w3.org/TR/html52/',
    'angular.io/guide/architecture',
    'laravel.com/docs/11.x/routing',
    'symfony.com/doc/current/index.html',
    'docs.djangoproject.com/en/5.0/topics/db/queries/',
    'flask.palletsprojects.com/en/3.0.x/quickstart/',
    'www.nginx.com/resources/wiki/',
    'httpd.apache.org/docs/2.4/',
    'caddyserver.com/docs/getting-started',
    'tomcat.apache.org/tomcat-10.1-doc/index.html',
    'docs.ansible.com/ansible/latest/index.html',
    'kubernetes.io/docs/concepts/overview/',
    'docs.docker.com/engine/',
    'www.terraform.io/docs/language/index.html',
    'packer.io/docs',
    'consul.io/docs',
    'prometheus.io/docs/practices/naming/',
    'grafana.com/docs/grafana/latest/',
    'opentelemetry.io/docs/specs/semconv/',
    'envoyproxy.io/docs/envoy/latest/',
    'istio.io/latest/docs/',
    'www.vaultproject.io/docs',
  ];
  return hosts.map((host) => 'https://' + host).slice(0, N);
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

const urls = await readUrls();
const started = Date.now();
let i = 0;
const rows = [];
async function worker() {
  for (;;) {
    const idx = i++;
    if (idx >= urls.length) return;
    const url = urls[idx];
    const t0 = Date.now();
    try {
      const r = await fetchUrl(url, { escalate: ESCALATE, maxTokens: 4000, useCache: false });
      rows.push({
        url,
        ms: Date.now() - t0,
        status: r.status,
        method: r.method ?? 'http',
        blocked: r.blocked ? r.blocked.kind : null,
        tokens: r.tokens,
        resources_blocked: r.resources_blocked ?? 0,
        failure: null,
      });
    } catch (error) {
      rows.push({
        url,
        ms: Date.now() - t0,
        status: null,
        method: null,
        blocked: null,
        tokens: 0,
        resources_blocked: 0,
        failure: classifyFetchError(error),
      });
    }
  }
}
await Promise.all(Array.from({ length: Math.min(WIDTH, urls.length) }, worker));
const elapsed = Date.now() - started;

const ok = rows.filter((row) => row.failure === null);
const times = ok.map((row) => row.ms);
const summary = {
  urls: rows.length,
  concurrency: WIDTH,
  escalate: ESCALATE,
  wall_ms: elapsed,
  per_second: Math.round((rows.length / (elapsed / 1000)) * 100) / 100,
  answered: ok.filter((row) => row.status !== null && row.status < 400).length,
  refusals: ok.filter((row) => row.blocked !== null).length,
  http_stage: ok.filter((row) => row.method === 'http').length,
  browser_stage: ok.filter((row) => row.method === 'browser').length,
  resources_blocked_total: rows.reduce((total, row) => total + row.resources_blocked, 0),
  failures_by_class: Object.entries(
    rows
      .filter((row) => row.failure)
      .reduce((acc, row) => ({ ...acc, [row.failure]: (acc[row.failure] ?? 0) + 1 }), {}),
  ).sort((a, b) => b[1] - a[1]),
  ms_p50: percentile(times, 0.5),
  ms_p95: percentile(times, 0.95),
  ms_p99: percentile(times, 0.99),
  pool: browserPoolStats(),
  breakers: breakerReport(),
};

const outDir = path.resolve('reports');
await mkdir(outDir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
await writeFile(path.join(outDir, `load-${stamp}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
await writeFile(path.join(outDir, `load-${stamp}.summary.json`), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
