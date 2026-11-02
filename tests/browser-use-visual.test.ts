import { describe, it, expect } from 'vitest';
import {
  assertRgba,
  cropRgba,
  describeDiff,
  diffRgba,
  drawDigits,
  paintAnnotation,
  pixelCount,
  solidRgba,
  type RgbaImage,
} from '../src/core/browser-use-visual.js';

/**
 * Visual comparison is the last check an agent has before it believes its action worked, so the numbers
 * here have to be exact. These tests build images from functions, which keeps every expected pixel count
 * computable by hand instead of copied from a fixture nobody can verify.
 */

function make(
  width: number,
  height: number,
  fn: (x: number, y: number) => [number, number, number, number],
): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const px = fn(x, y);
      data[o] = px[0];
      data[o + 1] = px[1];
      data[o + 2] = px[2];
      data[o + 3] = px[3];
    }
  }
  return { width, height, data };
}

const grey = make(8, 8, () => [128, 128, 128, 255]);

describe('comparison', () => {
  it('calls an identical capture identical', () => {
    const r = diffRgba(
      grey,
      make(8, 8, () => [128, 128, 128, 255]),
    );
    expect(r.comparable).toBe(true);
    expect(r.changedPixels).toBe(0);
    expect(r.changedRatio).toBe(0);
    expect(r.boundingBox).toBeNull();
    expect(describeDiff(r)).toContain('identical within tolerance');
  });

  it('counts one modified pixel and locates it exactly', () => {
    const after = make(8, 8, (x, y) => (x === 3 && y === 5 ? [10, 200, 10, 255] : [128, 128, 128, 255]));
    const r = diffRgba(grey, after);
    expect(r.changedPixels).toBe(1);
    expect(r.comparedPixels).toBe(64);
    expect(r.boundingBox).toEqual({ x: 3, y: 5, width: 1, height: 1 });
    expect(r.maxChannelDelta).toBe(118);
  });

  it('swallows font-smoothing noise but not a colour change', () => {
    const slight = make(8, 8, () => [128 + 9, 128, 128 - 6, 255]);
    expect(diffRgba(grey, slight, { channelTolerance: 16 }).changedPixels).toBe(0);
    expect(diffRgba(grey, slight, { channelTolerance: 0 }).changedPixels).toBe(64);
    const real = make(8, 8, () => [128 + 70, 128, 128, 255]);
    expect(diffRgba(grey, real, { channelTolerance: 16 }).changedPixels).toBe(64);
  });

  it('refuses to compare two different capture sizes', () => {
    const r = diffRgba(
      grey,
      make(10, 8, () => [128, 128, 128, 255]),
    );
    expect(r.comparable).toBe(false);
    expect(r.reason).toMatch(/8x8 and 10x8/);
    expect(r.reason).toMatch(/different capture/);
    expect(describeDiff(r)).toMatch(/^not comparable:/);
  });

  it('reports alpha-only repaints separately and only counts them when asked', () => {
    const faded = make(8, 8, () => [128, 128, 128, 200]);
    const ignored = diffRgba(grey, faded);
    expect(ignored.changedPixels).toBe(0);
    expect(ignored.alphaOnlyDifferences).toBe(64);
    const counted = diffRgba(grey, faded, { ignoreAlphaOnly: false });
    expect(counted.changedPixels).toBe(64);
    expect(counted.alphaOnlyDifferences).toBe(64);
  });

  it('localises the change into a grid so "where" has an answer', () => {
    const topRight = make(8, 8, (x, y) => (x >= 4 && y < 4 ? [0, 0, 255, 255] : [128, 128, 128, 255]));
    const r = diffRgba(grey, topRight, { grid: { columns: 2, rows: 2 }, hotCellRatio: 0.5 });
    expect(r.regions).toHaveLength(4);
    expect(r.hotRegions).toHaveLength(1);
    expect(r.hotRegions[0].cell).toBe(1);
    expect(r.hotRegions[0].box).toEqual({ x: 4, y: 0, width: 4, height: 4 });
    expect(r.hotRegions[0].changedPixels).toBe(16);
    expect(r.boundingBox).toEqual({ x: 4, y: 0, width: 4, height: 4 });
  });

  it('spreads a thin change across regions without declaring any of them hot', () => {
    const one = make(8, 8, (x, y) => (x === y ? [0, 0, 0, 255] : [128, 128, 128, 255]));
    const r = diffRgba(grey, one, { grid: { columns: 4, rows: 4 }, hotCellRatio: 0.6 });
    expect(r.changedPixels).toBe(8);
    expect(r.hotRegions).toHaveLength(0);
    // 16 cells; the diagonal crosses 4 of them and fills half of each. "Hot" is a threshold, not a mood.
    expect(r.regions).toHaveLength(16);
    expect(r.regions.filter((region) => region.ratio === 0.5)).toHaveLength(4);
    expect(r.regions.filter((region) => region.changedPixels === 0)).toHaveLength(12);
    expect(describeDiff(r)).toContain('spread thinly');
  });

  it('describes a change with its size, box and hot regions in one line', () => {
    const block = make(8, 8, (x, y) => (x < 4 && y < 4 ? [255, 0, 0, 255] : [128, 128, 128, 255]));
    const line = describeDiff(diffRgba(grey, block, { grid: { columns: 2, rows: 2 } }));
    expect(line).toMatch(/changed 16 of 64 pixels \(25\.00%\)/);
    expect(line).toMatch(/bounding box 0,0 4x4/);
    expect(line).toMatch(/1 region\(s\) changed most/);
    expect(line.length).toBeLessThanOrEqual(400);
  });
});

