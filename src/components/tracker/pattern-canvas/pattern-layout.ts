/**
 * Row/column geometry for the canvas pattern renderer.
 *
 * The DOM pattern grid draws one track column as a CSS grid of entry cells
 * (see TrackerEntry.vue); the canvas renderer has to land clicks and draw
 * cells on exactly the same pixels. These are the numbers both sides must
 * agree on, extracted so the canvas never has to measure the DOM it replaces.
 */

import {
  trackGapPx,
  trackPitchPx,
  trackWidthPx,
  type TrackColumns,
} from '../track-metrics';
import type { TrackerEntryData, TrackerTrackData } from '../tracker-types';

/** Height of one entry row, in pixels (TrackerEntry height). */
export const rowHeightPx = 30;
/** Vertical gap between rows (the row-columns' flex gap). */
export const rowGapPx = 6;
/** Height of the header strip above the first row ("Row" header). */
export const headerHeightPx = 46;

/**
 * Width of the row-number gutter column, in pixels.
 *
 * Shared by `drawRowNumbers` (which paints it into the static bitmap),
 * PatternCanvas (which pins it on screen and offsets hit tests by it) and the
 * DOM header's "Row" cell, so all three agree on where the tracks start.
 */
export const GUTTER_WIDTH_PX = 78;

/** Vertical advance from one row to the next. */
export const rowPitchPx = rowHeightPx + rowGapPx;

/**
 * One entry's horizontal padding plus border, in pixels per side.
 *
 * TrackerEntry boxes its grid columns inside `padding: 6px 10px` and a 1px
 * border, so the CSS grid's fractional columns only span the inner width --
 * the fr arithmetic below has to start from that, not the full track width.
 */
export const entryHorizontalInsetPx = 10 + 1;

/**
 * CSS grid fractions of one entry's columns, exactly as TrackerEntry lays
 * them out. Without the extra effect column the effect cell is one wider
 * (1.8fr) column holding all three macro nibbles; with it, the effect cell
 * splits into two 1.5fr columns, one per macro.
 *
 * Without a volume column (AHX, HVL, SID) both volume digits are zero wide
 * rather than gone, so column indices keep their meaning: offsets[2] and
 * offsets[3] sit on the effect column's left edge and nothing can hit them.
 */
const FRACTIONS: readonly (readonly (readonly number[])[])[] = [
  [
    [1.6, 1, 0, 0, 1.8],
    [1.6, 1, 0, 0, 1.5, 1.5],
  ],
  [
    [1.6, 1, 0.35, 0.35, 1.8],
    [1.6, 1, 0.35, 0.35, 1.5, 1.5],
  ],
];

/** Width of the whole pattern (all track columns with their gaps). */
export function totalTracksWidth(
  trackCount: number,
  columns: TrackColumns,
): number {
  if (trackCount <= 0) return 0;
  // Last column has no trailing gap: count widths + (count-1) gaps.
  return (
    trackCount * trackWidthPx(trackCount, columns) +
    (trackCount - 1) * trackGapPx(trackCount)
  );
}

/** Top edge of a row's entry box, relative to the first row's top. */
export function rowY(row: number): number {
  return row * rowPitchPx;
}

/**
 * PatternCanvas panel chrome: its 18px padding per side plus the 1px border
 * per side. The panel's natural width is the bitmap's content width plus
 * this; the panel then centers in the page exactly like the DOM grid's
 * `inline-flex` tracks wrapper.
 */
export const PANEL_CHROME_PX = 38;

/**
 * Natural width of the canvas panel for a pattern `contentWidth` wide
 * (GUTTER_WIDTH_PX + totalTracksWidth), before any page-level max-width cap.
 */
export function patternPanelWidth(contentWidth: number): number {
  return contentWidth + PANEL_CHROME_PX;
}

/**
 * Width held back on each side of the panel for the spectrum analyser, in
 * pixels. The DOM grid expresses the same reserve in CSS as
 * `min(var(--tracker-side-gutter), 15%)` of the pattern area's content box.
 * One track column is the reserve (`trackWidthPx`), capped at 15% of the
 * available width so a narrow window spends most of its space on the
 * pattern.
 */
