/**
 * A live demonstration of the browser_use engine, not a test and not a benchmark.
 *
 * It opens one real page, reads it, scrolls until the coverage ledger has seen the whole document, then
 * writes two PNGs and a short report: the raw capture, and the same capture with the engine's own
 * annotation painter applied to the elements it considered actionable. The point is to leave something a
 * person can look at, so the claims in the tool output can be checked against a picture.
 *
 * Usage: npx tsx scripts/browser-use-demo.mts <output-dir> [url]
 */

import { mkdir, writeFile } from 'node:fs/promises';
import process from 'node:process';

const { openSession, closeSession, capture, scrollTo, refresh } = await import('../src/core/browser-use-session.js');
const { coverageRatio, planScan } = await import('../src/core/browser-use-coverage.js');
const { groupObjects } = await import('../src/core/browser-use-objects.js');
const { boxInScreenshot } = await import('../src/core/browser-use-coordinates.js');
const { paintAnnotation } = await import('../src/core/browser-use-visual.js');

/** The RGBA shape the visual module works on, declared locally so this stays a plain dynamic import. */
interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

const OUT = process.argv[2] ?? '.';
const URL = process.argv[3] ?? 'https://en.wikipedia.org/wiki/HTTP';

await mkdir(OUT, { recursive: true });
const sharp = (await import('sharp')).default;

const lines: string[] = [];
const log = (text: string): void => {
  lines.push(text);
  console.log(text);
};

const session = await openSession({ url: URL, headless: true, viewport: { width: 1280, height: 800 } });
try {
  log(`session ${session.id} · ${session.browser.product} ${session.browser.version} over ${session.protocol}`);
  log(
    `first read: ${session.model.latest.nodes.length} nodes, page height ${session.ledger?.contentHeight}px, document ${session.model.documentSignature}`,
  );
  log(`band coverage before scanning: ${Math.round((coverageRatio(session.ledger!) ?? 0) * 100)}%`);

  let guard = 0;
  while (guard++ < 40) {
    const plan = planScan(session.ledger!, { maxSteps: 3 });
    if (!plan.scrolls.length) break;
    const before = session.ledger!.bands.filter((b) => b.visitedAt !== null).length;
    for (const y of plan.scrolls) await scrollTo(session, y);
    if (session.ledger!.bands.filter((b) => b.visitedAt !== null).length === before) break;
  }
  log(`band coverage after scanning: ${Math.round((coverageRatio(session.ledger!) ?? 0) * 100)}%`);
  log(`identities the model has accumulated: ${session.model.nodes.size}`);

  await scrollTo(session, 0);
  await refresh(session, { budget: 400 });
  const snapshot = session.model.latest;
  const png = await capture(session, 'viewport');
  const raw = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const image: RgbaImage = { width: raw.info.width, height: raw.info.height, data: new Uint8Array(raw.data) };
  const geometry = {
    kind: 'viewport' as const,
    deviceScaleFactor: snapshot.deviceScaleFactor,
    image: { width: image.width, height: image.height },
    scroll: snapshot.scroll,
  };
  const picked = snapshot.nodes.filter((n) => n.interactable).slice(0, 14);
  const specs = picked.map((n) => ({ rect: boxInScreenshot(n.rect, geometry), index: snapshot.nodes.indexOf(n) + 1 }));
  const painted = paintAnnotation(image, specs, { thickness: 2, labelScale: 3 });
  await writeFile(
    `${OUT}/browser-use-annotated.png`,
    await sharp(Buffer.from(painted.image.data), { raw: { width: image.width, height: image.height, channels: 4 } })
      .png()
      .toBuffer(),
  );
  await writeFile(`${OUT}/browser-use-raw.png`, png);
  log(
    `capture ${image.width}x${image.height} at dpr ${snapshot.deviceScaleFactor}; annotated ${painted.boxes} elements, ${painted.painted} pixels drawn`,
  );

  const groups = groupObjects(snapshot);
  log(`structural groups found: ${groups.map((g) => `${g.kind}(${g.members.length})`).join(', ') || 'none'}`);
  log(
    'labelled elements: ' +
      picked
        .slice(0, 8)
        .map((n) => `${n.role || n.tag} ${(n.name || n.text).slice(0, 24)}`)
        .join(' · '),
  );
} finally {
  await closeSession(session.id);
  log('session closed; its temporary profile was deleted');
}

const report = [
  '# browser_use — live run',
  '',
  `Page: \`${URL}\``,
  '',
  ...lines.map((l) => `- ${l}`),
  '',
  "`browser-use-annotated.png` is the raw capture with the engine's own painter applied: every box is an",
  'element the perception layer reported as actionable, mapped from CSS viewport pixels into image pixels by',
  'the coordinate module, numbered with the index the outline would quote. Interiors are left untouched, so',
  'an element stays readable under its own annotation.',
  '',
].join(String.fromCharCode(10));
await writeFile(`${OUT}/browser-use-run.md`, report, 'utf8');
console.log('\nwrote browser-use-annotated.png, browser-use-raw.png, browser-use-run.md');