describe('input validation', () => {
  it('rejects a buffer shorter than its own dimensions', () => {
    expect(() => assertRgba({ width: 4, height: 4, data: new Uint8Array(20) }, 'shot')).toThrow(
      /4x4 but its buffer holds 20 bytes, 64 needed/,
    );
  });

  it('rejects impossible dimensions instead of comparing zero pixels', () => {
    expect(() => assertRgba({ width: 0, height: 4, data: new Uint8Array(0) })).toThrow(/impossible dimensions 0x4/);
    expect(() => assertRgba({ width: 1.5, height: 2, data: new Uint8Array(12) })).toThrow(/impossible dimensions/);
  });

  it('surfaces the validation error through the comparison, not a partial answer', () => {
    expect(() =>
      diffRgba({ width: 4, height: 4, data: new Uint8Array(64) }, { width: 4, height: 4, data: new Uint8Array(8) }),
    ).toThrow(/after/);
  });

  it('counts pixels from dimensions rather than buffer length', () => {
    expect(pixelCount({ width: 3, height: 2, data: new Uint8Array(3 * 2 * 4) })).toBe(6);
  });
});

describe('cropping', () => {
  it('copies the requested rectangle byte for byte', () => {
    const img = make(4, 4, (x, y) => [x * 40, y * 40, 10, 255]);
    const crop = cropRgba(img, { x: 1, y: 2, width: 2, height: 2 });
    expect(crop.width).toBe(2);
    expect(crop.data.length).toBe(16);
    // pixel (1,2) of the source is (0,0) of the crop
    expect([...crop.data.slice(0, 4)]).toEqual([40, 80, 10, 255]);
    expect([...crop.data.slice(4, 8)]).toEqual([80, 80, 10, 255]);
    expect([...crop.data.slice(8, 12)]).toEqual([40, 120, 10, 255]);
  });

  it('refuses a crop that would have to be clamped', () => {
    const img = solidRgba(4, 4, [1, 2, 3, 255]);
    expect(() => cropRgba(img, { x: 2, y: 2, width: 4, height: 4 })).toThrow(/does not fit a 4x4 image/);
    expect(() => cropRgba(img, { x: -1, y: 0, width: 2, height: 2 })).toThrow(/does not fit/);
    expect(() => cropRgba(img, { x: 0, y: 0, width: 0, height: 2 })).toThrow(/does not fit/);
  });
});

