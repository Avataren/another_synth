import { describe, it, expect } from 'vitest';
import {
  entryHorizontalInsetPx,
  rowGapPx,
  rowHeightPx,
  type PatternLayout,
} from 'src/components/tracker/pattern-canvas/pattern-layout';
import { columnFractionOffsets } from 'src/components/tracker/pattern-canvas/pattern-layout';
import { trackPitchPx, trackWidthPx } from 'src/components/tracker/track-metrics';
import { hitTest } from 'src/components/tracker/pattern-canvas/pattern-hit-test';

/**
 * The canvas grid replaces the DOM's data-cell click targets, so a pointer
 * position must resolve to exactly the cell the DOM would have reported --
 * same column numbering (0 note, 1 instrument, 2 volumeHi, 3 volumeLo, 4/5
 * effect), same macro-nibble subdivision, and dead space stays dead: row gaps
 * and track gaps hit nothing. Round-trips below place each hit back where it
 * came from using the layout arithmetic itself.
 */

const layout = (trackCount = 4, showExtraEffectColumn = false, rowCount = 64): PatternLayout => ({
  trackCount,
  showExtraEffectColumn,
  rowCount,
});

/** Center of a cell, computed from the layout functions (not hand-set). */
function cellCenter(
  trackIndex: number,
  row: number,
  column: number,
  count: number,
  extra: boolean,
): { x: number; y: number } {
  const pitch = trackPitchPx(count, extra);
  const width = trackWidthPx(count, extra);
  const offsets = columnFractionOffsets(width, extra);
  const x = trackIndex * pitch + entryHorizontalInsetPx + (offsets[column]! + offsets[column + 1]!) / 2;
  const y = row * (rowHeightPx + rowGapPx) + rowHeightPx / 2;
  return { x, y };
}

describe('hitTest round-trips through the layout', () => {
  it('resolves every plain column on a 4-track pattern', () => {
    const count = 4;
    for (let trackIndex = 0; trackIndex < count; trackIndex++) {
      for (const column of [0, 1, 2, 3]) {
        const { x, y } = cellCenter(trackIndex, 7, column, count, false);
        const hit = hitTest(x, y, layout(count), 0);
        expect(hit).toEqual({ row: 7, trackIndex, column });
      }
    }
  });

  it('resolves plain columns in dual-effect mode too', () => {
    const count = 4;
    for (const column of [0, 1, 2, 3]) {
      const { x, y } = cellCenter(1, 3, column, count, true);
      const hit = hitTest(x, y, layout(count, true), 0);
      expect(hit).toEqual({ row: 3, trackIndex: 1, column });
    }
  });

  it('keeps working at the tightened 22-channel metrics', () => {
    const count = 22;
    const { x, y } = cellCenter(19, 11, 2, count, false);
    const hit = hitTest(x, y, layout(count), 0);
    expect(hit).toEqual({ row: 11, trackIndex: 19, column: 2 });
  });
});

describe('effect columns report macro nibbles', () => {
  it('splits column 4 into three nibbles, single-effect mode', () => {
    const count = 4;
    const width = trackWidthPx(count, false);
    const offsets = columnFractionOffsets(width, false);
    const colLeft = trackWidthPx(count, false) * 0 + entryHorizontalInsetPx + offsets[4]!;
    const nibble = (offsets[5]! - offsets[4]!) / 3;
    for (const n of [0, 1, 2]) {
      const x = colLeft + nibble * (n + 0.5);
      const y = rowHeightPx / 2;
      expect(hitTest(x, y, layout(count), 0)).toEqual({
        row: 0,
        trackIndex: 0,
        column: 4,
        macroNibble: n,
      });
    }
  });

  it('splits columns 4 and 5 into nibbles in dual-effect mode', () => {
    const count = 4;
    const width = trackWidthPx(count, true);
    const offsets = columnFractionOffsets(width, true);
    for (const column of [4, 5]) {
      const left = entryHorizontalInsetPx + offsets[column]!;
      const nibble = (offsets[column + 1]! - offsets[column]!) / 3;
      const x = left + nibble * 1.5;
      const hit = hitTest(x, rowHeightPx / 2, layout(count, true), 0);
      expect(hit).toEqual({ row: 0, trackIndex: 0, column, macroNibble: 1 });
    }
  });

  it('clamps nibble indices to 0-2 at the column edges', () => {
    const count = 4;
    const width = trackWidthPx(count, false);
    const offsets = columnFractionOffsets(width, false);
    const colLeft = entryHorizontalInsetPx + offsets[4]!;
    const colRight = entryHorizontalInsetPx + offsets[5]!;
    const hitFirst = hitTest(colLeft + 0.5, 15, layout(count), 0);
    expect(hitFirst?.macroNibble).toBe(0);
    const hitLast = hitTest(colRight - 0.5, 15, layout(count), 0);
    expect(hitLast?.macroNibble).toBe(2);
  });
});

describe('dead space and boundaries', () => {
  it('hits nothing in the row gap between entries', () => {
    const y = 1 * (rowHeightPx + rowGapPx) + rowHeightPx + 1; // inside gap after row 1
    expect(hitTest(50, y, layout(), 0)).toBeNull();
  });

  it('hits nothing in the track gap between columns', () => {
    const pitch = trackPitchPx(4, false);
    const x = trackWidthPx(4, false) + 5; // inside the 10px gap after track 0
    expect(hitTest(x, 15, layout(), 0)).toBeNull();
  });

  it('hits nothing in the entry padding band outside the grid columns', () => {
    // The 10px+border inset belongs to the box, not to any grid column.
    expect(hitTest(5, 15, layout(), 0)).toBeNull();
  });

  it('hits nothing beyond the last track or last row', () => {
    const count = 4;
    const beyond = trackPitchPx(count, false) * count + 50;
    expect(hitTest(beyond, 15, layout(count), 0)).toBeNull();
    const below = 64 * (rowHeightPx + rowGapPx);
    expect(hitTest(50, below, layout(count), 0)).toBeNull();
  });

  it('rejects negative coordinates', () => {
    expect(hitTest(-1, 15, layout(), 0)).toBeNull();
    expect(hitTest(50, -1, layout(), 0)).toBeNull();
  });
});

describe('scroll offset', () => {
  it('maps viewport y through scrollTop to the same row', () => {
    const count = 4;
    const scrollTop = 3 * (rowHeightPx + rowGapPx) + 7;
    // Content y of row 9's center, viewed after scrolling:
    const { x, y } = cellCenter(2, 9, 1, count, false);
    expect(hitTest(x, y, layout(count), 0)).toEqual({ row: 9, trackIndex: 2, column: 1 });
    expect(hitTest(x, y - scrollTop, layout(count), scrollTop)).toEqual({
      row: 9,
      trackIndex: 2,
      column: 1,
    });
  });

  it('shows an earlier row once the view scrolls down', () => {
    const row = 10;
    const scrollTop = row * (rowHeightPx + rowGapPx);
    // y=0 in the scrolled view is row 10's top edge.
    expect(hitTest(20, 0, layout(), scrollTop)).toEqual({ row: 10, trackIndex: 0, column: 0 });
  });
});
