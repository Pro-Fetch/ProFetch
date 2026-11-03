/**
 * Visual comparison, over decoded pixels rather than over files.
 *
 * A screenshot is the only source that can answer "did the page actually change", and the mistake this
 * area makes is comparing PNG bytes (so a re-encode looks like a change), comparing every pixel with a
 * threshold of zero (so antialiasing makes every text render a diff), or returning a percentage without
 * saying *where* (so "0.3% changed" is useless to an agent that needs to know whether its click worked).
 *
 * Everything here takes raw RGBA buffers — `Uint8Array` with 4 bytes per pixel, row-major — because
 * decoding is the caller's business (Playwright hands back PNG, this repository has `sharp` and
 * `@napi-rs/canvas` for that). Keeping the comparison pure means these numbers are testable in a
 * millisecond without a browser, an encoder, or a fixture image.
 */

export interface RgbaImage {
  width: number;
  height: number;
  /** 4 bytes per pixel: R, G, B, A. Length must be `width * height * 4`. */
  data: Uint8Array;
}

export interface DiffOptions {
  /**
   * Per-channel tolerance, 0–255. Default 16: enough to swallow font-smoothing and a JPEG-ish repaint,
   * small enough that a colour change on a button is still a change.
   */
  channelTolerance?: number;
  /**
   * Treat two pixels as equal when their *alpha* differs but their colours do not (0 = off). Default true:
   * a transparent repaint should not read as a visual change.
   */
  ignoreAlphaOnly?: boolean;
  /** Split the image into a grid and count changed pixels per cell, so the answer has a *where*. */
  grid?: { columns: number; rows: number };
  /** A cell is "hot" when at least this fraction of its pixels changed. Default 0.02. */
  hotCellRatio?: number;
}

export interface DiffRegion {
  /** Cell index in row-major order. */
  cell: number;
  column: number;
  row: number;
  box: { x: number; y: number; width: number; height: number };
  changedPixels: number;
  /** Changed pixels over the cell's own pixel count. */
  ratio: number;
  hot: boolean;
}

export interface DiffResult {
  comparable: boolean;
  /** Why two images could not be compared, in a sentence. Only set when `comparable` is false. */
  reason?: string;
  width: number;
  height: number;
  comparedPixels: number;
  changedPixels: number;
  changedRatio: number;
  /** Tightest box around every changed pixel, in image pixels. Null when nothing changed. */
  boundingBox: { x: number; y: number; width: number; height: number } | null;
  /** The single largest per-channel difference, useful for "is this a colour change or noise?". */
  maxChannelDelta: number;
  regions: DiffRegion[];
  hotRegions: DiffRegion[];
  /** Pixels ignored because they differ only in alpha (reported, not silently dropped). */
  alphaOnlyDifferences: number;
}

const NOT_COMPARABLE = (a: RgbaImage, b: RgbaImage): string =>
  `screenshots are ${a.width}x${a.height} and ${b.width}x${b.height}; a resized capture is not a visual change, it is a different capture`;

export function pixelCount(image: RgbaImage): number {
  return image.width * image.height;
}

/** Fail loudly at the boundary rather than comparing a buffer against its own overflow. */
export function assertRgba(image: RgbaImage, what = 'image'): void {
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width <= 0 || image.height <= 0) {
    throw new Error(`${what} has impossible dimensions ${image.width}x${image.height}`);
  }
  const expected = image.width * image.height * 4;
  if (image.data.length < expected) {
    throw new Error(
      `${what} is ${image.width}x${image.height} but its buffer holds ${image.data.length} bytes, ${expected} needed`,
    );
  }
}

/**
 * Compare two captures.
 *
 * Dimension mismatch is reported, not resampled. An agent that resized the window will otherwise read a
 * 40% "change" and conclude the page changed when only the viewport did.
 */
