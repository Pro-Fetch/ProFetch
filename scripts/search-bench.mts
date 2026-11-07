/**
 * The search benchmark: the same corpus, run engine against engine.
 *
 * Run: `npm run bench:search`  (options: `-- --engine brave`, `-- --k 5`)
 * The comparison against our own index is `npm run bench:own`, in a separate process on purpose: loading
 * the SQLite addon in the same isolate as this many TLS handshakes aborts Node 24 inside
 * `RemoveEnvironmentCleanupHook` — measured here twice, and the isolation is the fix, not a workaround.
 *
 * ## What this measures, and what it does not
 *
 * Each query has one gold publisher — the body that writes the specification or the reference the question
 * is about. `hit@k` asks whether that publisher appears in the first k results; MRR how far down it was.
 * That is a retrieval measure over nineteen canonical documents. It is not human judgement about relevance
 * and does not pretend to be, and three limits are printed with the numbers rather than buried:
 *
 * - nineteen queries is a signal, not a vendor ranking. A difference of one or two hits is noise;
 * - `kind` is printed per row, because scoring `itunes` at 0.00 on RFC queries says nothing about iTunes
 *   search — it says an app-store index does not host specifications. Comparing a vertical index to a
 *   general one is the mistake this column exists to prevent;
 * - `gold_unreachable` lists queries whose expected page stopped answering. The corpus decays, and a
 *   benchmark that cannot notice is measuring a snapshot of a dead web.
 *
 * Engines that need a key are skipped and named when the key is absent, so every report states which
 * comparison was actually made on this machine.
 */

import process from 'node:process';

process.env.PRO_FETCH_PROFILE = 'full';
const base = new URL('../src/', import.meta.url).href;
await import(base + 'env.js');
await import(base + 'loader.js');
const { callTool } = await import(base + 'router.js');
const { SEARCH_ENGINES } = await import(base + 'core/search-engines.js');
const { SEARCH_CORPUS } = await import(new URL('../tests/fixtures/searchCorpus.js', import.meta.url).href);

