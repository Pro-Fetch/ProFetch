/**
 * The MCP-native benchmark: every number below was produced by talking to the real server over stdio.
 *
 * Why that matters: it is easy to "benchmark" a browser engine by importing its modules and calling them
 * in-process, and just as easy to conclude from those numbers what a model would experience. It would not
 * be the same experience — a model sees the advertised registry, pays for serialisation, gets clipped
 * content, and is refused by policies it cannot read in the source. So this harness spawns
 * `dist/server.js` the way its users do, performs the handshake, lists the tools, calls them, and asserts
 * the answers are *correct*. Timing without correctness is a stopwatch, not a test.
 *
 * `--live` adds a real browser session on the same connection. It is opt-in because it needs a browser and
 * a network, and a benchmark that silently skipped those steps would flatter whichever machine ran it.
 */

import process from 'node:process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const LIVE = process.argv.includes('--live');
const LIVE_URL = 'https://example.com/';
const startedAt = new Date();
const t0 = performance.now();

interface Call {
  name: string;
  ms: number;
  bytes: number;
  isError: boolean;
  assertion: string;
  ok: boolean;
  detail?: string;
}

const calls: Call[] = [];
const failures: string[] = [];

/**
 * What the live session hands back, carried forward rather than recomputed.
 *
 * Identity hashes belong to the server: computing one here would be a second implementation that could
 * quietly disagree with the first, and then the "accepted" case would prove nothing.
 */
let liveSession = '';
let liveIdentity = '';
let liveBackendId = '';
let liveToken = '';

const now = (): number => performance.now();

function textOf(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content.map((item) => String((item as { text?: unknown }).text ?? '')).join('\n');
}