export function diffRgba(a: RgbaImage, b: RgbaImage, options: DiffOptions = {}): DiffResult {
  assertRgba(a, 'before');
  assertRgba(b, 'after');
  const tolerance = options.channelTolerance ?? 16;
  const ignoreAlphaOnly = options.ignoreAlphaOnly ?? true;
  const empty: DiffResult = {
    comparable: false,
    width: a.width,
    height: a.height,
    comparedPixels: 0,
    changedPixels: 0,
    changedRatio: 0,
    boundingBox: null,
    maxChannelDelta: 0,
    regions: [],
    hotRegions: [],
    alphaOnlyDifferences: 0,
  };
  if (a.width !== b.width || a.height !== b.height) {
    return { ...empty, reason: NOT_COMPARABLE(a, b) };
  }

  const width = a.width;
  const height = a.height;
  const total = width * height;
  let changed = 0;
  let alphaOnly = 0;
  let maxDelta = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  // One flat array of per-cell counts; the grid is a report, not a second pass over the pixels.
  const columns = Math.max(1, Math.min(options.grid?.columns ?? 4, width));
  const rows = Math.max(1, Math.min(options.grid?.rows ?? 4, height));
  const cellChanged = new Uint32Array(columns * rows);

  const mark = (i: number): void => {
    const x = i % width;
    const y = (i / width) | 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    const cx = Math.min(columns - 1, ((x * columns) / width) | 0);
    const cy = Math.min(rows - 1, ((y * rows) / height) | 0);
    cellChanged[cy * columns + cx]++;
  };

  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const dr = Math.abs(a.data[o] - b.data[o]);
    const dg = Math.abs(a.data[o + 1] - b.data[o + 1]);
    const db = Math.abs(a.data[o + 2] - b.data[o + 2]);
    const da = Math.abs(a.data[o + 3] - b.data[o + 3]);
    const colourDelta = Math.max(dr, dg, db);
    maxDelta = Math.max(maxDelta, colourDelta, da);
    if (colourDelta <= tolerance) {
      if (da > tolerance) {
        alphaOnly++;
        // A pixel that kept its colour but lost or gained opacity is a repaint, not a visual change — but
        // that is a policy, so the caller can turn it off and the count is reported either way.
        if (!ignoreAlphaOnly) {
          changed++;
          mark(i);
        }
      }
      continue;
    }
    changed++;
    mark(i);
  }

  const cellWidth = Math.ceil(width / columns);
  const cellHeight = Math.ceil(height / rows);
  const hotRatio = options.hotCellRatio ?? 0.02;
  const regions: DiffRegion[] = [];
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < columns; cx++) {
      const box = {
        x: cx * cellWidth,
        y: cy * cellHeight,
        width: Math.min(cellWidth, width - cx * cellWidth),
        height: Math.min(cellHeight, height - cy * cellHeight),
      };
      const pixels = box.width * box.height || 1;
      const count = cellChanged[cy * columns + cx];
      regions.push({
        cell: cy * columns + cx,
        column: cx,
        row: cy,
        box,
        changedPixels: count,
        ratio: count / pixels,
        hot: count / pixels >= hotRatio,
      });
    }
  }

  return {
    comparable: true,
    width,
    height,
    comparedPixels: total,
    changedPixels: changed,
    changedRatio: total ? changed / total : 0,
    boundingBox: maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
    maxChannelDelta: maxDelta,
    regions,
    hotRegions: regions.filter((r) => r.hot),
    alphaOnlyDifferences: alphaOnly,
  };
}

/** Crop, in image pixels. Out-of-bounds requests fail rather than returning a smaller image silently. */
export function cropRgba(image: RgbaImage, box: { x: number; y: number; width: number; height: number }): RgbaImage {
  assertRgba(image, 'crop source');
  if (
    box.x < 0 ||
    box.y < 0 ||
    box.width <= 0 ||
    box.height <= 0 ||
    box.x + box.width > image.width ||
    box.y + box.height > image.height
  ) {
    throw new Error(
      `crop ${box.x},${box.y} ${box.width}x${box.height} does not fit a ${image.width}x${image.height} image — a clamped crop would silently change what is being compared`,
    );
  }
  const out = new Uint8Array(box.width * box.height * 4);
  for (let y = 0; y < box.height; y++) {
    const srcStart = ((box.y + y) * image.width + box.x) * 4;
    out.set(image.data.subarray(srcStart, srcStart + box.width * 4), y * box.width * 4);
  }
  return { width: box.width, height: box.height, data: out };
}

