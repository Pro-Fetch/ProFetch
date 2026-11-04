/**
 * The coordinate map: every element and every word on a real page, with its box, drawn and written.
 *
 * This is the demonstration the two newest tools were built for, and it is deliberately not a unit test. A
 * unit test can prove `findPhrase` unions four boxes correctly; it cannot prove that a real page's real word
 * boxes land on the real ink, or that a coordinate printed next to a button is the coordinate a click needs.
 *
 * Three artefacts come out, and they answer three different questions:
 *   elements.csv / words.csv   — the numbers, every row, no budget applied
 *   map-elements.png           — every box drawn on the picture, with its own coordinates beside it
 *   map-words.png              — the same for text, which no element box can express
 *
 * Run: npx tsx scripts/browser-use-coordinate-map.mts <out-dir> [url]
 */

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { AnnotationSpec, Rgba, RgbaImage } from '../src/core/browser-use-visual.js';

const { openSession, closeSession, readWords, refresh, capture } = await import('../src/core/browser-use-session.js');
const { selectNodes, elementRows, summarizeRows, placeRect } = await import('../src/core/browser-use-elements.js');
const { buildWordRows, findPhrase, summarizeWords } = await import('../src/core/browser-use-words.js');
const { boxInScreenshot } = await import('../src/core/browser-use-coordinates.js');
const { paintAnnotation, cropRgba } = await import('../src/core/browser-use-visual.js');

const OUT = path.resolve(process.argv[2] ?? '.');
const TARGET = process.argv[3] ?? 'https://en.wikipedia.org/wiki/HTTP';
const sharp = (await import('sharp')).default;

const log: string[] = [];
function say(line: string): void {
  console.log(line);
  log.push(line);
}

await mkdir(OUT, { recursive: true });
say(`# coordinate map — ${new Date().toISOString()}`);
say(`target: ${TARGET}`);

const session = await openSession({
  url: TARGET,
  headless: true,
  viewport: { width: 1280, height: 800 },
  budget: 6000,
});
say(`session ${session.id} in ${session.browser.product} ${session.browser.version || '(version unreadable)'}`);

// A fresh read at a high budget. The default 400-node snapshot is right for choosing a target and wrong for
// a listing that promises "every element", and the in-page walk ceiling follows this number — asking for 6000
// nodes is what lets the collector look for 4000 elements instead of stopping at its default.
const first = await refresh(session, { budget: 6000 });
const snapshot = first.snapshot;
// The walk reports its own ceiling. `truncated` is about the caller's node budget; `walk.capped` is about
// the collector having to stop scanning at all — and only the second one tells you the listing is not the
// whole page. Saying "none dropped" because the budget was never hit would be true and useless.
const walk = snapshot.walk ?? { scanned: snapshot.nodes.length, reported: snapshot.nodes.length, capped: false };
say(
  `read: ${snapshot.nodes.length} node(s) reported of ${walk.scanned} element(s) in the document` +
    `${walk.capped ? ' — the collector STOPPED at its element ceiling, so this listing is not every element on the page' : ' — the walk finished the document'}` +
    `${snapshot.truncated ? `, ${snapshot.truncated} dropped by the node budget` : ''}` +
    ` — viewport ${snapshot.viewport.width}x${snapshot.viewport.height}, dpr ${snapshot.deviceScaleFactor}`,
);

const rows = elementRows(selectNodes(snapshot, { filter: 'all' }), snapshot);
const stats = summarizeRows(rows, 'all');
say(
  `elements: ${stats.matched} boxed, ${stats.clickable} clickable now, ${stats.covered} covered, ${stats.off_viewport} outside the viewport`,
);

