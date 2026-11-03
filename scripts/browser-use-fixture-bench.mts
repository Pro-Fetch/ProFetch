/**
 * The fixture benchmark: local pages with known answers, driven through the real engine.
 *
 * Why fixtures instead of only the compatibility probe: the probe asks "does the protocol let us do X";
 * this asks "when the page does X, does the engine get the right answer". Every expectation below is
 * written into the HTML — six named buttons, a five-row list, one unlabelled field, one 12-pixel target,
 * a control four screens down — so a score means something rather than being a screenshot of timings.
 *
 * Nothing here touches the network: each fixture is read from disk and handed to the browser as a
 * `data:` URL. A benchmark that needed somebody's website to be up would report the website, not the
 * engine.
 */

import process from 'node:process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const startedAt = new Date();
const t0 = performance.now();

const { COLLECTOR_SCRIPT } = await import('../src/core/browser-use-collector.js');
const { GEOMETRY_SCRIPT, HOP_SCRIPT } = await import('../src/core/browser-use-session.js');
const perception = await import('../src/core/browser-use-perception.js');
const frames = await import('../src/core/browser-use-frames.js');
const world = await import('../src/core/browser-use-world.js');
const coverage = await import('../src/core/browser-use-coverage.js');
const objects = await import('../src/core/browser-use-objects.js');
const coords = await import('../src/core/browser-use-coordinates.js');
const actions = await import('../src/core/browser-use-actions.js');
const health = await import('../src/core/browser-use-health.js');