/** A uniform grey image, for tests, masks and "nothing here" placeholders. */
export function solidRgba(width: number, height: number, rgba: [number, number, number, number]): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgba[0];
    data[i + 1] = rgba[1];
    data[i + 2] = rgba[2];
    data[i + 3] = rgba[3];
  }
  return { width, height, data };
}

/**
 * Annotating a capture with pixels, not just markup.
 *
 * A model shown a screenshot needs the same index the outline gave it, drawn where the element is, and
 * often the element's coordinates too. Text would mean a font rasterizer, so the glyphs are a 3×5 bitmap:
 * digits plus comma, period and minus — enough to draw `400 · 568,640` with no dependency, and small
 * enough to check by eye. Anything outside that set is skipped and counted rather than approximated.
 *
 * Every write is bounds-checked on both axes. Adding `y * width + x` to an offset that ran past the row
 * end paints last-row pixels at the start of the next row, which looks like a drawing glitch and is
 * actually a corrupted image, so clipping is the whole implementation choice here.
 */
const GLYPH_FONT: Record<string, readonly string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  ',': ['000', '000', '000', '010', '100'],
  '.': ['000', '000', '000', '000', '111'],
  '-': ['000', '000', '111', '000', '000'],
};

export type Rgba = [number, number, number, number];

function putPixel(image: RgbaImage, x: number, y: number, colour: Rgba): boolean {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return false;
  const o = (y * image.width + x) * 4;
  image.data[o] = colour[0];
  image.data[o + 1] = colour[1];
  image.data[o + 2] = colour[2];
  image.data[o + 3] = 255;
  return true;
}

/** Draw `text` with the bitmap glyphs. Characters outside the supported set are skipped and counted. */
export function drawDigits(
  image: RgbaImage,
  x: number,
  y: number,
  text: string,
  colour: Rgba,
  scale = 1,
): { painted: number; skipped: number } {
  let painted = 0;
  let skipped = 0;
  let cursor = x;
  for (const ch of text) {
    const glyph = GLYPH_FONT[ch];
    if (!glyph) {
      skipped++;
      cursor += 3 * scale + scale;
      continue;
    }
    for (let row = 0; row < glyph.length; row++) {
      for (let col = 0; col < glyph[row].length; col++) {
        if (glyph[row][col] !== '1') continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            if (putPixel(image, cursor + col * scale + sx, y + row * scale + sy, colour)) painted++;
          }
        }
      }
    }
    cursor += 3 * scale + scale;
  }
  return { painted, skipped };
}

export interface AnnotationSpec {
  /** Where the element is, in the image's own pixel space. */
  rect: { x: number; y: number; width: number; height: number };
  /** The index the outline gave this element, drawn on top of it. */
  index: number;
  /**
   * A second line under the index — normally `x,y,w,h` in image pixels. Restricted to the bitmap charset
   * (digits, comma, period, minus); other characters are skipped and counted, never approximated.
   */
  label?: string;
  /** Box outline colour. Opaque; the interior is never touched. */
  colour?: Rgba;
}

export interface PaintedAnnotation {
  image: RgbaImage;
  /** Pixels written by the annotation, so a caller can check the change is the annotation and nothing else. */
  painted: number;
  boxes: number;
  /** Labels that could not be drawn because they fell outside the image. */
  labelsOutside: number;
}

/**
 * Draw the outline and the index for each annotation onto a **copy** of the image.
 *
 * The source is never mutated: a caller keeps comparing the capture it took against the capture it took,
 * and an annotated image that quietly replaced it would poison every later diff.
 */