/** A CSV that carries the same box in every space a caller might need it in. */
function csvCell(value: string | number | boolean): string {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const elementCsv = [
  'index,tag,role,name_or_text,css_viewport_x,css_viewport_y,w,h,centre_x,centre_y,css_page_y,full_page_image_x,full_page_image_y,in_viewport,interactable,owns_centre,identity,node_id,token',
  ...rows.map((r) => {
    const page = placeRect(r.rect, 'css-page', snapshot);
    const shot = placeRect(r.rect, 'image-page-device', snapshot);
    return [
      r.index,
      r.tag,
      r.role,
      (r.name || r.text).slice(0, 60),
      r.rect.x,
      r.rect.y,
      r.rect.width,
      r.rect.height,
      r.centre.x.toFixed(1),
      r.centre.y.toFixed(1),
      page.y.toFixed(1),
      shot.x,
      shot.y,
      r.in_viewport,
      r.interactable,
      r.owns_centre,
      r.identity,
      r.backend_id,
      r.token,
    ]
      .map(csvCell)
      .join(',');
  }),
].join('\n');
await writeFile(path.join(OUT, 'elements.csv'), elementCsv, 'utf8');
say(`wrote elements.csv (${rows.length} rows)`);

const report = await readWords(session, { cap: 12000 });
const words = buildWordRows(report, snapshot.nodes);
const wordStats = summarizeWords(words);
say(
  `words: ${wordStats.words} measured, ${wordStats.in_viewport} in the viewport, ${wordStats.wrapped} broken across a line, ` +
    `${wordStats.unowned} with no stamped owner, ${report.truncated} past the cap, ${report.unmeasured} with no box`,
);

const wordCsv = [
  'index,word,owner_element,owner_tag,owner_identity,x,y,w,h,centre_x,centre_y,line_fragments,in_viewport,chars_in_text_node',
  ...words.map((w) =>
    [
      w.index,
      w.text,
      w.owner_backend_id ?? '',
      w.owner_tag,
      w.owner_identity ?? '',
      w.rect.x,
      w.rect.y,
      w.rect.width,
      w.rect.height,
      w.centre.x.toFixed(1),
      w.centre.y.toFixed(1),
      w.parts,
      w.in_viewport,
      `${w.chars[0]}-${w.chars[1]}`,
    ]
      .map(csvCell)
      .join(','),
  ),
].join('\n');
await writeFile(path.join(OUT, 'words.csv'), wordCsv, 'utf8');
say(`wrote words.csv (${words.length} rows)`);

/**
 * One phrase, resolved to a box, and checked against the element that contains it.
 *
 * This is the assertion that matters most in the whole run: a word box that does not sit inside the box of
 * its own element is a measurement of something else. The browser's own layout engine is the referee.
 */
const candidates = rows
  .filter((r) => /^h[1-6]$/.test(r.tag) && r.text.trim().length > 3)
  .filter((r) => words.some((w) => w.owner_backend_id === r.backend_id))
  .sort((a, b) => b.depth - a.depth);
// On screen first: a phrase resolved off-viewport is a correct measurement that nobody can see in the
// picture, and the picture is the point of this run.
const heading = candidates.find((r) => r.in_viewport) ?? candidates[0];
if (heading) {
  const phrase = (heading.name || heading.text).trim().split(/\s+/).slice(0, 3).join(' ');
  const hit = findPhrase(words, phrase);
  say(
    `heading #${heading.index} <${heading.tag}> "${(heading.text || heading.name).slice(0, 40)}" ` +
      `box ${Math.round(heading.rect.x)},${Math.round(heading.rect.y)} ` +
      `${Math.round(heading.rect.width)}x${Math.round(heading.rect.height)}${heading.in_viewport ? ' (on screen)' : ' (OFF screen)'}`,
  );
  if (!hit) {
    say(`phrase "${phrase}": NOT FOUND — the listing says the heading holds these words, the word pass says otherwise`);
  } else {
    const inside =
      hit.rect.x >= heading.rect.x - 2 &&
      hit.rect.y >= heading.rect.y - 2 &&
      hit.rect.x + hit.rect.width <= heading.rect.x + heading.rect.width + 2 &&
      hit.rect.y + hit.rect.height <= heading.rect.y + heading.rect.height + 2;
    say(
      `phrase "${phrase}": box ${Math.round(hit.rect.x)},${Math.round(hit.rect.y)} ` +
        `${Math.round(hit.rect.width)}x${Math.round(hit.rect.height)} over words #${hit.from}…#${hit.to}, ` +
        `${hit.occurrences} occurrence(s), ${inside ? 'inside its own element' : 'OUTSIDE the element that reports it'}`,
    );
  }
} else {
  say('phrase: no heading with its own words in this read — nothing to check');
}

const png = await capture(session, 'viewport');
const geometry = {
  kind: 'viewport' as const,
  deviceScaleFactor: snapshot.deviceScaleFactor,
  image: { width: snapshot.viewport.width, height: snapshot.viewport.height },
  scroll: snapshot.scroll,
};
const raw = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const image = { width: raw.info.width, height: raw.info.height, data: new Uint8Array(raw.data) };

function coord(rect: { x: number; y: number; width: number; height: number }): string {
  return `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`;
}

/** Boxes plus the number plus the coordinates: the picture the request asked for. */
async function drawOn(
  target: RgbaImage,
  specs: AnnotationSpec[],
  file: string,
  options: { coordinates: boolean; scale: number },
): Promise<void> {
  const painted = paintAnnotation(target, specs, { thickness: 1, labelScale: options.scale });
  const buffer = await sharp(Buffer.from(painted.image.data), {
    raw: { width: painted.image.width, height: painted.image.height, channels: 4 },
  })
    .png()
    .toBuffer();
  await writeFile(path.join(OUT, file), buffer);
  say(
    `wrote ${file}: ${painted.boxes} box(es) drawn, ${painted.labelsDrawn} number(s) legible, ` +
      `${painted.labelsOutside} label(s) off the image, ${painted.labelsCollided} label(s) with no free space ` +
      `(${painted.painted} pixel(s) painted at ${options.scale}x digit scale; every boxed row is in the CSV whatever the picture can show)` +
      `${options.coordinates ? ' — coordinate line skipped whole when it would be cut, never truncated' : ''}`,
  );
}

const elementSpecs: AnnotationSpec[] = rows
  .filter((r) => r.in_viewport)
  .map((r) => {
    const box = boxInScreenshot(r.rect, geometry);
    return { rect: box, index: r.index, label: coord(box) };
  })
  .filter((spec) => spec.rect.width > 0 && spec.rect.height > 0);
await drawOn(image, elementSpecs, 'map-elements.png', { coordinates: true, scale: 1 });

const wordSpecs: AnnotationSpec[] = words
  .filter((w) => w.in_viewport)
  .flatMap((w) =>
    w.fragments.map((fragment) => ({
      rect: boxInScreenshot(fragment, geometry),
      index: w.index,
      colour: [255, 0, 255, 255] as Rgba,
      label: coord(boxInScreenshot(fragment, geometry)),
    })),
  )
  .filter((spec) => spec.rect.width > 0 && spec.rect.height > 0);
await drawOn(image, wordSpecs, 'map-words.png', { coordinates: true, scale: 1 });

/**
 * The zoom: one paragraph, cropped and enlarged, so a coordinate is readable.
 *
 * The full-page word picture proves that every word was measured; it cannot prove the numbers are readable,
 * because a coordinate plate is about as wide as the word it describes. Enlarging the crop gives every plate
 * its own room at the same digit scale, and it exercises the crop path the element-capture tool uses.
 */
const wordsByOwner = new Map<string, number>();
for (const w of words) {
  if (!w.in_viewport || !w.owner_backend_id) continue;
  wordsByOwner.set(w.owner_backend_id, (wordsByOwner.get(w.owner_backend_id) ?? 0) + 1);
}
const busiest = rows
  .filter((r) => r.in_viewport && wordsByOwner.has(r.backend_id))
  .sort((a, b) => (wordsByOwner.get(b.backend_id) ?? 0) - (wordsByOwner.get(a.backend_id) ?? 0))[0];
if (busiest) {
  const box = boxInScreenshot(busiest.rect, geometry);
  const region = {
    x: Math.max(0, Math.min(box.x, image.width - 2)),
    y: Math.max(0, Math.min(box.y, image.height - 2)),
    width: Math.max(1, Math.min(box.width, image.width)),
    height: Math.max(1, Math.min(box.height, image.height)),
  };
  region.width = Math.min(region.width, image.width - region.x);
  region.height = Math.min(region.height, image.height - region.y);
  const crop = cropRgba(image, region);
  const ZOOM = 2;
  const upscaled = await sharp(Buffer.from(crop.data), {
    raw: { width: crop.width, height: crop.height, channels: 4 },
  })
    .resize(crop.width * ZOOM, crop.height * ZOOM, { kernel: 'nearest' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const zoomImage: RgbaImage = {
    width: upscaled.info.width,
    height: upscaled.info.height,
    data: new Uint8Array(upscaled.data),
  };
  const inside = words
    .filter((w) => w.in_viewport && w.owner_backend_id === busiest.backend_id)
    .flatMap((w) =>
      w.fragments
        .map((fragment) => boxInScreenshot(fragment, geometry))
        .filter((f) => f.x >= region.x - 1 && f.y >= region.y - 1 && f.x + f.width <= region.x + region.width + 1)
        .map((f) => ({
          // The drawn rect lives in the enlarged crop; the printed number stays in the capture's own pixels.
          rect: {
            x: (f.x - region.x) * ZOOM,
            y: (f.y - region.y) * ZOOM,
            width: f.width * ZOOM,
            height: f.height * ZOOM,
          },
          index: w.index,
          colour: [255, 0, 255, 255] as Rgba,
          label: coord(f),
        })),
    );
  say(
    `zoom region: element #${busiest.index} <${busiest.tag}> at ${region.x},${region.y} ${region.width}x${region.height} ` +
      `image px, enlarged to ${zoomImage.width}x${zoomImage.height} (${ZOOM}x), ` +
      `${wordsByOwner.get(busiest.backend_id) ?? 0} word(s) of it measured, ${inside.length} fragment box(es) drawn`,
  );
  await drawOn(zoomImage, inside, 'map-region-zoom.png', { coordinates: true, scale: 1 });
}

await writeFile(path.join(OUT, 'coordinate-map-run.md'), log.join('\n') + '\n', 'utf8');
await closeSession(session.id);
say(`session closed; ${log.length} line(s) of run log kept in coordinate-map-run.md`);
