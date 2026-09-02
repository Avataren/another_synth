/**
 * Pointer → cell hit testing for the canvas pattern renderer.
 *
 * Same semantics as clicking a TrackerEntry's data-cell in the DOM grid:
 * columns 0-3 are note / instrument / volumeHi / volumeLo, column 4 is the
 * effect cell (with `macroNibble` 0-2 when the click lands on a specific
 * nibble), and column 5 is the second effect cell in dual-effect mode.
 */

import {
  columnFractionOffsets,
  entryHorizontalInsetPx,
  macroNibbleWidth,
  rowHeightPx,
  rowGapPx,
  type PatternLayout,
} from './pattern-layout';
import { trackPitchPx, trackWidthPx } from '../track-metrics';

export interface PatternHit {
  row: number;
  trackIndex: number;
  column: number;
  macroNibble?: number;
}

/**
 * Pointer (x, y in viewport/canvas coordinates) → cell, or null when the
 * point is in a gap, the header band, or outside the grid entirely.
 *
 * `scrollTop` is the pattern's current vertical scroll: the bitmap holds the
 * whole pattern, so a pointer y maps to content y = y + scrollTop, the same
 * arithmetic as `element.offsetTop + container.scrollTop` in the DOM grid.
 * Row gaps hit nothing, mirroring the DOM where the flex gap between entry
 * boxes is dead space.
 */
export function hitTest(
  x: number,
  y: number,
  layout: PatternLayout,
  scrollTop: number,
): PatternHit | null {
  if (y < 0) return null;
  const localY = y + scrollTop;
  if (localY < 0 || localY >= layout.rowCount * (rowHeightPx + rowGapPx)) {
    return null;
  }

  const withinRow = localY % (rowHeightPx + rowGapPx);
  // The trailing gap belongs to no row; only the top `rowHeightPx` does.
  if (withinRow >= rowHeightPx) return null;
  const row = Math.floor(localY / (rowHeightPx + rowGapPx));

  if (x < 0) return null;
  const pitch = trackPitchPx(layout.trackCount, layout.showExtraEffectColumn);
  const trackIndex = Math.floor(x / pitch);
  if (trackIndex >= layout.trackCount) return null;

  // The flex gap between entry boxes is dead space, exactly as in the DOM.
  const boxWidth = trackWidthPx(layout.trackCount, layout.showExtraEffectColumn);
  const withinTrack = x - trackIndex * pitch;
  if (withinTrack >= boxWidth) return null;

  const column = hitColumn(withinTrack, boxWidth, layout.showExtraEffectColumn);
  if (column === null) return null;

  if (column.column === 4 || column.column === 5) {
    return {
      row,
      trackIndex,
      column: column.column,
      macroNibble: column.macroNibble!,
    };
  }
  return { row, trackIndex, column: column.column };
}

/**
 * Which grid column an x-offset inside one entry box lands in, plus the
 * macro nibble index for effect columns (the nibbles subdivide the effect
 * column three ways, exactly like the DOM's `.macro-digit` spans).
 */
function hitColumn(
  withinBox: number,
  boxWidth: number,
  showExtraEffectColumn: boolean,
): { column: number; macroNibble?: number } | null {
  const contentX = withinBox - entryHorizontalInsetPx;
  const offsets = columnFractionOffsets(boxWidth, showExtraEffectColumn);
  for (let column = 0; column < offsets.length - 1; column++) {
    if (contentX >= offsets[column]! && contentX < offsets[column + 1]!) {
      if (column === 4 || column === 5) {
        const nibbleWidth = macroNibbleWidth(boxWidth, showExtraEffectColumn);
        const nibble = Math.floor(
          (contentX - offsets[column]!) / nibbleWidth,
        );
        return {
          column,
          macroNibble: Math.min(2, Math.max(0, nibble)),
        };
      }
      return { column };
    }
  }
  return null;
}