export function paintAnnotation(
  source: RgbaImage,
  annotations: AnnotationSpec[],
  options: { thickness?: number; labelScale?: number } = {},
): PaintedAnnotation {
  assertRgba(source, 'annotation target');
  const image: RgbaImage = { width: source.width, height: source.height, data: source.data.slice() };
  const thickness = Math.max(1, options.thickness ?? 2);
  const scale = Math.max(1, options.labelScale ?? 2);
  const defaultColour: Rgba = [0, 229, 255, 255];
  const dark: Rgba = [8, 8, 8, 255];
  let painted = 0;
  let boxes = 0;
  let labelsOutside = 0;

  for (const annotation of annotations) {
    const colour = annotation.colour ?? defaultColour;
    const { x, y, width, height } = annotation.rect;
    if (width <= 0 || height <= 0) continue;
    boxes++;
    // Four strips, bounds-checked, so a box hanging off the edge of a capture draws the part that is there.
    for (let t = 0; t < thickness; t++) {
      for (let px = x; px < x + width; px++) {
        if (putPixel(image, px, y + t, colour)) painted++;
        if (putPixel(image, px, y + height - 1 - t, colour)) painted++;
      }
      for (let py = y; py < y + height; py++) {
        if (putPixel(image, x + t, py, colour)) painted++;
        if (putPixel(image, x + width - 1 - t, py, colour)) painted++;
      }
    }
    const label = String(annotation.index);
    const labelX = x + thickness + 1;
    const labelY = y + thickness + 1;
    const glyphW = label.length * (3 * scale + scale);
    const glyphH = 5 * scale;
    if (labelX + glyphW > image.width || labelY + glyphH > image.height) {
      labelsOutside++;
      continue;
    }
    // A dark plate behind the digits, because cyan on a bright button is unreadable and unreadable
    // annotation is decoration. Its padding stops at the outline: the box edge is what tells a reader
    // where the element is, so the label may sit inside it but never on top of it.
    const plateX = Math.max(labelX - scale, x + thickness);
    const plateY = Math.max(labelY - scale, y + thickness);
    for (let py = plateY; py < labelY + glyphH + scale; py++) {
      for (let px = plateX; px < labelX + glyphW; px++) {
        if (putPixel(image, px, py, dark)) painted++;
      }
    }
    painted += drawDigits(image, labelX, labelY, label, [255, 255, 255, 255], scale).painted;

    // The coordinate line sits under the index, on its own plate. If it would not fit, it is skipped
    // entirely rather than cut off: a truncated "568,6" is a wrong coordinate, not a partial one.
    if (annotation.label) {
      const coordY = labelY + glyphH + scale + 1;
      const coordW = annotation.label.length * (3 * scale + scale);
      if (labelX + coordW <= image.width && coordY + glyphH <= image.height) {
        for (let py = coordY - scale; py < coordY + glyphH + scale; py++) {
          for (let px = plateX; px < labelX + coordW; px++) {
            if (putPixel(image, px, py, dark)) painted++;
          }
        }
        painted += drawDigits(image, labelX, coordY, annotation.label, [255, 255, 0, 255], scale).painted;
      } else {
        labelsOutside++;
      }
    }
  }

  return { image, painted, boxes, labelsOutside };
}

/**
 * A text answer about a visual change.
 *
 * Phrased for a decision: did it change, how much, where, and what could not be compared. The raw numbers
 * stay in the result object; this is the part a model reads.
 */
export function describeDiff(result: DiffResult, budget = 400): string {
  if (!result.comparable) return `not comparable: ${result.reason}`;
  if (result.changedPixels === 0)
    return `identical within tolerance: ${result.width}x${result.height}, ${result.comparedPixels} pixels compared`;
  const box = result.boundingBox!;
  const where = result.hotRegions.length
    ? `${result.hotRegions.length} region(s) changed most: ` +
      result.hotRegions
        .slice(0, 3)
        .map((r) => `[c${r.column}r${r.row}] ${Math.round(r.ratio * 100)}%`)
        .join(', ')
    : 'spread thinly, no region above the hot threshold';
  return (
    `changed ${result.changedPixels} of ${result.comparedPixels} pixels (${(result.changedRatio * 100).toFixed(2)}%), ` +
    `bounding box ${box.x},${box.y} ${box.width}x${box.height}, max channel delta ${result.maxChannelDelta}, ` +
    `alpha-only ${result.alphaOnlyDifferences}; ${where}`.slice(0, budget)
  );
}
