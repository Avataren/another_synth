import { describe, it, expect } from 'vitest';
import {
  bitmapScaleFor,
  DESKTOP_BITMAP_BUDGET,
  MOBILE_BITMAP_BUDGET,
  MIN_BITMAP_SCALE,
} from 'src/components/tracker/pattern-canvas/pattern-bitmap';
import {
  GUTTER_WIDTH_PX,
  rowY,
  totalTracksWidth,
} from 'src/components/tracker/pattern-canvas/pattern-layout';

/**
 * The renderer used to refuse any pattern whose full-resolution bitmap
 * exceeded the caps, and fall back to the DOM grid for the rest of the
 * page's life. On a phone that was most modules -- jt_letgo's 26 channels at
 * DPR 3 want 91M device pixels -- which is the bug this scale exists to fix:
 * paint at a lower scale and let the blit stretch it.
 */

/** The bitmap extent, in CSS pixels, of a pattern this size. */
function extent(tracks: number, rows: number, dualFx = false) {
  return {
    width: GUTTER_WIDTH_PX + totalTracksWidth(tracks, dualFx),
    height: rowY(rows),
  };
}

describe('bitmapScaleFor', () => {
  it('paints at the screen scale when the pattern fits', () => {
    // A four-channel MOD on a 2x laptop: nothing to give up.
    const { width, height } = extent(4, 64);
    expect(bitmapScaleFor(width, height, 2)).toBe(2);
  });

  it('never paints above the screen scale', () => {
    // Headroom is not a reason to render more pixels than the screen has.
    const { width, height } = extent(4, 64);
    expect(bitmapScaleFor(width, height, 1)).toBe(1);
  });

  it('comes down instead of refusing the pattern that broke this', () => {
    // jt_letgo: 26 channels, 64 rows, on a 3x phone.
    const { width, height } = extent(26, 64);
    const scale = bitmapScaleFor(width, height, 3, MOBILE_BITMAP_BUDGET)!;

    expect(scale).not.toBeNull();
    expect(scale).toBeLessThan(3);
    expect(width * scale * height * scale).toBeLessThanOrEqual(
      MOBILE_BITMAP_BUDGET.maxArea,
    );
  });

  it('respects the per-axis ceiling, not just the area', () => {
    // A tall pattern can pass the area cap while asking for a dimension no
    // browser will allocate: 256 rows at DPR 3 is 27648 device pixels high.
    const { width, height } = extent(4, 256);
    const scale = bitmapScaleFor(width, height, 3, MOBILE_BITMAP_BUDGET)!;

    expect(height * scale).toBeLessThanOrEqual(MOBILE_BITMAP_BUDGET.maxDimension);
    expect(width * scale).toBeLessThanOrEqual(MOBILE_BITMAP_BUDGET.maxDimension);
  });

  it('fits every pattern the formats allow, on the desktop budget', () => {
    // The largest legal XM: 32 channels, 256 rows, both effect columns.
    // This is the claim that makes tiling unnecessary -- if it failed, the
    // renderer would need real tiles rather than a scale.
    const { width, height } = extent(32, 256, true);

    for (const dpr of [1, 1.5, 2, 3, 4]) {
      const scale = bitmapScaleFor(width, height, dpr, DESKTOP_BITMAP_BUDGET);
      expect(scale).not.toBeNull();
      expect(scale!).toBeGreaterThanOrEqual(MIN_BITMAP_SCALE);
      expect(width * scale! * height * scale!).toBeLessThanOrEqual(
        DESKTOP_BITMAP_BUDGET.maxArea,
      );
      expect(Math.max(width, height) * scale!).toBeLessThanOrEqual(
        DESKTOP_BITMAP_BUDGET.maxDimension,
      );
    }
  });

  it('fits everything but the one extreme on a phone', () => {
    // A phone's budget is a quarter of the desktop's, so the ceiling is
    // real: 32 channels and 256 rows still fit, and only that same pattern
    // with both effect columns -- 7304 x 9216 CSS pixels, on a 390px screen
    // -- hands over to the DOM grid.
    for (const [tracks, rows] of [[32, 128], [32, 256], [26, 64]] as const) {
      const { width, height } = extent(tracks, rows);
      const scale = bitmapScaleFor(width, height, 3, MOBILE_BITMAP_BUDGET);
      expect(scale).not.toBeNull();
      expect(width * scale! * height * scale!).toBeLessThanOrEqual(
        MOBILE_BITMAP_BUDGET.maxArea,
      );
    }

    const extreme = extent(32, 256, true);
    expect(
      bitmapScaleFor(extreme.width, extreme.height, 3, MOBILE_BITMAP_BUDGET),
    ).toBeNull();
  });

  it('gives up only when even the floor will not fit', () => {
    // Far past anything the formats allow; the DOM grid is the right answer.
    expect(bitmapScaleFor(200000, 200000, 2)).toBeNull();
  });

  it('refuses degenerate extents rather than dividing by them', () => {
    expect(bitmapScaleFor(0, 100, 2)).toBeNull();
    expect(bitmapScaleFor(100, 0, 2)).toBeNull();
    expect(bitmapScaleFor(100, 100, 0)).toBeNull();
    expect(bitmapScaleFor(Number.NaN, 100, 2)).toBeNull();
    expect(bitmapScaleFor(100, Number.POSITIVE_INFINITY, 2)).toBeNull();
  });
});