export function reservedSideGutterPx(
  reserveSideGutter: boolean,
  trackCount: number,
  columns: TrackColumns,
  availableWidth: number,
): number {
  if (!reserveSideGutter) return 0;
  return Math.min(
    trackWidthPx(trackCount, columns),
    0.15 * availableWidth,
  );
}

/**
 * Bounding box of one track's entry at `row`, in pattern coordinates.
 *
 * `trackIndex` places the box horizontally (track pitch + gap), `layout`
 * carries the row count for clamping `row` into range. The rect is the full
 * entry box (30px tall, trackWidth wide) -- cell subdivision lives in the
 * fraction offsets, not here.
 */
export function entryBoxRect(
  trackIndex: number,
  row: number,
  layout: PatternLayout,
): { x: number; y: number; width: number; height: number } {
  const pitch = trackPitchPx(layout.trackCount, layout.columns);
  return {
    x: trackIndex * pitch,
    y: rowY(row),
    width: trackWidthPx(layout.trackCount, layout.columns),
    height: rowHeightPx,
  };
}

/**
 * Left-edge offset (px from the entry's content box) of each grid column,
 * replicating TrackerEntry's `grid-template-columns` fr math.
 *
 * Returns `fractions.length + 1` edges: column i spans
 * `[offsets[i], offsets[i+1])`. The entry's own padding/border is subtracted
 * first, so callers pass a full track width and get content-box positions.
 */
/**
 * One memo slot per column layout.
 *
 * Every cell of a full-grid paint asks for the offsets of the same track
 * width, so this was building an array (and re-running the reduce) once per
 * cell. Each slot is keyed by the width it was computed for; callers only
 * ever read the result, so the array is shared rather than copied.
 */
const offsetMemo = new Map<TrackColumns, { width: number; offsets: readonly number[] }>();

function computeColumnFractionOffsets(
  trackWidth: number,
  fractions: readonly number[],
): readonly number[] {
  const contentWidth = Math.max(
    0,
    trackWidth - 2 * entryHorizontalInsetPx,
  );
  const total = fractions.reduce((sum, f) => sum + f, 0);
  const unit = contentWidth / total;
  const offsets: number[] = [0];
  let acc = 0;
  for (const f of fractions) {
    acc += f * unit;
    offsets.push(acc);
  }
  return offsets;
}

export function columnFractionOffsets(
  trackWidth: number,
  columns: TrackColumns,
): readonly number[] {
  const memo = offsetMemo.get(columns);
  if (memo !== undefined && memo.width === trackWidth) return memo.offsets;
  const fractions = FRACTIONS[columns.volume ? 1 : 0]![columns.extraEffect ? 1 : 0]!;
  const offsets = computeColumnFractionOffsets(trackWidth, fractions);
  offsetMemo.set(columns, { width: trackWidth, offsets });
  return offsets;
}

/**
 * Width of one macro nibble cell, in pixels.
 *
 * In single-effect mode the three nibbles share the effect column evenly;
 * in dual mode each macro column holds its own three. Returns 0 when the
 * track is too narrow to have a content box at all.
 */
export function macroNibbleWidth(
  trackWidth: number,
  columns: TrackColumns,
): number {
  const offsets = columnFractionOffsets(trackWidth, columns);
  // Effect column (index 4) spans offsets[4]..offsets[5].
  return (offsets[5]! - offsets[4]!) / 3;
}

/** Everything a hit test or cell renderer needs about one pattern's geometry. */
export interface PatternLayout {
  trackCount: number;
  columns: TrackColumns;
  rowCount: number;
}

/**
 * Map from row index to that row's entry, for canvas render loops that walk
 * rows and need the cell data without re-scanning the entries array.
 *
 * Entries are keyed by their `row` field (not array position): sparse and
 * out-of-order entry lists are valid, and a plain `Map` keeps lookups O(1)
 * in the render loop while preserving which rows exist at all.
 */
export function buildEntryLookup(
  track: TrackerTrackData,
): Map<number, TrackerEntryData> {
  const lookup = new Map<number, TrackerEntryData>();
  for (const entry of track.entries) {
    lookup.set(entry.row, entry);
  }
  return lookup;
}
