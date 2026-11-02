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
  step:
    | 'detect'
    | 'launch'
    | 'navigate'
    | 'read'
    | 'geometry'
    | 'accessibility'
    | 'perceive'
    | 'stale-detection'
    | 'obstruction'
    | 'group'
    | 'world-model'
    | 'screenshot'
    | 'visual-diff'
    | 'coordinates'
    | 'input'
    | 'console'
    | 'network'
    | 'dialogs'
    | 'downloads'
    | 'uploads'
    | 'cookies'
    | 'storage'
    | 'tabs'
    | 'viewport'
    | 'device-scale'
    | 'attach-native'
    | 'frames'
    | 'annotate'
    | 'scan'
    | 'state-discovery'
    | 'close';
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
console.log(
  `# detected: ${detected.length ? detected.map((d) => `${d.product}@${d.version || '?'}`).join(', ') : 'nothing'}`,
);

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
    results.push({
      product,
      step: 'launch',
      ok: false,
      detail: 'not launchable from this host (macOS-only automation / no Windows WebKit build)',
      ms: 0,
    });
    continue;
  }

  const launched = await step(product, 'launch', async () => {
    const r = await launchManaged(product, { dataRoot, headless: true });
    if (!r.ok) throw new Error(r.reason);
    (globalThis as Record<string, unknown>).__session = r.session;
    return `${path.basename(r.session.executablePath)} · profile=${path.basename(r.session.userDataDir)}${r.session.notes.length ? ' · ' + r.session.notes.join('; ') : ''}`;
  });
  if (!launched) continue;

  const session = (globalThis as Record<string, unknown>).__session as Awaited<
    ReturnType<typeof launchManaged>
  > extends { session: infer S }
    ? S
    : never;
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
    if (!/Press me/i.test(snapshot))
      throw new Error(`aria snapshot missing the accessible name: ${snapshot.slice(0, 80)}`);
    return `ariaSnapshot: ${snapshot.trim().slice(0, 60)}`;
  });

  // --- perception: the collector and the merge, against a real DOM -------------------
  const { COLLECTOR_SCRIPT } = await import('../src/core/browser-use-collector.js');
  const perception = await import('../src/core/browser-use-perception.js');
  const snap = (id: string, collected: any) =>
    perception.buildSnapshot(collected.nodes, {
      snapshotId: id,
      url: collected.url,
      title: collected.title,
      viewport: collected.viewport,
      deviceScaleFactor: collected.deviceScaleFactor,
      scroll: collected.scroll,
      capturedAt: Date.now(),
    });

  let firstIdentity = '';
  let firstBackend = '';

  await step(product, 'perceive', async () => {
    const collected = await page.evaluate(COLLECTOR_SCRIPT);
    const snapshot = snap('probe-1', collected);
    const outline = perception.serializeOutline(snapshot);
    const button = snapshot.nodes.find((n) => n.role === 'button');
    if (!button) throw new Error('collector found no button on a page that has one');
    if (!button.interactable) throw new Error('the button was judged not interactable: ' + button.conflicts.join('; '));
    firstIdentity = button.identity;
    firstBackend = button.backendId;
    return `${collected.nodes.length} nodes, ${outline.lines} outlined, button "${button.name}" identity=${button.identity}`;
  });

  await step(product, 'stale-detection', async () => {
    // Replace the element entirely, keeping tag, name and position. A backend-id lookup would find a
    // node and click it; an identity lookup must refuse.
    await page.evaluate(() => {
      const old = document.getElementById('b');
      const fresh = document.createElement('button');
      fresh.id = 'b';
      fresh.setAttribute('aria-label', 'Press me');
      fresh.textContent = 'Press';
      old!.replaceWith(fresh);
    });
    const collected = await page.evaluate(COLLECTOR_SCRIPT);
    const r = perception.resolveTarget(
      { identity: firstIdentity, backendId: firstBackend },
      snap('probe-2', collected),
    );
    if (r.ok) throw new Error('a replaced element resolved as clickable — the identity check is not working');
    return `${r.staleness}: ${r.detail.slice(0, 100)}`;
  });

  await step(product, 'obstruction', async () => {
    await page.evaluate(() => {
      const veil = document.createElement('div');
      veil.id = 'veil';
      veil.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9999';
      document.body.appendChild(veil);
    });
    const collected = await page.evaluate(COLLECTOR_SCRIPT);
    const button = snap('probe-3', collected).nodes.find((n) => n.role === 'button');
    if (!button) throw new Error('the button vanished under the overlay');
    if (button.interactable) throw new Error('a covered button was still reported interactable');
    await page.evaluate(() => document.getElementById('veil')?.remove());
    return `covered button not interactable; conflicts: ${button.conflicts.join(' | ') || 'hit-test said not self'}`;
  });

  await step(product, 'group', async () => {
    // Object intelligence was written against hand-built fixtures. A fixture can be wrong in a way the
    // author shares with it — here, a role the collector derives from the DOM rather than from markup.
    // So grouping is re-proved against a real document: a list of three repeating product cards, a form
    // and a navigation, none of which the code was tuned to.
    const card = (title: string, price: string) =>
      '<li><img alt="' +
      title +
      '"><h3>' +
      title +
      '</h3><span>' +
      price +
      '</span><button>Add ' +
      title +
      '</button></li>';
    await page.setContent(
      '<!doctype html><title>shop fixture</title>' +
        '<nav><a href="/a">Catalog</a><a href="/b">Cart</a></nav>' +
        '<form><label for="q">Search</label><input id="q" name="q"><button type="submit">Go</button></form>' +
        '<ul>' +
        card('Keyboard', '$49.00') +
        card('Monitor', '$219.99') +
        card('Webcam', '$31.50') +
        '</ul>',
      { waitUntil: 'domcontentloaded' },
    );
    const collected = await page.evaluate(COLLECTOR_SCRIPT);
    const snapshot = snap('probe-group', collected);
    const { groupObjects } = await import('../src/core/browser-use-objects.js');
    const objects = groupObjects(snapshot);
    const kinds = objects.map((o) => o.kind);
    const list = objects.find((o) => o.kind === 'list');
    if (!list) throw new Error(`no list group from a real <ul> of three cards; got ${kinds.join(', ') || 'nothing'}`);
    if (list.repeated < 3) throw new Error(`the list saw ${list.repeated} repeating children, not 3`);
    for (const kind of ['form', 'navigation']) {
      if (!kinds.includes(kind)) throw new Error(`a real ${kind} produced no ${kind} group; got ${kinds.join(', ')}`);
    }
    for (const object of objects) {
      if (object.evidence.length === 0)
        throw new Error(`a ${object.kind} group carries no evidence — the label is unexplainable`);
    }
    return `${objects.length} groups [${kinds.join(', ')}], list repeats ${list.repeated}, every group evidenced`;
  });

  await step(product, 'world-model', async () => {
    const world = await import('../src/core/browser-use-world.js');
    await page.setContent(
      '<!doctype html><title>Cart</title><h1>Your cart</h1><button id="b" aria-label="Add to cart">Add to cart</button>',
      { waitUntil: 'domcontentloaded' },
    );
    let model = world.createWorldModel(snap('wm-1', await page.evaluate(COLLECTOR_SCRIPT)), { tabId: product });
    const button = [...model.nodes.values()].find((n) => n.role === 'button');
    if (!button) throw new Error('the world model started from a page with no button');
    const shownIdentity = button.identity;

    // Same DOM node, different words: the model must call this a re-label, not a death and a birth.
    await page.evaluate(() => {
      const b = document.getElementById('b')!;
      b.textContent = 'In cart';
      b.setAttribute('aria-label', 'In cart');
    });
    const relabel = world.applySnapshot(model, snap('wm-2', await page.evaluate(COLLECTOR_SCRIPT)), { tabId: product });
    if (relabel.transition.kind !== 'MUTATED')
      throw new Error(`a label change classified as ${relabel.transition.kind}`);
    if (relabel.delta.relabelled.length !== 1) {
      throw new Error(
        `expected one relabelled element, got ${relabel.delta.relabelled.length} (added ${relabel.delta.added.length}, removed ${relabel.delta.removed.length})`,
      );
    }
    const stale = world.resolveInModel(relabel.model, {
      identity: shownIdentity,
      backendId: button.backendId,
      token: button.token,
    });
    if (stale.ok || stale.staleness !== 'CHANGED' || !stale.replacement) {
      throw new Error(
        `the pre-edit identity answered ${stale.staleness} ok=${stale.ok} instead of an actionable CHANGED`,
      );
    }
    const current = world.resolveInModel(relabel.model, {
      identity: stale.replacement,
      backendId: button.backendId,
      token: button.token,
    });
    if (!current.ok || current.node?.name !== 'In cart')
      throw new Error('the replacement identity is not usable: ' + current.detail);
    model = relabel.model;

    // A real navigation to a different document that contains a look-alike button. Same url would be a
    // reload; `data:` gives the tab a genuinely different document, which is what is being tested.
    await page.goto(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent('<!doctype html><title>Other</title><button aria-label="Add to cart">Add to cart</button>'),
      {
        waitUntil: 'domcontentloaded',
      },
    );
    const navigated = world.applySnapshot(model, snap('wm-3', await page.evaluate(COLLECTOR_SCRIPT)), {
      tabId: product,
    });
    if (navigated.transition.kind !== 'NAVIGATED') {
      throw new Error(
        `a real navigation classified as ${navigated.transition.kind}; the previous page is still being trusted`,
      );
    }
    const afterNav = world.resolveInModel(navigated.model, {
      identity: stale.replacement,
      backendId: button.backendId,
      token: button.token,
    });
    if (afterNav.ok)
      throw new Error(
        'an element from the previous document resolved after navigating — the page changed and the model did not notice',
      );
    if (afterNav.staleness !== 'NAVIGATED')
      throw new Error(`expected NAVIGATED, got ${afterNav.staleness}: ${afterNav.detail}`);
    const lookalike = navigated.model.latest.nodes.find((n) => n.role === 'button');
    if (!lookalike)
      throw new Error('the new document has no button, so this fixture stopped testing what it was written to test');
    if (lookalike.identity === stale.replacement)
      throw new Error('the new document produced the same identity — identity is not binding to a document');

    return `v${navigated.model.version}: label change relabelled (${stale.staleness}), navigation voided ${navigated.delta.removed.length} identities, look-alike button refused`;
  });

  // --- screenshots and coordinates: Phase 4's capture rows, Phase 6's mapping ---------
  const SHOT_FIXTURE =
    '<!doctype html><title>shot</title>' +
    '<style>html,body{margin:0;background:#ffffff}#b{display:block;margin:40px 0 0 40px;width:120px;height:32px;background:#0040ff;border:0;color:#fff}' +
    '#spacer{height:2000px}</style>' +
    '<button id="b">Buy</button><div id="spacer"></div>';

  const grabViewport = async (): Promise<any> => {
    const sharp = (await import('sharp')).default;
    const png = await page.screenshot({ animations: 'disabled' });
    const raw = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { width: raw.info.width, height: raw.info.height, data: new Uint8Array(raw.data) };
  };

  await step(product, 'screenshot', async () => {
    const visual = await import('../src/core/browser-use-visual.js');
    const coords = await import('../src/core/browser-use-coordinates.js');
    const sharp = (await import('sharp')).default;
    await page.goto('about:blank');
    await page.setContent(SHOT_FIXTURE, { waitUntil: 'domcontentloaded' });
    const meta = await page.evaluate(() => ({
      w: window.innerWidth,
      h: window.innerHeight,
      dpr: window.devicePixelRatio,
      doc: document.documentElement.scrollHeight,
    }));
    const box = await page.locator('#b').boundingBox();
    if (!box) throw new Error('the button has no bounding box on a page that shows one');

    const shot = await grabViewport();
    visual.assertRgba(shot, `${product} viewport capture`);
    const wantW = Math.round(meta.w * meta.dpr);
    const wantH = Math.round(meta.h * meta.dpr);
    if (shot.width !== wantW || shot.height !== wantH) {
      throw new Error(
        `viewport capture is ${shot.width}x${shot.height}, expected ${wantW}x${wantH} for a ${meta.w}x${meta.h} viewport at dpr ${meta.dpr}`,
      );
    }

    // The DOM box must land on the painted pixels. This is the claim every coordinate conversion in
    // Phase 6 rests on, checked against a real capture instead of against arithmetic.
    const blueFraction = (image: any, rect: any, geometry: any): number => {
      const mapped = coords.boxInScreenshot(rect, geometry);
      const crop = visual.cropRgba(image, mapped);
      let blue = 0;
      for (let i = 0; i < crop.data.length; i += 4) if (crop.data[i + 2] > 180 && crop.data[i] < 90) blue++;
      return blue / (crop.width * crop.height);
    };
    const viewportGeometry = {
      kind: 'viewport',
      deviceScaleFactor: meta.dpr,
      image: { width: shot.width, height: shot.height },
      scroll: { x: 0, y: 0 },
    };
    const inViewport = blueFraction(shot, box, viewportGeometry);
    if (inViewport < 0.6)
      throw new Error(`only ${Math.round(inViewport * 100)}% of the mapped viewport box was the button's blue`);

    const fullPng = await page.screenshot({ fullPage: true, animations: 'disabled' });
    const fullRaw = await sharp(fullPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const full = { width: fullRaw.info.width, height: fullRaw.info.height, data: new Uint8Array(fullRaw.data) };
    const wantFullH = Math.round(meta.doc * meta.dpr);
    if (full.height < wantFullH - 2 || full.height > wantFullH + 2) {
      throw new Error(`full-page capture is ${full.height} px tall for a ${meta.doc} px document at dpr ${meta.dpr}`);
    }
    const inFull = blueFraction(full, box, {
      kind: 'full-page',
      deviceScaleFactor: meta.dpr,
      image: { width: full.width, height: full.height },
      scroll: { x: 0, y: 0 },
    });
    if (inFull < 0.6)
      throw new Error(`only ${Math.round(inFull * 100)}% of the mapped full-page box was the button's blue`);

    const elementPng = await page.locator('#b').screenshot();
    const elementRaw = await sharp(elementPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const tolerance = 2;
    if (
      Math.abs(elementRaw.info.width - Math.round(box.width * meta.dpr)) > tolerance ||
      Math.abs(elementRaw.info.height - Math.round(box.height * meta.dpr)) > tolerance
    ) {
      throw new Error(
        `element capture is ${elementRaw.info.width}x${elementRaw.info.height} for a ${box.width}x${box.height} box at dpr ${meta.dpr}`,
      );
    }
    return `viewport ${shot.width}x${shot.height} @dpr ${meta.dpr} · full-page ${full.width}x${full.height} · element ${elementRaw.info.width}x${elementRaw.info.height} · blue in box ${Math.round(inViewport * 100)}%/${Math.round(inFull * 100)}%`;
  });

  await step(product, 'visual-diff', async () => {
    const visual = await import('../src/core/browser-use-visual.js');
    const coords = await import('../src/core/browser-use-coordinates.js');
    const meta = await page.evaluate(() => ({
      w: window.innerWidth,
      h: window.innerHeight,
      dpr: window.devicePixelRatio,
    }));
    const box = (await page.locator('#b').boundingBox())!;
    const before = await grabViewport();
    const after = await grabViewport();

    const self = visual.diffRgba(before, after);
    if (!self.comparable) throw new Error('two captures of the same page were not comparable: ' + self.reason);
    if (self.changedPixels !== 0) {
      throw new Error(
        `a self-comparison reported ${self.changedPixels} changed pixels — the diff is measuring noise, not change`,
      );
    }

    await page.evaluate(() => {
      (document.getElementById('b') as HTMLElement).style.background = '#ff0000';
    });
    const changed = await grabViewport();
    const d = visual.diffRgba(before, changed, { grid: { columns: 8, rows: 8 } });
    if (d.changedPixels === 0) throw new Error('the button changed colour and the diff saw nothing');
    const mapped = coords.boxInScreenshot(box, {
      kind: 'viewport',
      deviceScaleFactor: meta.dpr,
      image: { width: before.width, height: before.height },
      scroll: { x: 0, y: 0 },
    });
    const bb = d.boundingBox!;
    const slack = 2;
    if (
      bb.x < mapped.x - slack ||
      bb.y < mapped.y - slack ||
      bb.x + bb.width > mapped.x + mapped.width + slack ||
      bb.y + bb.height > mapped.y + mapped.height + slack
    ) {
      throw new Error(
        `the change landed at ${bb.x},${bb.y} ${bb.width}x${bb.height} but the DOM box maps to ${mapped.x},${mapped.y} ${mapped.width}x${mapped.height}`,
      );
    }
    await page.evaluate(() => {
      (document.getElementById('b') as HTMLElement).style.background = '#0040ff';
    });
    return `${d.changedPixels} of ${d.comparedPixels} pixels changed (${(d.changedRatio * 100).toFixed(1)}%), inside the mapped box; identical captures diff to 0`;
  });

  await step(product, 'coordinates', async () => {
    const coords = await import('../src/core/browser-use-coordinates.js');
    const snapshot = snap('coord-1', await page.evaluate(COLLECTOR_SCRIPT));
    const button = snapshot.nodes.find((n: any) => n.role === 'button');
    if (!button) throw new Error('no button in the live snapshot');
    const point = coords.clickPoint(button.rect, button.frameId);
    const at = coords.whatIsAt(snapshot, point, button.frameId);
    if (!at.ok || at.at?.identity !== button.identity)
      throw new Error(`the button's own centre resolved elsewhere: ${at.reason}`);
    const fresh = coords.revalidatePoint(snapshot, { identity: button.identity, rect: button.rect });
    if (!fresh.ok || fresh.drift.x !== 0 || fresh.drift.y !== 0)
      throw new Error('an unchanged element failed revalidation: ' + fresh.reason);

    await page.evaluate(() => window.scrollTo(0, 400));
    const scrolled = snap('coord-2', await page.evaluate(COLLECTOR_SCRIPT));
    const moved = coords.revalidatePoint(scrolled, { identity: button.identity, rect: button.rect });
    if (moved.drift.y >= 0)
      throw new Error(
        `scrolling down 400 px reported drift ${moved.drift.x},${moved.drift.y}; the box should have moved up`,
      );
    if (moved.ok)
      throw new Error('a remembered click point still validated after the page scrolled — the drift was ignored');

    await page.evaluate(() => {
      const veil = document.createElement('div');
      veil.id = 'veil2';
      veil.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.3);z-index:9999';
      document.body.appendChild(veil);
    });
    const covered = snap('coord-3', await page.evaluate(COLLECTOR_SCRIPT));
    const target = covered.nodes.find((n: any) => n.identity === button.identity) ?? button;
    const blocked = coords.whatIsAt(covered, coords.centreOf(target.rect), target.frameId);
    await page.evaluate(() => document.getElementById('veil2')?.remove());
    if (blocked.ok && blocked.at?.identity === button.identity) {
      throw new Error('the button was covered by a fixed overlay and the point still resolved to it');
    }
    return `centre verified; scroll drift ${Math.round(moved.drift.x)},${Math.round(moved.drift.y)} refused; covered point: ${blocked.reason.slice(0, 60)}`;
  });

  // --- the rest of Phase 4: input, network, storage, tabs, emulation, native attach ----
  // `.invalid` is reserved by the DNS spec and can never resolve, so a request to it that is answered
  // from memory proves interception rather than merely proving a fast network.
  const fakeOrigin = 'https://probe.invalid';
  const serveFakeOrigin = async (body: string): Promise<void> => {
    await page.route(`${fakeOrigin}/**`, (route: any) =>
      route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body }),
    );
  };

  await step(product, 'input', async () => {
    const coords = await import('../src/core/browser-use-coordinates.js');
    await page.goto('about:blank');
    await page.setContent(
      '<!doctype html><title>input</title><input id="t">' +
        '<button id="b">Go</button><div id="log"></div>' +
        '<script>' +
        'document.getElementById("b").addEventListener("click",function(){document.getElementById("log").textContent="clicked";});' +
        'document.getElementById("t").addEventListener("keydown",function(e){if(e.key==="Enter")document.getElementById("log").textContent="enter:"+e.target.value;});' +
        '</script>',
      { waitUntil: 'domcontentloaded' },
    );
    const snapshot = snap('input-1', await page.evaluate(COLLECTOR_SCRIPT));
    const field = snapshot.nodes.find((n: any) => n.tag === 'input');
    const button = snapshot.nodes.find((n: any) => n.role === 'button');
    if (!field || !button) throw new Error('the input fixture produced no field or no button');

    // The click point comes from the snapshot the model was shown, not from a selector: this is the path
    // an action engine will really take, coordinates included.
    const fieldPoint = coords.clickPoint(field.rect, field.frameId);
    await page.mouse.click(fieldPoint.x, fieldPoint.y);
    await page.keyboard.type('hello');
    const typed = await page.evaluate(() => (document.getElementById('t') as HTMLInputElement).value);
    if (typed !== 'hello') throw new Error(`keyboard input landed somewhere else: value is "${typed}"`);
    await page.keyboard.press('Enter');
    const enterLog = await page.evaluate(() => document.getElementById('log')?.textContent ?? '');
    if (enterLog !== 'enter:hello')
      throw new Error(`the Enter keydown never reached the field's handler (log="${enterLog}")`);

    const buttonPoint = coords.clickPoint(button.rect, button.frameId);
    await page.mouse.click(buttonPoint.x, buttonPoint.y);
    const log = await page.evaluate(() => document.getElementById('log')?.textContent ?? '');
    if (!log.includes('clicked'))
      throw new Error(`a pointer click at the reported centre did not reach the button (log="${log}")`);
    return `focus via ${fieldPoint.x},${fieldPoint.y} typed "${typed}"; Enter logged "${enterLog}"; click at ${buttonPoint.x},${buttonPoint.y} reached the button`;
  });

  await step(product, 'console', async () => {
    const messages: string[] = [];
    const listener = (m: any): void => {
      messages.push(`${m.type()}:${m.text()}`);
    };
    page.on('console', listener);
    await page.evaluate(() => {
      console.log('pf-probe-log');
      console.warn('pf-probe-warn');
    });
    await page.waitForTimeout(200);
    page.off('console', listener);
    if (!messages.some((m) => m === 'log:pf-probe-log'))
      throw new Error(`console.log was not delivered: ${messages.join(' | ') || 'nothing'}`);
    if (!messages.some((m) => m === 'warning:pf-probe-warn'))
      throw new Error(`console.warn was not classified as a warning: ${messages.join(' | ')}`);
    return `${messages.length} message(s): ${messages.join(', ')}`;
  });

  await step(product, 'network', async () => {
    const sharp = (await import('sharp')).default;
    const png = await sharp({
      create: { width: 4, height: 4, channels: 4, background: { r: 0, g: 128, b: 255, alpha: 1 } },
    })
      .png()
      .toBuffer();
    const requests: string[] = [];
    const responses: Array<{ url: string; status: number }> = [];
    const onRequest = (r: any): void => {
      requests.push(r.url());
    };
    const onResponse = (r: any): void => {
      responses.push({ url: r.url(), status: r.status() });
    };
    page.on('request', onRequest);
    page.on('response', onResponse);
    await page.route(`${fakeOrigin}/**`, (route: any) => {
      const url = route.request().url();
      if (url.endsWith('.png')) return route.fulfill({ status: 200, contentType: 'image/png', body: png });
      return route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><title>net</title><img id="i" src="${fakeOrigin}/probe.png" alt="">`,
      });
    });
    await page.goto(`${fakeOrigin}/app`);
    await page.waitForFunction(
      () => (document.getElementById('i') as HTMLImageElement | null)?.naturalWidth === 4,
      null,
      { timeout: 8000 },
    );
    page.off('request', onRequest);
    page.off('response', onResponse);
    await page.unroute(`${fakeOrigin}/**`);

    const pngRequest = requests.filter((u) => u.endsWith('.png'));
    if (!pngRequest.length) throw new Error('the subresource never reached the route');
    const pngResponse = responses.find((r) => r.url.endsWith('.png'));
    if (!pngResponse || pngResponse.status !== 200) throw new Error('the fulfilled response was not reported as 200');
    return `${requests.length} request(s) and ${responses.length} response(s) observed; ${pngRequest[0]} served from memory (${png.length} byte PNG, naturalWidth 4), nothing resolved on the network`;
  });

  await step(product, 'dialogs', async () => {
    const seen: string[] = [];
    const handler = async (dialog: any): Promise<void> => {
      seen.push(`${dialog.type()}:${dialog.message()}`);
      await dialog.accept();
    };
    page.on('dialog', handler);
    const returned = await page.evaluate(() => ({
      alerted: window.alert('pf-alert'),
      confirmed: window.confirm('pf-confirm'),
    }));
    await page.waitForTimeout(150);
    page.off('dialog', handler);
    if (!seen.includes('alert:pf-alert')) throw new Error(`alert was not captured: ${seen.join(' | ') || 'nothing'}`);
    if (!seen.includes('confirm:pf-confirm'))
      throw new Error(`confirm was not captured: ${seen.join(' | ') || 'nothing'}`);
    if (returned.confirmed !== true) throw new Error('an accepted confirm did not hand true back to the page');
    return `${seen.join(', ')} — accepted; page saw confirm=${String(returned.confirmed)}`;
  });

  await step(product, 'downloads', async () => {
    const { readFile } = await import('node:fs/promises');
    await page.goto('about:blank');
    await page.setContent(
      '<!doctype html><title>dl</title><button id="d">download</button>' +
        '<script>document.getElementById("d").addEventListener("click",function(){' +
        'var blob=new Blob(["pro-fetch probe"],{type:"text/plain"});var a=document.createElement("a");' +
        'a.href=URL.createObjectURL(blob);a.download="probe.txt";document.body.appendChild(a);a.click();});</script>',
      { waitUntil: 'domcontentloaded' },
    );
    const waiting = page.waitForEvent('download', { timeout: 10000 });
    await page.click('#d');
    const download = await waiting;
    const saved = path.join(dataRoot, download.suggestedFilename() || 'probe.txt');
    await download.saveAs(saved);
    const content = await readFile(saved, 'utf8');
    if (content !== 'pro-fetch probe') throw new Error(`downloaded file reads "${content}"`);
    return `"${download.suggestedFilename()}" received and read back (${content.length} bytes) through the browser's own download path`;
  });

  await step(product, 'uploads', async () => {
    const target = path.join(dataRoot, 'upload-me.txt');
    await writeFile(target, 'uploaded bytes');
    await page.setContent(
      '<!doctype html><title>up</title><input id="f" type="file"><div id="r"></div>' +
        '<script>document.getElementById("f").addEventListener("change",function(e){' +
        'var f=e.target.files[0];document.getElementById("r").textContent=f?f.name+":"+f.size:"none";});</script>',
      { waitUntil: 'domcontentloaded' },
    );
    await page.setInputFiles('#f', target);
    await page.waitForFunction(() => (document.getElementById('r') as HTMLElement).textContent !== '', null, {
      timeout: 8000,
    });
    const read = await page.evaluate(() => document.getElementById('r')?.textContent ?? '');
    if (read !== 'upload-me.txt:14') throw new Error(`the page saw "${read}"`);
    return `setInputFiles delivered ${read} to the page's change handler`;
  });

  await step(product, 'cookies', async () => {
    await serveFakeOrigin('<!doctype html><title>ck</title>');
    await page.goto(`${fakeOrigin}/cookies`);
    await page.evaluate(() => {
      document.cookie = 'pf_probe=1; path=/';
      document.cookie = 'pf_second=2; path=/';
    });
    const list = await (context as any).cookies(fakeOrigin);
    const names = list.map((c: any) => c.name).sort();
    if (!names.includes('pf_probe'))
      throw new Error(`cookies written by the page are not in the context jar: ${names.join(', ') || 'empty'}`);
    await (context as any).clearCookies({ name: 'pf_probe' });
    const after = (await (context as any).cookies(fakeOrigin)).map((c: any) => c.name);
    if (after.includes('pf_probe')) throw new Error('clearCookies left the cookie behind');
    await page.unroute(`${fakeOrigin}/**`);
    return `jar held ${names.join(', ')}; after clearCookies: ${after.join(', ') || 'empty'}`;
  });

  await step(product, 'storage', async () => {
    await serveFakeOrigin('<!doctype html><title>st</title>');
    await page.goto(`${fakeOrigin}/storage`);
    await page.evaluate(() => {
      localStorage.setItem('pf_local', 'value');
      sessionStorage.setItem('pf_session', 'temp');
    });
    const statePath = path.join(dataRoot, 'storage-state.json');
    await (context as any).storageState({ path: statePath });
    const { readFile } = await import('node:fs/promises');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    const origin = (state.origins ?? []).find((o: any) => o.origin === fakeOrigin);
    if (!origin)
      throw new Error(
        `storageState has no entry for ${fakeOrigin}: ${(state.origins ?? []).map((o: any) => o.origin).join(', ') || 'none'}`,
      );
    const keys = (origin.localStorage ?? []).map((e: any) => e.name);
    if (!keys.includes('pf_local')) throw new Error('localStorage did not survive into the state file');
    const live = await page.evaluate(() => ({
      local: localStorage.getItem('pf_local'),
      session: sessionStorage.getItem('pf_session'),
    }));
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    await page.unroute(`${fakeOrigin}/**`);
    return `state file carried ${keys.length} key(s) for ${fakeOrigin}; page reads local="${live.local}" session="${live.session}"`;
  });

  await step(product, 'tabs', async () => {
    const pagesOf = (): any[] => (context as any).pages();
    const before = pagesOf().length;
    const a = await context.newPage();
    await a.goto('about:blank');
    await a.setContent('<!doctype html><title>tab-a</title>');
    const b = await context.newPage();
    await b.setContent('<!doctype html><title>tab-b</title>');
    const titles: string[] = [];
    for (const p of pagesOf()) titles.push(await p.title().catch(() => '?'));
    const during = pagesOf().length;
    if (during !== before + 2) throw new Error(`expected ${before + 2} tabs, the context lists ${during}`);
    await b.close();
    const after = pagesOf().length;
    if (after !== during - 1) throw new Error('closing a tab did not remove it from the context');
    const driving = page.isClosed();
    await a.close();
    if (driving) throw new Error('the driving page reported itself closed while still being used');
    return `${before} → ${during} tabs [${titles.join(', ')}], closed one → ${after}, driver still alive`;
  });

  await step(product, 'viewport', async () => {
    await page.goto('about:blank');
    await page.setContent(SHOT_FIXTURE, { waitUntil: 'domcontentloaded' });
    await page.setViewportSize({ width: 375, height: 667 });
    const inner = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    const shot = await grabViewport();
    if (inner.w !== 375 || shot.width !== 375 || shot.height !== 667) {
      throw new Error(
        `emulation asked for 375x667 and produced innerWidth ${inner.w}, image ${shot.width}x${shot.height}`,
      );
    }
    // Geometry has to follow the new viewport, or a coordinate computed before it would be wrong.
    const moved = await page.locator('#b').boundingBox();
    await page.setViewportSize({ width: 1280, height: 720 });
    const restored = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    if (restored.w !== 1280) throw new Error(`viewport not restored: ${restored.w}x${restored.h}`);
    return `375x667 emulated, capture ${shot.width}x${shot.height}, button at ${Math.round(moved!.x)},${Math.round(moved!.y)}; restored to ${restored.w}x${restored.h}`;
  });

  await step(product, 'device-scale', async () => {
    const coords = await import('../src/core/browser-use-coordinates.js');
    const visual = await import('../src/core/browser-use-visual.js');
    const sharp = (await import('sharp')).default;
    const r = await launchManaged(product, {
      dataRoot: path.join(dataRoot, 'dpi2'),
      headless: true,
      deviceScaleFactor: 2,
    });
    if (!r.ok) throw new Error('second launch at 2× failed: ' + r.reason);
    try {
      const ctx: any = r.session.context;
      const p2 = ctx.pages()[0] ?? (await ctx.newPage());
      await p2.goto('about:blank');
      await p2.setContent(SHOT_FIXTURE, { waitUntil: 'domcontentloaded' });
      await p2.setViewportSize({ width: 800, height: 600 });
      const meta = await p2.evaluate(() => ({
        w: window.innerWidth,
        h: window.innerHeight,
        dpr: window.devicePixelRatio,
      }));
      if (meta.dpr !== 2) throw new Error(`asked for a 2× ratio, the page reports ${meta.dpr}`);
      const png = await p2.screenshot();
      const raw = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      if (raw.info.width !== meta.w * 2 || raw.info.height !== meta.h * 2) {
        throw new Error(
          `${meta.w}x${meta.h} css at dpr 2 produced ${raw.info.width}x${raw.info.height}, expected ${meta.w * 2}x${meta.h * 2}`,
        );
      }
      const box = (await p2.locator('#b').boundingBox())!;
      const image = { width: raw.info.width, height: raw.info.height, data: new Uint8Array(raw.data) };
      visual.assertRgba(image, '2× capture');
      const mapped = coords.boxInScreenshot(box, {
        kind: 'viewport',
        deviceScaleFactor: meta.dpr,
        image: { width: image.width, height: image.height },
        scroll: { x: 0, y: 0 },
      });
      const crop = visual.cropRgba(image, mapped);
      let blue = 0;
      for (let i = 0; i < crop.data.length; i += 4) if (crop.data[i + 2] > 180 && crop.data[i] < 90) blue++;
      const ratio = blue / (crop.width * crop.height);
      if (ratio < 0.6)
        throw new Error(`at 2× only ${Math.round(ratio * 100)}% of the mapped box was the button's blue`);
      return `dpr ${meta.dpr}: ${meta.w}x${meta.h} css → ${image.width}x${image.height} image; box maps to ${mapped.x},${mapped.y} ${mapped.width}x${mapped.height} with ${Math.round(ratio * 100)}% blue`;
    } finally {
      await (r.session.browser as any).close().catch(() => {});
    }
  });

  await step(product, 'attach-native', async () => {
    const { validateAttachEndpoint } = await import('../src/core/browser-use-registry.js');
    const playwright = await import('playwright');
    const port = product === 'chrome' ? 9333 : 9334;
    const endpoint = `http://127.0.0.1:${port}`;
    const verdict = validateAttachEndpoint(endpoint);
    if (!verdict.ok) throw new Error(`the validator refused its own loopback endpoint: ${verdict.reason}`);
    if (verdict.scheme !== 'http') throw new Error(`unexpected endpoint scheme ${verdict.scheme}`);
    const refused = validateAttachEndpoint('https://example.com/devtools');
    if (refused.ok) throw new Error('a public attach endpoint was accepted — that guard is the point of the validator');

    const r = await launchManaged(product, {
      dataRoot: path.join(dataRoot, 'native'),
      headless: true,
      debuggingPort: port,
    });
    if (!r.ok) throw new Error('launch with --remote-debugging-port failed: ' + r.reason);
    let attached: any = null;
    try {
      attached = await playwright.chromium.connectOverCDP(endpoint, { timeout: 20000 });
      const contexts: any[] = attached.contexts();
      if (!contexts.length) throw new Error('the attached connection reports no browser context');
      const p = contexts[0].pages()[0] ?? (await contexts[0].newPage());
      await p.goto('about:blank');
      await p.setContent('<!doctype html><title>attached</title><h1 id="h">native attach</h1>', {
        waitUntil: 'domcontentloaded',
      });
      const text = await p.evaluate(() => document.getElementById('h')?.textContent ?? '');
      if (text !== 'native attach') throw new Error(`attached connection read "${text}"`);
      const version: string = attached.version();
      await attached.close();
      attached = null;
      // The second connection is closed; the first one must still answer. That is the difference between
      // attaching to a browser and taking it over.
      const stillUsable = await page.evaluate(() => document.title);
      return `attached over CDP at ${endpoint} (browser ${version}), read "native attach" on the second connection; managed session still responds with title "${stillUsable}"; public endpoint refused: ${refused.reason.slice(0, 44)}`;
    } finally {
      if (attached) await attached.close().catch(() => {});
      await (r.session.browser as any).close().catch(() => {});
    }
  });

  await step(product, 'frames', async () => {
    const layer = await import('../src/core/browser-use-frames.js');
    const coords = await import('../src/core/browser-use-coordinates.js');
    const visual = await import('../src/core/browser-use-visual.js');
    // A `srcdoc` frame inherits the parent's origin, so its position is measurable from inside. The
    // cross-origin refusal that this cannot exercise is covered offline in browser-use-frames.test.ts.
    const INNER =
      '<!doctype html><html><body style="margin:0;background:#ffffff">' +
      '<button id="b" style="display:block;margin:40px 0 0 40px;width:120px;height:32px;background:#0040ff;border:0;color:#fff">Inside</button>' +
      '</body></html>';
    await page.goto('about:blank');
    await page.setContent(
      '<!doctype html><title>frames</title><body style="margin:0;background:#ffffff">' +
        `<iframe id="f" srcdoc="${INNER.replace(/"/g, '&quot;')}" style="display:block;margin:0 0 0 60px;width:320px;height:220px;border:0"></iframe>` +
        '</body>',
      { waitUntil: 'domcontentloaded' },
    );
    const collected = await layer.collectAllFrames(
      page,
      async (frame: any) => {
        const r = await frame.evaluate(COLLECTOR_SCRIPT);
        return { nodes: r.nodes, url: r.url, title: r.title };
      },
      async (frame: any) => {
        try {
          return await frame.evaluate(layer.HOP_SCRIPT);
        } catch (error) {
          return { ok: false, reason: String((error as Error).message).slice(0, 80) };
        }
      },
    );

    const nested = collected.frames.filter((f) => f.parentFrameId);
    if (!nested.length) throw new Error('the srcdoc iframe never appeared among the page frames');
    const inside = collected.nodes.find((n) => n.name === 'Inside');
    if (!inside)
      throw new Error(
        `no node from inside the frame; ${collected.nodes.length} collected, ${collected.unlifted.length} unlifted: ${collected.warnings.join(' | ')}`,
      );
    if (inside.frameId === 'main')
      throw new Error('a node from the iframe kept the top frame id — the collection rewrote nothing');
    const offset = collected.offsets.get(inside.frameId);
    if (!offset)
      throw new Error(
        `the iframe offset could not be measured: ${collected.warnings.join(' | ') || 'no reason given'}`,
      );
    if (Math.abs(offset.x - 60) > 2 || Math.abs(offset.y) > 2) {
      throw new Error(`the frame was placed at 60,0 and reported ${offset.x},${offset.y}`);
    }
    // The lifted box has to be where the pixels are, or the lift is arithmetic with no meaning.
    const shot = await grabViewport();
    const meta = await page.evaluate(() => ({
      w: window.innerWidth,
      h: window.innerHeight,
      dpr: window.devicePixelRatio,
    }));
    const mapped = coords.boxInScreenshot(inside.rect, {
      kind: 'viewport',
      deviceScaleFactor: meta.dpr,
      image: { width: shot.width, height: shot.height },
      scroll: { x: 0, y: 0 },
    });
    const crop = visual.cropRgba(shot, mapped);
    let blue = 0;
    for (let i = 0; i < crop.data.length; i += 4) if (crop.data[i + 2] > 180 && crop.data[i] < 90) blue++;
    const ratio = blue / (crop.width * crop.height);
    if (ratio < 0.6) {
      throw new Error(
        `the lifted box ${mapped.x},${mapped.y} ${mapped.width}x${mapped.height} was only ${Math.round(ratio * 100)}% button blue`,
      );
    }
    if (!inside.boundaries.some((b) => b.startsWith('iframe ')))
      throw new Error('the node crossed a frame boundary but records none');
    return `${layer.describeFrames(collected)}; frame ${inside.frameId} at ${Math.round(offset.x)},${Math.round(offset.y)}; lifted box ${mapped.x},${mapped.y} ${mapped.width}x${mapped.height} is ${Math.round(ratio * 100)}% blue; boundaries: ${inside.boundaries.join(' + ')}`;
  });

  await step(product, 'annotate', async () => {
    const coords = await import('../src/core/browser-use-coordinates.js');
    const visual = await import('../src/core/browser-use-visual.js');
    await page.goto('about:blank');
    await page.setContent(SHOT_FIXTURE, { waitUntil: 'domcontentloaded' });
    const meta = await page.evaluate(() => ({
      w: window.innerWidth,
      h: window.innerHeight,
      dpr: window.devicePixelRatio,
    }));
    const shot = await grabViewport();
    const snapshot = snap('ann-1', await page.evaluate(COLLECTOR_SCRIPT));
    const targets = snapshot.nodes.filter((n: any) => n.interactable);
    if (!targets.length) throw new Error('nothing interactable to annotate on a page with a button');
    const geometry = {
      kind: 'viewport' as const,
      deviceScaleFactor: meta.dpr,
      image: { width: shot.width, height: shot.height },
      scroll: { x: 0, y: 0 },
    };
    const specs = targets.map((n: any, i: number) => ({
      rect: coords.boxInScreenshot(n.rect, geometry),
      index: i + 1,
    }));
    const sourceBefore = shot.data.slice();
    const painted = visual.paintAnnotation(shot, specs, { thickness: 2, labelScale: 3 });
    if (painted.boxes !== specs.length)
      throw new Error(`${specs.length} annotations asked for, ${painted.boxes} boxes drawn`);
    if (painted.painted === 0) throw new Error('annotation reported drawing nothing');
    if ([...shot.data].some((v, i) => v !== sourceBefore[i]))
      throw new Error('paintAnnotation wrote into the capture it was given');

    const at = (image: any, x: number, y: number): number[] => {
      const o = (y * image.width + x) * 4;
      return [image.data[o], image.data[o + 1], image.data[o + 2], image.data[o + 3]];
    };
    const first = specs[0].rect;
    const corner = at(painted.image, first.x, first.y);
    if (corner[0] !== 0 || corner[1] !== 229 || corner[2] !== 255) {
      throw new Error(`the outline at ${first.x},${first.y} is ${corner.join(',')}, not the annotation cyan`);
    }
    // The element has to stay readable under its own annotation, or the picture stops being evidence.
    const centre = coords.centreOf(first);
    const insidePixel = at(painted.image, Math.round(centre.x), Math.round(first.y + first.height / 2));
    const blueInside = insidePixel[2] > 150 && insidePixel[0] < 120;
    if (!blueInside) throw new Error(`the middle of the annotated button reads ${insidePixel.join(',')}`);

    const d = visual.diffRgba(shot, painted.image, { channelTolerance: 0 });
    if (d.changedPixels === 0) throw new Error('the annotated image is byte-identical to the capture');
    if (d.changedPixels > painted.painted) {
      throw new Error(
        `the diff found ${d.changedPixels} changed pixels but the annotation wrote ${painted.painted} — something outside the annotation moved`,
      );
    }
    // Every changed pixel must sit inside one of the drawn boxes: an annotation that paints elsewhere is
    // a bug that will silently mislead a vision model.
    const inSomeBox = (x: number, y: number): boolean =>
      specs.some(
        (s) =>
          x >= s.rect.x - 4 &&
          x <= s.rect.x + s.rect.width + 4 &&
          y >= s.rect.y - 4 &&
          y <= s.rect.y + s.rect.height + 4,
      );
    let outside = 0;
    for (let i = 0; i < d.width * d.height; i++) {
      const o = i * 4;
      if (
        shot.data[o] === painted.image.data[o] &&
        shot.data[o + 1] === painted.image.data[o + 1] &&
        shot.data[o + 2] === painted.image.data[o + 2]
      )
        continue;
      if (!inSomeBox(i % d.width, Math.floor(i / d.width))) outside++;
    }
    if (outside > 0) throw new Error(`${outside} pixel(s) were painted outside every annotated box`);
    return `${painted.boxes} box(es) annotated, ${painted.painted} pixels written, diff found ${d.changedPixels} changed and ${outside} outside the boxes, button blue intact at ${Math.round(centre.x)},${Math.round(first.y + first.height / 2)}`;
  });

  // --- Phase 7: coverage ledger and safe state discovery ------------------------------
  await step(product, 'scan', async () => {
    const cov = await import('../src/core/browser-use-coverage.js');
    await page.goto('about:blank');
    await page.setContent(
      '<!doctype html><title>long</title><style>html,body{margin:0;background:#fff}.band{height:900px;border-top:1px solid #eee}' +
        '#bottom{display:block;margin:40px;width:160px;height:40px;background:#0040ff;border:0;color:#fff}</style>' +
        '<div class="band">top</div><div class="band">middle</div><div class="band">lower</div>' +
        '<button id="bottom">Bottom button</button>',
      { waitUntil: 'domcontentloaded' },
    );
    await page.evaluate(() => window.scrollTo(0, 0));
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    const first = snap('scan-0', await page.evaluate(COLLECTOR_SCRIPT));
    if (first.nodes.some((n: any) => n.name === 'Bottom button' && n.inViewport)) {
      throw new Error(
        'the fixture is short enough to show its bottom button in the first viewport — this scan would prove nothing',
      );
    }
    let ledger = cov.createLedger(first, { contentHeight: height, maxSteps: 20 });
    const bandsAtStart = ledger.bands.length;
    let snapshot = first;
    let guard = 0;
    while (guard++ < 24) {
      const plan = cov.planScan(ledger, { maxSteps: 2 });
      if (!plan.scrolls.length) break;
      const before = ledger.bands.filter((b) => b.visitedAt !== null).length;
      for (const y of plan.scrolls) {
        await page.evaluate((target: number) => window.scrollTo(0, target), y);
        snapshot = snap(`scan-${guard}-${y}`, await page.evaluate(COLLECTOR_SCRIPT));
        ledger = cov.recordSnapshot(ledger, snapshot);
      }
      const after = ledger.bands.filter((b) => b.visitedAt !== null).length;
      if (after === before) {
        throw new Error(
          `the scan read ${plan.scrolls.join(' , ')} and no band became fully covered (${plan.reason}); gaps: ${ledger.gaps.join(' | ')}`,
        );
      }
    }
    const ratio = cov.coverageRatio(ledger);
    if (ratio !== 1)
      throw new Error(
        `the scan stopped at ${Math.round((ratio ?? 0) * 100)}% band coverage; gaps: ${ledger.gaps.join(' | ')}`,
      );
    if (cov.complete(ledger) !== true)
      throw new Error(`bands are full but the ledger says incomplete: ${ledger.gaps.join('; ')}`);
    if (!snapshot.nodes.some((n: any) => n.name === 'Bottom button' && n.inViewport)) {
      throw new Error('the ledger claims full band coverage while the bottom button was never inside a read viewport');
    }
    const visitedBands = ledger.bands.filter((b) => b.visitedAt !== null).length;
    if (visitedBands < 2)
      throw new Error(`the scan visited ${visitedBands} band(s) on a ${height}px page — it did not move`);
    if (ledger.budget.stepsSpent < 2)
      throw new Error(`the scan spent ${ledger.budget.stepsSpent} read(s) for ${bandsAtStart} bands`);
    const described = cov.describeLedger(ledger, 2000).text;
    if (/never visited/.test(described))
      throw new Error(`describeLedger still reports an unvisited band:\n${described}`);
    return `${visitedBands}/${bandsAtStart} bands of ${height}px covered in ${ledger.budget.stepsSpent} reads, ${ledger.identities.size} identities known, bottom button entered the viewport only after scrolling; complete=${cov.complete(ledger)}`;
  });

  await step(product, 'state-discovery', async () => {
    const cov = await import('../src/core/browser-use-coverage.js');
    await page.goto('about:blank');
    await page.setContent(
      '<!doctype html><title>disclosure</title><details id="d"><summary>Shipping options</summary><p id="p">Free returns within 30 days</p></details>',
      { waitUntil: 'domcontentloaded' },
    );
    const closed = snap('sd-1', await page.evaluate(COLLECTOR_SCRIPT));
    const panelIn = (s: any): number =>
      s.nodes.filter((n: any) => n.tag === 'p' && /Free returns/.test(n.text || '')).length;
    if (panelIn(closed) !== 0) {
      throw new Error(
        `the panel element was collected while the disclosure was closed (${panelIn(closed)} node(s)) — the collector is not hiding it`,
      );
    }
    const summary = closed.nodes.find((n: any) => n.tag === 'summary');
    const details = closed.nodes.find((n: any) => n.tag === 'details');
    if (!summary || !details) throw new Error(`no summary/details pair in the snapshot (${closed.nodes.length} nodes)`);
    if (details.state.expanded !== false)
      throw new Error(
        `a closed <details> reported expanded=${String(details.state.expanded)} — the collector is not reading open`,
      );

    const candidates = cov.revealCandidates(closed);
    const offered = candidates.find((c) => c.identity === details.identity);
    if (!offered) {
      throw new Error(
        `a visible closed disclosure was not offered: ${candidates.map((c) => `${c.label}/${c.safety}`).join(', ') || 'no candidates'}`,
      );
    }
    if (offered.safety !== 'SAFE_REVERSIBLE' || offered.restore !== 'collapse it again') {
      throw new Error(`the closed disclosure was classified ${offered.safety}: ${offered.reason}`);
    }

    await page.evaluate(() => {
      (document.getElementById('d') as HTMLDetailsElement).open = true;
    });
    const open = snap('sd-2', await page.evaluate(COLLECTOR_SCRIPT));
    if (panelIn(open) !== 1)
      throw new Error(`expanding the disclosure produced ${panelIn(open)} panel node(s), expected 1`);
    const summaryAfter = open.nodes.find((n: any) => n.tag === 'summary');
    if (!summaryAfter || summaryAfter.identity !== summary.identity) {
      throw new Error(
        'the summary changed identity across a toggle — its lifetime token did not survive, so targets would go stale for no reason',
      );
    }

    await page.evaluate(() => {
      (document.getElementById('d') as HTMLDetailsElement).open = false;
    });
    const restored = snap('sd-3', await page.evaluate(COLLECTOR_SCRIPT));
    if (panelIn(restored) !== 0)
      throw new Error(
        `the reveal was not reversible: ${panelIn(restored)} panel node(s) still collected after closing`,
      );
    const stillOffered = cov.revealCandidates(restored).find((c) => c.identity === details.identity);
    if (stillOffered?.safety !== 'SAFE_REVERSIBLE') {
      throw new Error(
        'after closing, the disclosure stopped being an offered candidate — a later scan would forget it can be opened',
      );
    }
    return `${offered.kind}/${offered.safety}: panel appeared then disappeared, summary identity ${summary.identity} stable across both toggles`;
  });

  await step(product, 'close', async () => {
    await (session as { browser: { close(): Promise<void> } }).browser.close();
    return 'closed';
  });
}

await rm(dataRoot, { recursive: true, force: true });

const artifact = path.join(process.cwd(), 'benchmarks', 'browser-use', 'artifacts');
await writeFile(
  path.join(artifact, `probe-${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
  JSON.stringify({ os, started, ms: Date.now() - started, results }, null, 2),
  {
    recursive: true,
  },
).catch(async () => {
  // The artifact directory does not exist yet in this phase; create it and retry once rather than
  // losing the evidence the whole run was for.
  const { mkdir } = await import('node:fs/promises');
  await mkdir(artifact, { recursive: true });
  await writeFile(
    path.join(artifact, `probe-${Date.now()}.json`),
    JSON.stringify({ os, started, ms: Date.now() - started, results }, null, 2),
  );
});

for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.product.padEnd(18)} ${r.step.padEnd(14)} ${r.ms}ms  ${r.detail}`);
}
const passed = results.filter((r) => r.ok).length;
console.log(`# ${passed}/${results.length} probe steps passed in ${Date.now() - started}ms`);