const args = process.argv.slice(2);
function flag(name: string, fallback: string): string {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
const K = Math.max(1, Number(flag('k', '5')) || 5);
const forced = flag('engine', '').trim();

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function percentile(values: number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

/** The gold page has to still exist, or the query measures nothing. */
async function goldReachable(entry: (typeof SEARCH_CORPUS)[number]): Promise<boolean> {
  for (const host of entry.expected_hosts) {
    try {
      const response = await fetch(`https://${host}/`, {
        method: 'HEAD',
        redirect: 'follow',
        signal: AbortSignal.timeout(8000),
        headers: { 'user-agent': 'pro-fetch-mcp/1.0.0 (MCP server; benchmark corpus check)' },
      });
      if (response.status < 500) return true;
    } catch {
      /* try the next host */
    }
  }
  return false;
}

interface Row {
  engine: string;
  kind: string;
  queries: number;
  hit1: number;
  hitK: number;
  hit10: number;
  mrr: number;
  precisionK: number;
  p50: number;
  p95: number;
  failures: Record<string, number>;
}

const usable = forced
  ? SEARCH_ENGINES.filter((engine) => engine.id === forced)
  : SEARCH_ENGINES.filter((engine) => engine.configured());
const skippedEngines = forced ? [] : SEARCH_ENGINES.filter((engine) => !engine.configured()).map((engine) => engine.id);

if (forced && usable.length === 0) {
  console.error(`Noma'lum yoki sozlanmagan engine: ${forced}`);
  process.exit(1);
}

const dead: string[] = [];
for (const entry of SEARCH_CORPUS) if (!(await goldReachable(entry))) dead.push(entry.query);
const corpus = SEARCH_CORPUS.filter((entry) => !dead.includes(entry.query));

const rows: Row[] = [];
for (const engine of usable) {
  const hits1: number[] = [];
  const hitsK: number[] = [];
  const hits10: number[] = [];
  const reciprocals: number[] = [];
  const precisions: number[] = [];
  const times: number[] = [];
  const failures: Record<string, number> = {};

  for (const entry of corpus) {
    const started = performance.now();
    const result = await callTool('pro_fetch_web_search', {
      query: entry.query,
      engine: engine.id,
      limit: Math.max(K, 10),
    });
    times.push(Math.round(performance.now() - started));

    const text = (result.content ?? []).map((item: { text?: string }) => item.text ?? '').join('\n');
    if (result.isError) {
      const reason =
        /(rate_limited|authorization_failed|payment_required|unreachable|unavailable|empty_answer|budget_exceeded|endpoint_moved)/.exec(
          text,
        )?.[1] ?? 'other';
      failures[reason] = (failures[reason] ?? 0) + 1;
      hits1.push(0);
      hitsK.push(0);
      hits10.push(0);
      reciprocals.push(0);
      precisions.push(0);
      continue;
    }

    const body = JSON.parse(/(\{[\s\S]*\})/.exec(text)![1]) as { results?: Array<{ url?: string }> };
    const urls = (body.results ?? []).map((item) => item.url ?? '');
    const rank = urls.findIndex((url) => entry.expected_hosts.includes(hostOf(url)));
    hits1.push(rank === 0 ? 1 : 0);
    hitsK.push(rank >= 0 && rank < K ? 1 : 0);
    hits10.push(rank >= 0 && rank < 10 ? 1 : 0);
    reciprocals.push(rank >= 0 && rank < 10 ? 1 / (rank + 1) : 0);
    const top = urls.slice(0, K);
    const onGold = top.filter((url) => entry.expected_hosts.includes(hostOf(url))).length;
    precisions.push(top.length ? onGold / top.length : 0);
  }

  const mean = (values: number[]): number => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
  rows.push({
    engine: engine.id,
    kind: engine.kind,
    queries: corpus.length,
    hit1: mean(hits1),
    hitK: mean(hitsK),
    hit10: mean(hits10),
    mrr: mean(reciprocals),
    precisionK: mean(precisions),
    p50: percentile(times, 0.5),
    p95: percentile(times, 0.95),
    failures,
  });
}

const title =
  'engine'.padEnd(12) +
  'kind'.padEnd(11) +
  'n'.padStart(3) +
  'hit@1'.padStart(7) +
  `hit@${K}`.padStart(7) +
  'hit@10'.padStart(7) +
  'MRR'.padStart(7) +
  `prec@${K}`.padStart(8) +
  'p50ms'.padStart(7) +
  'p95ms'.padStart(8) +
  '  failures';

console.log(`# search benchmark — ${corpus.length} queries, k=${K}, ${new Date().toISOString().slice(0, 10)}`);
console.log(title);
for (const row of rows) {
  console.log(
    row.engine.padEnd(12) +
      row.kind.padEnd(11) +
      String(row.queries).padStart(3) +
      row.hit1.toFixed(2).padStart(7) +
      row.hitK.toFixed(2).padStart(7) +
      row.hit10.toFixed(2).padStart(7) +
      row.mrr.toFixed(2).padStart(7) +
      row.precisionK.toFixed(2).padStart(8) +
      String(row.p50).padStart(7) +
      String(row.p95).padStart(8) +
      '  ' +
      JSON.stringify(row.failures),
  );
}
if (rows.length === 0) console.log('(kalit sozlanmagan — bu mashinada hech narsa o‘lchanmadi)');
if (skippedEngines.length) console.log(`\nsozlanmagan (kalit kerak): ${skippedEngines.join(', ')}`);
if (dead.length) console.log(`gold_unreachable (${dead.length}): ${dead.join(' | ')}`);
console.log(
  '\nCheklovlar: bu inson bahosi emas — 19 ta kanonik hujjat bo‘yicha retrieval o‘lchovi. Ikkita hit farq ' +
    'shovqin. kind ustuniga qarang: vertikal indeksni umumiy indeks bilan solishtirish noto‘g‘ri.',
);