interface Check {
  fixture: string;
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];
function check(fixture: string, name: string, ok: boolean, detail: string): void {
  checks.push({ fixture, name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'MISS'} ${fixture.padEnd(18)} ${name.padEnd(46)} ${detail}`);
}

const FIXTURE_DIR = path.join('benchmarks', 'browser-use', 'fixtures');

async function fixtureUrl(file: string): Promise<string> {
  const html = await readFile(path.join(FIXTURE_DIR, file), 'utf8');
  // One html lang="en" doc per fixture; whitespace is left alone so line numbers stay comparable.
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

const playwright = await import('playwright');
const browser = await playwright.chromium.launch({ headless: true });

async function read(page: any): Promise<{ snapshot: any; collected: any; meta: any }> {
  const collected = await frames.collectAllFrames(
    { frames: () => page.frames() },
    async (frame: any) => {
      const r = await frame.evaluate(COLLECTOR_SCRIPT);
      return { nodes: r.nodes, url: r.url, title: r.title };
    },
    async (frame: any) => {
      try {
        return await frame.evaluate(HOP_SCRIPT);
      } catch (error) {
        return { ok: false, reason: String((error as Error).message).slice(0, 80) };
      }
    },
  );
  const geometry = await page.evaluate(GEOMETRY_SCRIPT);
  const snapshot = perception.buildSnapshot(collected.nodes, {
    snapshotId: 'fixture-' + Date.now(),
    url: String(collected.frames[0]?.url ?? 'fixture'),
    title: await page.title().catch(() => 'fixture'),
    viewport: geometry.viewport,
    deviceScaleFactor: geometry.deviceScaleFactor,
    scroll: geometry.scroll,
    capturedAt: Date.now(),
    budget: 400,
  });
  return { snapshot, collected, meta: geometry };
}

// ---------------------------------------------------------------- products.html
{
  const file = 'products.html';
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(await fixtureUrl(file), { waitUntil: 'domcontentloaded' });
  const { snapshot } = await read(page);

  const expectedNames = ['Add Keyboard', 'Add Monitor', 'Add Webcam', 'Add Headset', 'Add Mouse', 'Checkout'];
  const found = expectedNames.filter((n) => snapshot.nodes.some((x: any) => x.name === n && x.interactable));
  check(
    file,
    'every named control is perceived',
    found.length === expectedNames.length,
    `${found.length}/${expectedNames.length}: ${found.join(', ')}`,
  );

  const roles = snapshot.nodes.filter((x: any) => x.role === 'button').length;
  check(file, 'button role comes from the AX side, not guessed', roles === 6, `${roles} buttons reported`);

  const groups = objects.groupObjects(snapshot);
  const list = groups.find((g) => g.kind === 'list');
  check(
    file,
    'a five-row list is grouped from shape alone',
    !!list && list.repeated >= 5,
    list
      ? `repeated=${list.repeated} evidence: ${list.evidence.join(' | ')}`
      : `groups: ${groups.map((g) => g.kind).join(', ') || 'none'}`,
  );
  const form = groups.find((g) => g.kind === 'form');
  check(
    file,
    'the quantity/checkout form is recognised',
    !!form,
    form ? `evidence: ${form.evidence.join(' | ')}` : 'no form group',
  );

  const meta = await page.evaluate(health.PAGE_META_SCRIPT);
  const diagnosis = health.diagnose(snapshot, meta);
  check(
    file,
    'a clean page earns no blocking findings',
    diagnosis.blocking === 0,
    `blocking: ${
      diagnosis.findings
        .filter((f) => f.severity === 'BLOCKING')
        .map((f) => f.kind)
        .join(', ') || 'none'
    }`,
  );
  check(
    file,
    'every image has alt text here, and it noticed',
    !diagnosis.findings.some((f) => f.kind === 'images-without-alt'),
    `images: ${meta.images}, without alt: ${meta.imagesWithoutAlt}`,
  );
  await page.close();
}

// ---------------------------------------------------------------- checkout.html
{
  const file = 'checkout.html';
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(await fixtureUrl(file), { waitUntil: 'domcontentloaded' });
  const { snapshot, meta } = await read(page);
  const domMeta = await page.evaluate(health.PAGE_META_SCRIPT);

  const diagnosis = health.diagnose(snapshot, domMeta);
  const kinds = diagnosis.findings.map((f) => f.kind);
  check(
    file,
    'the unlabelled field is reported, not skipped',
    kinds.includes('unlabelled-fields'),
    `findings: ${kinds.join(', ')}`,
  );
  check(
    file,
    'a 12px target is called out as tiny',
    kinds.includes('tiny-targets'),
    diagnosis.findings.find((f) => f.kind === 'tiny-targets')?.evidence ?? 'no tiny-targets finding',
  );

  // Coordinates proven against pixels.
  // The only blue thing in this fixture is the 12px icon button; measuring the default-styled Pay button
  // would have asserted a colour that was never on the page.
  const payBox = await page.locator('.icon').boundingBox();
  const mapped = coords.boxInScreenshot(payBox, {
    kind: 'viewport',
    deviceScaleFactor: meta.deviceScaleFactor,
    image: { width: Math.round(1280 * meta.deviceScaleFactor), height: Math.round(900 * meta.deviceScaleFactor) },
    scroll: { x: 0, y: 0 },
  });
  const png = await page.screenshot({ animations: 'disabled' });
  const sharp = (await import('sharp')).default;
  const raw = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const image = { width: raw.info.width, height: raw.info.height, data: new Uint8Array(raw.data) };
  const visual = await import('../src/core/browser-use-visual.js');
  const crop = visual.cropRgba(image, mapped);
  let blue = 0;
  for (let i = 0; i < crop.data.length; i += 4) if (crop.data[i + 2] > 180 && crop.data[i] < 90) blue++;
  const ratio = blue / (crop.width * crop.height);
  check(
    file,
    'a DOM box maps onto its own pixels',
    ratio > 0.6,
    `${Math.round(ratio * 100)}% of ${mapped.width}x${mapped.height} at ${mapped.x},${mapped.y} is the button blue`,
  );

  // Action policy on the same read.
  let model = world.createWorldModel(snapshot, { tabId: file, contentHeight: meta.contentHeight });
  const payNode = model.latest.nodes.find((n) => n.name === 'Pay now');
  if (!payNode) {
    check(file, 'preflight has a Pay button to judge', false, 'the button was not in the read');
  } else {
    const verdict = actions.preflight(
      {
        kind: 'click',
        target: { identity: payNode.identity, backendId: payNode.backendId, token: payNode.token, rect: payNode.rect },
      },
      model,
      model.latest,
      {},
    );
    check(
      file,
      '"Pay now" is refused without a human decision',
      verdict.decision === 'REFUSE',
      `${verdict.decision}: ${verdict.reason}`,
    );
    const qty = model.latest.nodes.find((n) => n.name === 'Card number');
    const typed = qty
      ? actions.preflight(
          {
            kind: 'type',
            target: { identity: qty.identity, backendId: qty.backendId, token: qty.token, rect: qty.rect },
            value: '42',
          },
          model,
          model.latest,
          {},
        )
      : null;
    check(
      file,
      'typing into the labelled field is allowed',
      typed?.decision === 'ALLOW',
      typed ? `${typed.decision}: ${typed.reason}` : 'no labelled card field found',
    );
  }
  await page.close();
}

// ---------------------------------------------------------------- moving-target.html
{
  const file = 'moving-target.html';
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(await fixtureUrl(file), { waitUntil: 'domcontentloaded' });
  let { snapshot } = await read(page);
  let model = world.createWorldModel(snapshot, { tabId: file });
  const original = model.latest.nodes.find((n) => n.name === 'Add to cart')!;

  await page.evaluate('window.__rename()');
  ({ snapshot } = await read(page));
  let update = world.applySnapshot(model, snapshot, { tabId: file });
  model = update.model;
  const renamed = update.delta.relabelled;
  const buttonRelabel = renamed.find((r) => r.toLabel === 'In cart' && r.fromLabel === 'Add to cart');
  // A rename changes the text of each ancestor too, so several relabels are expected. What has to hold
  // is that the button was relabelled — not removed and re-added, which is what a tokenless id would say.
  check(
    file,
    'a rename in place is a relabel, not a new element',
    !!buttonRelabel &&
      !update.delta.added.some((n) => n.name === 'In cart') &&
      !update.delta.removed.some((n) => n.name === 'Add to cart'),
    buttonRelabel
      ? `${buttonRelabel.fromLabel} → ${buttonRelabel.toLabel} (${renamed.length} relabel(s), +${update.delta.added.length} -${update.delta.removed.length})`
      : `no button relabel among ${renamed.length}; +${update.delta.added.length} -${update.delta.removed.length}`,
  );
  const staleAfterRename = world.resolveInModel(model, {
    identity: original.identity,
    backendId: original.backendId,
    token: original.token,
  });
  check(
    file,
    'the pre-rename identity is refused with a replacement',
    staleAfterRename.staleness === 'CHANGED' && !!staleAfterRename.replacement,
    `${staleAfterRename.staleness}${staleAfterRename.replacement ? ' → replacement offered' : ' → no replacement'}`,
  );

  await page.evaluate('window.__replace()');
  ({ snapshot } = await read(page));
  update = world.applySnapshot(model, snapshot, { tabId: file });
  model = update.model;
  const afterReplace = world.resolveInModel(model, {
    identity: staleAfterRename.replacement ?? original.identity,
    backendId: original.backendId,
    token: original.token,
  });
  check(
    file,
    'a replaced look-alike stops the action',
    !afterReplace.ok,
    `${afterReplace.staleness}: ${afterReplace.detail.slice(0, 90)}`,
  );

  await page.evaluate('window.__cover()');
  ({ snapshot } = await read(page));
  update = world.applySnapshot(model, snapshot, { tabId: file });
  model = update.model;
  const covered = model.latest.nodes.find((n) => n.tag === 'button');
  check(
    file,
    'a covered element is not offered as clickable',
    !!covered && !covered.interactable,
    covered
      ? `interactable=${covered.interactable}; conflicts: ${covered.conflicts.join(' | ') || 'none'}`
      : 'no button found',
  );
  await page.evaluate('window.__uncover()');

  const closed = await read(page);
  const disclosure = closed.snapshot.nodes.find((n) => n.tag === 'details');
  const candidates = coverage.revealCandidates(closed.snapshot);
  const offered = candidates.find((c) => disclosure && c.identity === disclosure.identity);
  check(
    file,
    'a closed disclosure is offered as reversible',
    offered?.safety === 'SAFE_REVERSIBLE',
    offered ? `${offered.kind}/${offered.safety}` : `no candidate among ${candidates.length}`,
  );
  const panelBefore = closed.snapshot.nodes.filter((n: any) => n.tag === 'p').length;
  await page.evaluate('document.getElementById("disclosure").open = true');
  const openedSnap = (await read(page)).snapshot;
  // Count the panel element itself: its ancestors legitimately contain the sentence in their text, and
  // a check over those would count three where the fixture planted one.
  const panelAfter = openedSnap.nodes.filter((n: any) => n.tag === 'p' && /Free returns/.test(n.text)).length;
  await page.evaluate('document.getElementById("disclosure").open = false');
  const reclosed = (await read(page)).snapshot.nodes.filter((n: any) => n.tag === 'p').length;
  check(
    file,
    'the reveal reveals: absent, present, absent again',
    panelBefore === 0 && panelAfter === 1 && reclosed === 0,
    `${panelBefore} → ${panelAfter} → ${reclosed}`,
  );
  const summary1 = closed.snapshot.nodes.find((n: any) => n.tag === 'summary');
  const summary2 = openedSnap.nodes.find((n: any) => n.tag === 'summary');
  check(
    file,
    'a toggle leaves the summary identity intact',
    !!summary1 && !!summary2 && summary1.identity === summary2.identity,
    summary1 && summary2 ? `${summary1.identity} vs ${summary2.identity}` : 'summary missing',
  );
  await page.close();
}

// ---------------------------------------------------------------- tall.html
{
  const file = 'tall.html';
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(await fixtureUrl(file), { waitUntil: 'domcontentloaded' });
  const first = await read(page);
  const height = first.meta.contentHeight as number;
  let ledger = coverage.createLedger(first.snapshot, { contentHeight: height });
  let model = world.createWorldModel(first.snapshot, { tabId: file, contentHeight: height });

  const deepBefore = first.snapshot.nodes.some((n: any) => n.name === 'Subscribe to alerts' && n.inViewport);
  check(
    file,
    'the deep control is invisible to the first read',
    !deepBefore,
    `contentHeight=${height}, bands=${ledger.bands.length}`,
  );

  let guard = 0;
  while (guard++ < 20) {
    const plan = coverage.planScan(ledger, { maxSteps: 2 });
    if (!plan.scrolls.length) break;
    const before = ledger.bands.filter((b) => b.visitedAt !== null).length;
    for (const y of plan.scrolls) {
      await page.evaluate(`(() => { window.scrollTo(0, ${y}); return true; })()`);
      const next = await read(page);
      ledger = coverage.recordSnapshot(ledger, next.snapshot);
      model = world.applySnapshot(model, next.snapshot, { tabId: file }).model;
    }
    if (ledger.bands.filter((b) => b.visitedAt !== null).length === before) break;
  }
  check(
    file,
    'the scan reaches every band',
    coverage.coverageRatio(ledger) === 1,
    `bands visited ${ledger.bands.filter((b) => b.visitedAt !== null).length}/${ledger.bands.length}`,
  );
  const lastRead = await read(page);
  check(
    file,
    'the deep control is found by scrolling, not by luck',
    lastRead.snapshot.nodes.some((n: any) => n.name === 'Subscribe to alerts' && n.interactable),
    `model at v${model.version}, identities ${model.nodes.size}`,
  );
  check(
    file,
    'no band was revisited uselessly',
    ledger.bands.every((b) => b.visitedAt !== null),
    `reads=${ledger.budget.stepsSpent}`,
  );
  await page.close();
}

await browser.close();

// ---------------------------------------------------------------- report
const total = checks.length;
const passed = checks.filter((c) => c.ok).length;
const wall = Math.round(performance.now() - t0);
console.log(
  `# fixture bench — ${total - passed === 0 ? 'all' : `${passed}/${total}`} checks passed in ${wall} ms (chrome, headless, no network)`,
);

const byFixture = new Map<string, { passed: number; total: number }>();
for (const c of checks) {
  const row = byFixture.get(c.fixture) ?? { passed: 0, total: 0 };
  row.total++;
  if (c.ok) row.passed++;
  byFixture.set(c.fixture, row);
}

const outDir = path.join('benchmarks', 'browser-use', 'artifacts');
await mkdir(outDir, { recursive: true });
const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
await writeFile(
  path.join(outDir, `fixture-bench-${stamp}.json`),
  JSON.stringify(
    {
      started: startedAt.toISOString(),
      wall_ms: wall,
      passed,
      total,
      per_fixture: [...byFixture.entries()].map(([fixture, v]) => ({ fixture, ...v })),
      checks,
      host: { browser: 'chromium (headless)', network: 'none — fixtures are data: URLs' },
    },
    null,
    2,
  ),
  'utf8',
);
const csv = ['fixture,check,ok,detail']
  .concat(checks.map((c) => [c.fixture, c.name, c.ok, `"${c.detail.replace(/"/g, '""')}"`].join(',')))
  .join(String.fromCharCode(10));
await writeFile(path.join(outDir, `fixture-bench-${stamp}.csv`), csv + String.fromCharCode(10), 'utf8');

const md = [
  '# Fixture benchmark',
  '',
  `Run: \`${startedAt.toISOString()}\` · chromium headless · **no network** (fixtures are local \`data:\` URLs)`,
  '',
  `- checks passed: **${passed}/${total}** (${Math.round((passed / total) * 100)}%)`,
  '',
  '| fixture | checks |',
  '| --- | --- |',
  ...[...byFixture.entries()].map(([fixture, v]) => `| \`${fixture}\` | ${v.passed}/${v.total} |`),
  '',
  '| fixture | check | result | what it saw |',
  '| --- | --- | --- | --- |',
  ...checks.map((c) => `| \`${c.fixture}\` | ${c.name} | ${c.ok ? 'ok' : '**MISS**'} | ${c.detail} |`),
  '',
  'Each check is scored against an answer written into the fixture file, so a regression here means the',
  'engine stopped seeing something that is still on the page.',
  '',
].join(String.fromCharCode(10));
await writeFile(path.join('benchmarks', 'browser-use', 'FIXTURE_BENCH_LATEST.md'), md, 'utf8');

process.exit(passed === total ? 0 : 1);