describe('annotation', () => {
  const at = (img: RgbaImage, x: number, y: number): number[] => {
    const o = (y * img.width + x) * 4;
    return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
  };

  it('draws the outline where the box is and leaves the interior alone', () => {
    const base = solidRgba(20, 20, [128, 128, 128, 255]);
    const painted = paintAnnotation(base, [{ rect: { x: 2, y: 2, width: 10, height: 10 }, index: 1 }], {
      thickness: 1,
      labelScale: 1,
    });
    expect(painted.boxes).toBe(1);
    expect(painted.painted).toBeGreaterThan(0);
    expect(at(painted.image, 2, 2)).toEqual([0, 229, 255, 255]);
    expect(at(painted.image, 11, 2)).toEqual([0, 229, 255, 255]);
    expect(at(painted.image, 2, 11)).toEqual([0, 229, 255, 255]);
    // The plate behind the digits is deliberate, and the digits sit on top of it; the page's own pixels
    // must survive everywhere else.
    expect(at(painted.image, 5, 5)).toEqual([255, 255, 255, 255]);
    expect(at(painted.image, 3, 5)).toEqual([8, 8, 8, 255]);
    expect(at(painted.image, 9, 9)).toEqual([128, 128, 128, 255]);
  });

  it('never writes the source image', () => {
    const base = solidRgba(12, 12, [10, 20, 30, 255]);
    const before = base.data.slice();
    paintAnnotation(base, [{ rect: { x: 1, y: 1, width: 6, height: 6 }, index: 3 }]);
    expect([...base.data]).toEqual([...before]);
  });

  it('clips a box that hangs off the capture instead of wrapping into the next row', () => {
    const base = solidRgba(8, 8, [200, 200, 200, 255]);
    const painted = paintAnnotation(base, [{ rect: { x: 6, y: 6, width: 8, height: 8 }, index: 1 }], {
      thickness: 1,
      labelScale: 1,
    });
    expect(at(painted.image, 6, 6)).toEqual([0, 229, 255, 255]);
    // The row below would receive the overflow if the index arithmetic wrapped: (0,7) stays untouched.
    expect(at(painted.image, 0, 7)).toEqual([200, 200, 200, 255]);
    expect(at(painted.image, 1, 7)).toEqual([200, 200, 200, 255]);
    expect(at(painted.image, 7, 0)).toEqual([200, 200, 200, 255]);
  });

  it('refuses to label a box that has no room for the digits, and says so', () => {
    const base = solidRgba(12, 12, [5, 5, 5, 255]);
    const painted = paintAnnotation(base, [{ rect: { x: 4, y: 4, width: 6, height: 6 }, index: 12 }], {
      thickness: 1,
      labelScale: 2,
    });
    expect(painted.labelsOutside).toBe(1);
    expect(painted.boxes).toBe(1);
  });

  it('draws the digits of the index in white on a dark plate', () => {
    const img = solidRgba(16, 16, [0, 100, 0, 255]);
    const drawn = drawDigits(img, 2, 2, '1', [255, 255, 255, 255], 1);
    // glyph "1": 010 / 110 / 010 / 010 / 111 → eight pixels
    expect(drawn.painted).toBe(8);
    expect(at(img, 3, 2)).toEqual([255, 255, 255, 255]);
    expect(at(img, 2, 2)).toEqual([0, 100, 0, 255]);
    expect(at(img, 2, 6)).toEqual([255, 255, 255, 255]);
    expect(at(img, 4, 6)).toEqual([255, 255, 255, 255]);
    expect(at(img, 2, 3)).toEqual([255, 255, 255, 255]);
  });

  it('counts characters it cannot draw instead of drawing something arbitrary', () => {
    const img = solidRgba(24, 8, [1, 1, 1, 255]);
    const drawn = drawDigits(img, 1, 1, 'a1', [9, 9, 9, 255], 1);
    expect(drawn.skipped).toBe(1);
    expect(drawn.painted).toBe(8);
  });

  it('changes only the annotation pixels, which is what a diff can then prove', () => {
    const base = make(40, 30, (x, y) =>
      x > 8 && x < 28 && y > 6 && y < 16 ? [0, 64, 255, 255] : [255, 255, 255, 255],
    );
    const painted = paintAnnotation(base, [{ rect: { x: 10, y: 8, width: 16, height: 8 }, index: 2 }], {
      thickness: 1,
      labelScale: 1,
    });
    const d = diffRgba(base, painted.image, { channelTolerance: 0 });
    expect(d.comparable).toBe(true);
    expect(d.changedPixels).toBeLessThanOrEqual(painted.painted);
    expect(d.boundingBox).toEqual({ x: 10, y: 8, width: 16, height: 8 });
    // The button interior under the box is still blue, so the annotation did not overwrite the evidence.
    expect(at(painted.image, 18, 12)).toEqual([0, 64, 255, 255]);
  });
});
