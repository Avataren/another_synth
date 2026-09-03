import { describe, it, expect } from 'vitest';
import {
  overlayClearBands,
  BAND_PAD_PX,
  type OverlayFootprint,
} from 'src/components/tracker/pattern-canvas/pattern-bands';
import { GUTTER_WIDTH_PX, rowHeightPx, rowPitchPx } from 'src/components/tracker/pattern-canvas/pattern-layout';

/**
 * Overlay band math: which viewport bands a playback-bar/cursor repaint
 * must clear. Geometry only — the component applies the rects.
 */

const VIEW_W = 500;
const VIEW_H = 400;

function footprint(overrides: Partial<OverlayFootprint> = {}): OverlayFootprint {
  return {
    barRow: 2,
    cursor: null,
    viewTop: 0,
    viewLeft: 0,
    ...overrides,
  };
}

function covering(bands: ReturnType<typeof overlayClearBands>, y: number): boolean {
  return bands.some((b) => b.y <= y && b.y + b.height >= y + rowHeightPx);
}

describe('overlayClearBands', () => {
  it('a bar move clears both the previous and the new row band', () => {
    const bands = overlayClearBands(footprint({ barRow: 2 }), footprint({ barRow: 5 }), VIEW_W, VIEW_H);
    // Old band, new band — the cursor is not involved.
    expect(bands).toHaveLength(2);
    expect(covering(bands, 2 * rowPitchPx)).toBe(true);
    expect(covering(bands, 5 * rowPitchPx)).toBe(true);
  });

  it('a pan frame clears the bar band at BOTH view origins', () => {
    // Same bar row, view moved down 90px: the bar's screen position moved
    // with it, so both the old and the new screen band must be cleared.
    // (Row 6 stays fully in-viewport at both origins, so no clamping.)
    const bands = overlayClearBands(
      footprint({ barRow: 6, viewTop: 0 }),
      footprint({ barRow: 6, viewTop: 90 }),
      VIEW_W,
      VIEW_H,
    );
    expect(bands).toHaveLength(2);
    expect(covering(bands, 6 * rowPitchPx)).toBe(true);
    expect(covering(bands, 6 * rowPitchPx - 90)).toBe(true);
  });

  it('bands are padded around the row height by BAND_PAD_PX', () => {
    const bands = overlayClearBands(null, footprint(), VIEW_W, VIEW_H);
    expect(bands).toHaveLength(1);
    const [band] = bands;
    expect(band!.y).toBe(2 * rowPitchPx - BAND_PAD_PX);
    expect(band!.height).toBe(rowHeightPx + 2 * BAND_PAD_PX);
  });

  it('a band fully above the viewport (bar scrolled past) is dropped', () => {
    // The bar scrolled above the viewport: its band lies entirely off-
    // screen, so clearing it would be a no-op — it is dropped, not drawn.
    const bands = overlayClearBands(
      footprint({ barRow: 2, viewTop: 200 }),
      footprint({ barRow: 2, viewTop: 200 }),
      VIEW_W,
      VIEW_H,
    );
    expect(covering(bands, 2 * rowPitchPx - 200)).toBe(false); // off-viewport
    expect(bands).toHaveLength(0);
  });

  it('a band fully outside the viewport is dropped', () => {
    const bands = overlayClearBands(null, footprint({ barRow: 2, viewTop: 3 * rowPitchPx }), VIEW_W, VIEW_H);
    expect(bands).toHaveLength(0);
  });

  it('the cursor band follows the gutter shift and the view origin', () => {
    // Cursor cell at pattern (10, 60, 40×30), view at (viewLeft 30, top 0):
    // the overlay translate is (gutter − viewLeft, −viewTop).
    const cursor = { x: 10, y: 60, width: 40, height: 30 };
    const bands = overlayClearBands(
      footprint({ barRow: -1, cursor, viewLeft: 30 }),
      footprint({ barRow: -1, cursor, viewLeft: 70 }),
      VIEW_W,
      VIEW_H,
    );
    expect(bands).toHaveLength(2);
    const xs = bands.map((b) => b.x).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(10 + GUTTER_WIDTH_PX - 70 - BAND_PAD_PX, 5);
    expect(xs[1]).toBeCloseTo(10 + GUTTER_WIDTH_PX - 30 - BAND_PAD_PX, 5);
    expect(bands.every((b) => b.width > 0)).toBe(true);
  });

  it('a footprint with neither bar nor cursor clears nothing', () => {
    const bands = overlayClearBands(
      footprint({ barRow: -1, cursor: null }),
      footprint({ barRow: -1, cursor: null }),
      VIEW_W,
      VIEW_H,
    );
    expect(bands).toHaveLength(0);
  });

  it('a horizontal-only pan clears the cursor band twice, bar band once-ish', () => {
    // Pure horizontal pan: the bar's full-width band is identical at both
    // origins (x: 0), so the union is the same row — the pill moves inside
    // it and the redraw covers it. Two overlapping bands are still correct.
    const bands = overlayClearBands(
      footprint({ viewLeft: 0 }),
      footprint({ viewLeft: 50 }),
      VIEW_W,
      VIEW_H,
    );
    expect(bands).toHaveLength(2);
    for (const band of bands) {
      expect(band.x).toBe(0);
      expect(band.width).toBe(VIEW_W);
    }
  });
});