function jsonOf(result: unknown): Record<string, unknown> {
  const match = /```json\n([\s\S]*?)\n```/.exec(textOf(result));
  if (!match) return {};
  try {
    return JSON.parse(match[1]!) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** A node record in the shape the injected-list tools parse. Fixed, so runs stay comparable. */
function fixture(label: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    backendId: 'pf-1',
    token: 't1',
    frameId: 'main',
    path: 'html>body>button[1]',
    tag: 'button',
    role: 'button',
    name: label,
    text: label,
    rect: { x: 100, y: 200, width: 120, height: 32 },
    inViewport: true,
    styleVisible: true,
    hitTestSelf: true,
    obstructed: false,
    depth: 3,
    interactive: true,
    boundaries: [],
    ...extra,
  };
}

/**
 * Fixed arguments per tool — a benchmark whose inputs vary between runs measures nothing.
 *
 * Only the keys each tool's schema accepts: every schema in the pack sets `additionalProperties: false`,
 * so handing a session-id-only tool an extra `identity` is a validation error, not a harmless
 * convenience. The first run of this harness proved that the hard way.
 */
function argsFor(name: string): Record<string, unknown> {
  switch (name) {
    case 'pro_browser_use_browsers_select':
      return { requires: JSON.stringify(['domRead']) };
    case 'pro_browser_use_browsers_launch_plan':
      return { product: 'chrome' };
    case 'pro_browser_use_browsers_attach_validate':
      return { endpoint: 'http://127.0.0.1:9333' };
    case 'pro_browser_use_capabilities_check':
      return { product: 'chrome', capabilities: JSON.stringify(['accessibilityTree', 'hitTesting']) };
    case 'pro_browser_use_capabilities_matrix':
      return { format: 'json' };
    case 'pro_browser_use_coords_convert':
      return {
        rect: JSON.stringify({ x: 100, y: 200, width: 120, height: 32 }),
        to: 'screenshot',
        capture: JSON.stringify({
          kind: 'viewport',
          deviceScaleFactor: 2,
          image: { width: 2560, height: 1440 },
          scroll: { x: 0, y: 0 },
        }),
      };
    case 'pro_browser_use_state_classify':
      return { kind: 'hover', node: JSON.stringify(fixture('Row')) };
    case 'pro_browser_use_action_preflight':
      return {
        action: 'click',
        url: 'https://shop.test/cart',
        nodes: JSON.stringify([fixture('Add to cart')]),
        identity: liveIdentity || 'deadbeef',
        backend_id: liveIdentity ? liveBackendId : 'pf-1',
        token: liveIdentity ? liveToken : 't1',
      };
    case 'pro_browser_use_diff_lists':
      return { before: JSON.stringify([fixture('Add to cart')]), after: JSON.stringify([fixture('In cart')]) };
    case 'pro_browser_use_health_diagnose':
      return {
        nodes: JSON.stringify([fixture('')]),
        meta: JSON.stringify({
          title: 'Cart',
          lang: '',
          hasViewportMeta: true,
          doctype: 'html',
          horizontalOverflow: 0,
          duplicateIdCount: 0,
          images: 2,
          imagesWithoutAlt: 2,
          frameCount: 0,
        }),
        url: 'https://shop.test/cart',
      };
    case 'pro_browser_use_session_open':
      return { url: LIVE_URL, outline: false };
    // A taller viewport first: the page under test keeps its single link just below a 720 px fold, and a
    // bench asserting on an empty element list would be asserting nothing.
    case 'pro_browser_use_resize':
      return { session_id: liveSession, width: 1280, height: 900 };
    case 'pro_browser_use_snapshot':
    case 'pro_browser_use_coverage':
    case 'pro_browser_use_outline':
    case 'pro_browser_use_history':
    case 'pro_browser_use_extract':
    case 'pro_browser_use_session_close':
      return { session_id: liveSession };
    case 'pro_browser_use_screenshot':
      return { session_id: liveSession, kind: 'viewport' };
    case 'pro_browser_use_element_check':
      return { session_id: liveSession, identity: liveIdentity, backend_id: liveBackendId, token: liveToken };
    default:
      return {};
  }
}

const client = new Client({ name: 'pro-fetch-bench', version: '1.0.0' });

async function measure(
  name: string,
  assertion: string,
  check: (body: Record<string, unknown>) => string | null,
): Promise<Record<string, unknown>> {
  const before = now();
  const raw = await client.callTool({ name, arguments: argsFor(name) });
  const ms = now() - before;
  const text = textOf(raw);
  const body = jsonOf(raw);
  const problem = check(body);
  calls.push({
    name,
    ms: Math.round(ms * 100) / 100,
    bytes: text.length,
    isError: (raw as { isError?: boolean }).isError === true,
    assertion,
    ok: problem === null,
    detail: problem ?? undefined,
  });
  if (problem) failures.push(`${name}: ${problem}`);
  return body;
}

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve('dist/server.js')],
    env: { ...process.env, PRO_FETCH_PROFILE: 'full', PRO_FETCH_LOG_NARROWING: 'false' } as Record<string, string>,
    cwd: process.cwd(),
  });

  const connectStart = now();
  await client.connect(transport);
  const connectMs = now() - connectStart;

  const listStart = now();
  const listed = await client.listTools();
  const listMs = now() - listStart;
  const tools = listed.tools ?? [];
  const names = new Set(tools.map((t) => t.name));
  const browserUse = tools.filter((t) => t.name.startsWith('pro_browser_use_'));

  if (!names.has('pro_browser_use_browsers_detect'))
    failures.push('the server did not advertise pro_browser_use_browsers_detect');
  if (browserUse.length < 40) failures.push(`only ${browserUse.length} browser_use tools were advertised`);

  await measure('pro_browser_use_browsers_detect', 'os + found array', (body) =>
    typeof body.os === 'string' && Array.isArray(body.found)
      ? null
      : `unexpected payload: ${JSON.stringify(body).slice(0, 120)}`,
  );

  await measure('pro_browser_use_diff_lists', 'a relabel is reported as relabelled, not as add+remove', (body) => {
    const counts = body.counts as Record<string, number> | undefined;
    if (!counts) return 'no counts';
    return counts.relabelled === 1 && counts.added === 0 && counts.removed === 0 ? null : JSON.stringify(counts);
  });

  await measure('pro_browser_use_action_preflight', 'an identity the server never handed out is refused', (body) =>
    body.decision === 'REFUSE' ? null : `preflight allowed a made-up identity: ${JSON.stringify(body).slice(0, 160)}`,
  );

  await measure('pro_browser_use_browsers_select', 'a selection, or a blocker naming what is installed', (body) => {
    if (body.ok === true) return typeof body.product === 'string' ? null : 'ok without a product';
    return typeof body.blocker === 'string' && body.blocker.length > 10 ? null : 'refusal without a blocker';
  });

  await measure('pro_browser_use_browsers_launch_plan', 'a plan with an executable and a profile directory', (body) =>
    body.ok === true && typeof body.user_data_dir === 'string'
      ? null
      : `unexpected plan: ${JSON.stringify(body).slice(0, 160)}`,
  );

  await measure('pro_browser_use_browsers_attach_validate', 'loopback allowed, and the port is parsed out', (body) =>
    body.ok === true && body.port === 9333 ? null : `loopback refused: ${JSON.stringify(body).slice(0, 160)}`,
  );

  await measure(
    'pro_browser_use_capabilities_matrix',
    'status counts add up to 24 products × 30 capabilities',
    (body) => {
      const counts = body.status_counts as Record<string, number> | undefined;
      if (!counts) return 'no status_counts';
      const total = Object.values(counts).reduce((s, v) => s + v, 0);
      return total === 720 ? null : `status counts add to ${total}, expected 720`;
    },
  );

  await measure('pro_browser_use_capabilities_check', 'each capability answered with a reason', (body) => {
    const answers = body.answers as Array<Record<string, unknown>> | undefined;
    if (!answers || answers.length !== 2) return 'wrong answer count';
    return answers.every((a) => typeof a.reason === 'string' && (a.reason as string).length > 10)
      ? null
      : 'an answer without a reason';
  });

  await measure('pro_browser_use_coords_convert', 'a 100,200 box at dpr 2 lands at 200,400 in the image', (body) => {
    const box = body.image_box as Record<string, number> | undefined;
    if (!box) return 'no image_box';
    return box.x === 200 && box.y === 400 && box.width === 240 && box.height === 64 ? null : JSON.stringify(box);
  });

  await measure('pro_browser_use_state_classify', 'a hover is offered as SAFE_REVERSIBLE', (body) =>
    body.safety === 'SAFE_REVERSIBLE' ? null : `classify said ${String(body.safety)}`,
  );

  await measure('pro_browser_use_health_diagnose', 'missing alt text and missing lang are both reported', (body) => {
    const kinds = ((body.findings as Array<Record<string, unknown>> | undefined) ?? []).map((f) => f.kind);
    return kinds.includes('images-without-alt') && kinds.includes('no-lang')
      ? null
      : `findings: ${kinds.join(', ') || 'none'}`;
  });

  let liveSummary: Record<string, unknown> = { enabled: false };
  if (LIVE) {
    const opened = await measure('pro_browser_use_session_open', 'a live page opens and reports nodes', (body) =>
      body.ok === true && Number(body.nodes_in_latest) > 0 ? null : `open said ${JSON.stringify(body).slice(0, 160)}`,
    );
    liveSession = String(opened.session_id ?? '');

    await measure('pro_browser_use_resize', 'page, capture and request agree on the new size', (body) =>
      body.consistent === true ? null : `resize disagreed: ${JSON.stringify(body).slice(0, 200)}`,
    );

    const snapshot = await measure(
      'pro_browser_use_snapshot',
      'a re-read advances the model and lists nodes',
      (body) =>
        body.ok === true && Number(body.version) >= 2 && Array.isArray(body.sample)
          ? null
          : `snapshot said ${JSON.stringify(body).slice(0, 160)}`,
    );
    const first = ((snapshot.sample ?? []) as Array<Record<string, unknown>>)[0];
    if (first) {
      liveIdentity = String(first.identity);
      liveBackendId = String(first.backend_id);
      liveToken = String(first.token);
    } else {
      failures.push('the session produced no sample node, so nothing below could be checked');
    }

    // The counterpart of the invented-identity refusal above: an identity the server really handed out
    // resolves against the model that produced it.
    await measure('pro_browser_use_element_check', 'a live identity resolves as FRESH', (body) =>
      body.staleness === 'FRESH' ? null : 'resolved as ' + String(body.staleness) + ': ' + String(body.reason),
    );

    await measure('pro_browser_use_coverage', 'the ledger states what it has not seen', (body) =>
      body.ok === true && typeof body.gaps === 'string' ? null : 'no gaps field',
    );

    await measure('pro_browser_use_outline', 'the outline is text, with its own truncation counts', (body) =>
      typeof body.outline === 'string' && body.outline.length > 0 ? null : 'outline was not a string',
    );

    await measure('pro_browser_use_screenshot', 'a capture reports a size with pixels behind it', (body) => {
      const image = (body.geometry as Record<string, unknown> | undefined)?.image as { width?: number } | undefined;
      return body.ok === true && Number(image?.width) > 0 && Number(body.bytes) > 1000
        ? null
        : 'capture missing geometry or bytes';
    });

    await measure('pro_browser_use_extract', 'extraction answers, even when the honest answer is none', (body) =>
      body.ok === true && Array.isArray(body.records) ? null : 'extract returned no record list',
    );

    await measure('pro_browser_use_history', 'the reads are listed with their transition kinds', (body) => {
      const transitions = (body.transitions ?? []) as Array<Record<string, unknown>>;
      return transitions.some((t) => t.kind === 'INITIAL') ? null : 'no INITIAL transition in the history';
    });

    await measure('pro_browser_use_session_close', 'the session closes and reports itself gone', (body) =>
      body.ok === true ? null : 'close refused',
    );

    liveSummary = {
      enabled: true,
      url: opened.url,
      title: opened.title,
      product: opened.product,
      session: liveSession,
    };
  }

  await transport.close();

  const ms = (value: number): string => value.toFixed(1).padStart(7);
  const rows = calls.map(
    (c) =>
      `${c.ok ? 'ok  ' : 'FAIL'} ${c.name.padEnd(44)} ${ms(c.ms)} ms  ${String(c.bytes).padStart(7)} B  ${c.assertion}`,
  );
  const totalMs = calls.reduce((s, c) => s + c.ms, 0);
  console.log(`# pro-fetch MCP bench — ${startedAt.toISOString()} — profile=full`);
  console.log(
    `connect ${ms(connectMs)} ms · tools/list ${ms(listMs)} ms (${tools.length} tools, ${browserUse.length} browser_use)`,
  );
  console.log(rows.join(String.fromCharCode(10)));
  console.log(
    `# ${calls.filter((c) => c.ok).length}/${calls.length} bench assertions passed in ${ms(totalMs)} ms of call time`,
  );

  const outDir = path.join('benchmarks', 'browser-use', 'artifacts');
  await mkdir(outDir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const summary = {
    started: startedAt.toISOString(),
    wall_ms: Math.round(now() - t0),
    connect_ms: Math.round(connectMs * 100) / 100,
    tools_list_ms: Math.round(listMs * 100) / 100,
    tools_total: tools.length,
    tools_browser_use: browserUse.length,
    call_ms_total: Math.round(totalMs * 100) / 100,
    slowest: [...calls].sort((a, b) => b.ms - a.ms)[0],
    assertions: calls.map((c) => ({
      name: c.name,
      ok: c.ok,
      ms: c.ms,
      bytes: c.bytes,
      assertion: c.assertion,
      detail: c.detail,
    })),
    failures,
    live: liveSummary,
    server: { entry: 'dist/server.js', transport: 'stdio' },
  };
  await writeFile(path.join(outDir, `mcp-bench-${stamp}.json`), JSON.stringify(summary, null, 2), 'utf8');
  const csv = ['name,ms,bytes,is_error,ok,assertion,detail']
    .concat(
      calls.map((c) =>
        [c.name, c.ms, c.bytes, c.isError, c.ok, `"${c.assertion}"`, `"${(c.detail ?? '').replace(/"/g, '""')}"`].join(
          ',',
        ),
      ),
    )
    .join(String.fromCharCode(10));
  await writeFile(path.join(outDir, `mcp-bench-${stamp}.csv`), csv + String.fromCharCode(10), 'utf8');
  const md = [
    '# MCP-native benchmark',
    '',
    `Run: \`${startedAt.toISOString()}\` · transport: stdio against \`dist/server.js\` · profile: \`full\``,
    '',
    `- tools advertised: **${tools.length}**, of which \`browser_use\`: **${browserUse.length}**`,
    `- \`tools/list\`: ${ms(listMs)} ms · connect: ${ms(connectMs)} ms · total call time: ${ms(totalMs)} ms`,
    `- assertions: **${calls.filter((c) => c.ok).length}/${calls.length} passed**`,
    LIVE
      ? '- live browser tools: **included** (`--live`)'
      : '- live browser tools: **not included** (run with `--live`)',
    '',
    '| tool | ms | bytes | assertion |',
    '| --- | ---: | ---: | --- |',
    ...calls.map(
      (c) => `| \`${c.name}\` | ${c.ms} | ${c.bytes} | ${c.ok ? 'passed' : 'FAILED — ' + (c.detail ?? '')} |`,
    ),
    '',
    'The assertion column is the point: a fast wrong answer is a failure. Timings describe this host and',
    'this run; the correctness of each payload is what this harness refuses to publish without.',
    '',
  ].join(String.fromCharCode(10));
  await writeFile(path.join('benchmarks', 'browser-use', 'MCP_BENCH_LATEST.md'), md, 'utf8');

  if (failures.length) {
    console.error(failures.map((f) => `FAIL ${f}`).join(String.fromCharCode(10)));
    process.exit(1);
  }
}

await main();
