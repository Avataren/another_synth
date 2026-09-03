/**
 * Overlay band math for the canvas pattern renderer.
 *
 * The indicator layer (playback bar + editing cursor) used to be cleared
 * whole and fully redrawn on every playback/scroll frame. On a phone that
 * made every pan frame present a fully-repainted overlay racing the layer
 * beneath it, and the indicator visibly flickered. The fix repaints ONLY
 * the viewport bands the indicators leave and enter: the previous and the
 * current bar row, plus the cursor cell if it moved.
 *
 * Restoring a band's background is a clear on the transparent overlay, not
 * a repaint of pixels: the pristine background the band shows is the static
 * bitmap slice the visible layer blits beneath it — never a snapshot of a
 * live canvas, which could go stale (cursor inside the band, cell edits
 * during playback, theme flips) and silently restore wrong pixels. The
 * static bitmap is the single pristine source the whole renderer reads.
 *
 * Pure module: footprints in, viewport-space clear rects out. The component
 * applies them; tests assert the geometry without a canvas.
 */

import { GUTTER_WIDTH_PX, rowHeightPx, rowY } from './pattern-layout';

/**
 * What the overlay currently shows, in the coordinates it was painted at.
 * `viewTop`/`viewLeft` are the view origin of THAT paint — a pan changes
 * the origin, so the previous screen positions must be remembered to know
 * which bands to clear.
 */
export interface OverlayFootprint {
  /** Pattern-space row the playback bar was painted on; -1 = no bar. */
  barRow: number;
  /** Editing-cursor cell rect in pattern space; null = no cursor. */
  cursor: { x: number; y: number; width: number; height: number } | null;
  /** View origin the footprint's screen positions were derived from. */
  viewTop: number;
  viewLeft: number;
}

/** A viewport-space rectangle to clear on the overlay, in CSS pixels. */
export interface BandRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Margin added around indicator geometry: the playback pills stroke 2px
 * wide (1px outside their path) and anti-aliased edges bleed under a
 * device-pixel boundary.
 */
export const BAND_PAD_PX = 2;

/** Intersect a viewport-space rect with the viewport; null when empty. */
function clampBand(
  band: BandRect,
  viewportW: number,
  viewportH: number,
): BandRect | null {
  const x = Math.max(0, band.x);
  const y = Math.max(0, band.y);
  const right = Math.min(viewportW, band.x + band.width);
  const bottom = Math.min(viewportH, band.y + band.height);
  const width = right - x;
  const height = bottom - y;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

/** The viewport bands one footprint's indicators occupy. */
function footprintBands(
  f: OverlayFootprint,
  viewportW: number,
  viewportH: number,
): BandRect[] {
  const bands: BandRect[] = [];
  if (f.barRow >= 0) {
    // The bar spans the full width (gutter pill pinned at 0 + tracks pill
    // scrolled by viewLeft), so its band is the whole row: one rect covers
    // both pills whatever the horizontal origin.
    const band = clampBand(
      {
        x: 0,
        y: rowY(f.barRow) - f.viewTop - BAND_PAD_PX,
        width: viewportW,
        height: rowHeightPx + 2 * BAND_PAD_PX,
      },
      viewportW,
      viewportH,
    );
    if (band) bands.push(band);
  }
  if (f.cursor) {
    // The cursor rect is pattern-space; the overlay layer translates by
    // (gutter − viewLeft, −viewTop), so its screen rect is the same shift
    // the drawn cell takes.
    const band = clampBand(
      {
        x: f.cursor.x + GUTTER_WIDTH_PX - f.viewLeft - BAND_PAD_PX,
        y: f.cursor.y - f.viewTop - BAND_PAD_PX,
        width: f.cursor.width + 2 * BAND_PAD_PX,
        height: f.cursor.height + 2 * BAND_PAD_PX,
      },
      viewportW,
      viewportH,
    );
    if (band) bands.push(band);
  }
  return bands;
}

/**
 * The bands to clear before painting `next`: everything the previously
 * painted indicators (`prev`, null after a full paint) still occupy on
 * screen plus everything `next` will occupy. Overlap is fine — clearing a
 * band twice is free, and each band is at most one row tall, so a pan
 * frame touches a few dozen device rows instead of the whole layer.
 */
export function overlayClearBands(
  prev: OverlayFootprint | null,
  next: OverlayFootprint,
  viewportW: number,
  viewportH: number,
): BandRect[] {
  const bands: BandRect[] = [];
  if (prev) bands.push(...footprintBands(prev, viewportW, viewportH));
  bands.push(...footprintBands(next, viewportW, viewportH));
  return bands;
}