/**
 * The desktop must not pay for the phone's problem.
 *
 * The renderer ran fine on a desktop before any of this: a pattern that fit
 * was painted at the screen's full DPR. The scale clamp is only allowed to
 * change what used to *fail*, and the budget is what keeps that promise.
 */
describe('the desktop budget leaves working cases alone', () => {
  const fitsOldRule = (w: number, h: number, dpr: number) =>
    Math.ceil(w * dpr) * Math.ceil(h * dpr) <= DESKTOP_BITMAP_BUDGET.maxArea;

  it('paints at full DPR for every pattern that fit before', () => {
    const cases: Array<[number, number, boolean]> = [
      [4, 64, false],
      [8, 64, false],
      [16, 64, false],
      [26, 64, false],
      [32, 64, false],
      [32, 128, false],
      [16, 128, true],
    ];

    for (const [tracks, rows, dualFx] of cases) {
      const { width, height } = extent(tracks, rows, dualFx);
      for (const dpr of [1, 1.25, 1.5, 2]) {
        if (!fitsOldRule(width, height, dpr)) continue;
        // Also skip what the old rule allowed but no browser would: a
        // dimension past Safari's limit was never really working.
        if (Math.max(width, height) * dpr > DESKTOP_BITMAP_BUDGET.maxDimension) continue;
        expect(bitmapScaleFor(width, height, dpr, DESKTOP_BITMAP_BUDGET)).toBe(dpr);
      }
    }
  });

  it('rescues a desktop pattern that used to fall back to the DOM grid', () => {
    // 32 channels, 256 rows at DPR 2 is 198M device px -- refused before,
    // painted at ~1.1 now.
    const { width, height } = extent(32, 256);
    expect(fitsOldRule(width, height, 2)).toBe(false);

    const scale = bitmapScaleFor(width, height, 2, DESKTOP_BITMAP_BUDGET)!;
    expect(scale).toBeGreaterThan(1);
    expect(scale).toBeLessThan(2);
  });

  it('gives a phone a budget it can actually hold', () => {
    // The phone's ceiling is well under the desktop's: an iPhone caps canvas
    // memory hard, and it is the device asking for the biggest bitmap.
    expect(MOBILE_BITMAP_BUDGET.maxArea).toBeLessThan(DESKTOP_BITMAP_BUDGET.maxArea);
    expect(MOBILE_BITMAP_BUDGET.maxDimension).toBeLessThan(
      DESKTOP_BITMAP_BUDGET.maxDimension,
    );

    const { width, height } = extent(26, 64);
    const desktop = bitmapScaleFor(width, height, 3, DESKTOP_BITMAP_BUDGET)!;
    const mobile = bitmapScaleFor(width, height, 3, MOBILE_BITMAP_BUDGET)!;
    expect(mobile).toBeLessThan(desktop);
  });
});
