/**
 * The Phase 4 compatibility probe.
 *
 * This is what turns a capability row from `p` (read from a specification) into `Y*` (ran on this
 * machine). It is committed because a compatibility claim nobody can re-run is a screenshot, not
 * evidence: the same script produces the artifact `docs/browser-use/BROWSER_COMPATIBILITY_RESULTS.md`
 * is built from, on any host, and it prints what it could not do as loudly as what it could.
 *
 * It deliberately touches no network. Every navigation is `about:blank` plus `setContent`, so a run
 * measures the engine and the browser, not somebody's uptime — and so the SSRF guard, which is the
 * thing this repository is most careful about, is never the reason a probe fails.
 */

import process from 'node:process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.PRO_FETCH_PROFILE ??= 'full';

const { detectInstalled, launchManaged, localRegistry, currentOs } = await import('../src/core/browser-use-runtime.js');
const { selectBrowser } = await import('../src/core/browser-use-registry.js');

interface ProbeResult {
  product: string;
  step: 'detect' | 'launch' | 'navigate' | 'read' | 'geometry' | 'accessibility' | 'close';
  ok: boolean;
  detail: string;
  ms: number;
}

const results: ProbeResult[] = [];
const started = Date.now();

async function step(product: string, name: ProbeResult['step'], fn: () => Promise<string>): Promise<boolean> {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ product, step: name, ok: true, detail, ms: Date.now() - t0 });
    return true;
  } catch (error) {
    results.push({ product, step: name, ok: false, detail: (error as Error).message, ms: Date.now() - t0 });
    return false;
  }
}

const os = currentOs();
const dataRoot = await mkdtemp(path.join(tmpdir(), 'pro-fetch-bu-'));

console.log(`# browser_use probe — ${new Date().toISOString()} — host os=${os}`);
console.log(`# data root: ${dataRoot}`);

const detected = await detectInstalled({ readVersions: true });
console.log(`# detected: ${detected.length ? detected.map((d) => `${d.product}@${d.version || '?'}`).join(', ') : 'nothing'}`);

if (detected.length === 0) {
  console.log('# no browser detected; nothing to probe. This is reported, not faked.');
  await rm(dataRoot, { recursive: true, force: true });
  process.exit(0);
}

const registry = await localRegistry({ readVersions: true });

for (const entry of registry.entries) {
  const product = entry.browser.product;
  if (entry.browser.engine === 'webkit') {
    // Safari cannot be launched from any host here, and WebKit builds are not published for Windows.
    results.push({ product, step: 'launch', ok: false, detail: 'not launchable from this host (macOS-only automation / no Windows WebKit build)', ms: 0 });
    continue;
  }

  const launched = await step(product, 'launch', async () => {
    const r = await launchManaged(product, { dataRoot, headless: true });
    if (!r.ok) throw new Error(r.reason);
    (globalThis as Record<string, unknown>).__session = r.session;
    return `${path.basename(r.session.executablePath)} · profile=${path.basename(r.session.userDataDir)}${r.session.notes.length ? ' · ' + r.session.notes.join('; ') : ''}`;
  });
  if (!launched) continue;

  const session = (globalThis as Record<string, unknown>).__session as Awaited<ReturnType<typeof launchManaged>> extends { session: infer S } ? S : never;
  const context = (session as { context: { pages(): unknown[]; newPage(): Promise<any> } }).context;
  let page: any;

  const navigated = await step(product, 'navigate', async () => {
    page = await context.newPage();
    await page.goto('about:blank');
    await page.setContent(
      '<!doctype html><title>probe</title><h1 id="t">pro-fetch probe</h1>' +
        '<button id="b" aria-label="Press me">Press</button>' +
        '<div style="overflow:auto;height:40px"><div style="height:400px">tall</div></div>',
      { waitUntil: 'domcontentloaded' },
    );
    return `title=${await page.title()}`;
  });
  if (!navigated) {
    await step(product, 'close', async () => {
      await (session as { browser: { close(): Promise<void> } }).browser.close();
      return 'closed';
    });
    continue;
  }

  await step(product, 'read', async () => {
    const text = await page.evaluate(() => document.getElementById('t')?.textContent ?? '');
    if (text !== 'pro-fetch probe') throw new Error(`unexpected text "${text}"`);
    return `DOM read "${text}"`;
  });

  await step(product, 'geometry', async () => {
    const box = await page.locator('#b').boundingBox();
    if (!box || !(box.width > 0) || !(box.height > 0)) throw new Error('no bounding box');
    return `button ${Math.round(box.width)}x${Math.round(box.height)} @ ${Math.round(box.x)},${Math.round(box.y)}`;
  });

  await step(product, 'accessibility', async () => {
    const snapshot: string = await page.locator('#b').ariaSnapshot();
    if (!/Press me/i.test(snapshot)) throw new Error(`aria snapshot missing the accessible name: ${snapshot.slice(0, 80)}`);
    return `ariaSnapshot: ${snapshot.trim().slice(0, 60)}`;
  });

  await step(product, 'close', async () => {
    await (session as { browser: { close(): Promise<void> } }).browser.close();
    return 'closed';
  });
}

await rm(dataRoot, { recursive: true, force: true });

const artifact = path.join(process.cwd(), 'benchmarks', 'browser-use', 'artifacts');
await writeFile(path.join(artifact, `probe-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify({ os, started, ms: Date.now() - started, results }, null, 2), {
  recursive: true,
}).catch(async () => {
  // The artifact directory does not exist yet in this phase; create it and retry once rather than
  // losing the evidence the whole run was for.
  const { mkdir } = await import('node:fs/promises');
  await mkdir(artifact, { recursive: true });
  await writeFile(path.join(artifact, `probe-${Date.now()}.json`), JSON.stringify({ os, started, ms: Date.now() - started, results }, null, 2));
});

for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.product.padEnd(18)} ${r.step.padEnd(14)} ${r.ms}ms  ${r.detail}`);
}
const passed = results.filter((r) => r.ok).length;
console.log(`# ${passed}/${results.length} probe steps passed in ${Date.now() - started}ms`);
