/**
 * Cell-level diffing for the canvas pattern renderer's static bitmap (§3.3).
 *
 * Editing mutates `track.entries` in place (the editing composables replace
 * entry objects and reassign the array), so the renderer cannot tell from a
 * prop identity alone which cells changed. Instead it snapshots what it
 * painted — per-track entry/interpolation references — and diffs the next
 * tracks prop against that snapshot. Changed rows come back as per-track row
 * lists the component clips to `(trackX, rowY, trackWidth, rowHeight)` and
 * repaints cell by cell, leaving the rest of the bitmap untouched.
 *
 * Pure module: no canvas, no DOM — the component feeds it plain data.
 */

import type {
  TrackerEntryData,
  TrackerInterpolationRange,
  TrackerSelectionRect,
  TrackerTrackData,
} from '../tracker-types';

/** What one painted track looked like when the static bitmap was drawn. */
export interface PaintedTrack {
  entries: TrackerEntryData[];
  interpolations: TrackerInterpolationRange[] | undefined;
}

/** Content snapshot of the static bitmap's last paint. */
export interface PaintState {
  rowCount: number;
  showExtraEffectColumn: boolean;
  selection: TrackerSelectionRect | null;
  tracks: PaintedTrack[];
}

/** Changed rows of one track, for clip + repaint of just those cells. */
export interface CellDiff {
  trackIndex: number;
  rows: number[];
}

/**
 * Fraction of the grid above which a change repaints the whole bitmap
 * instead of repairing cells. Pattern-wide operations (paste pattern, a
 * playback swap that arrives without a pre-render) touch most cells; the
 * full paint is faster than thousands of clipped cell paints.
 */
export const INCREMENTAL_MAX_RATIO = 0.25;

/**
 * Snapshot `tracks` as painted content. Call right after a successful
 * static paint (or bitmap adoption) so the next diff measures against what
 * is actually on the bitmap.
 */
export function buildPaintState(
  tracks: TrackerTrackData[],
  rows: number,
  showExtraEffectColumn: boolean,
  selection: TrackerSelectionRect | null,
): PaintState {
  return {
    rowCount: rows,
    showExtraEffectColumn,
    selection: selection ? { ...selection } : null,
    tracks: tracks.map((track) => ({
      entries: track.entries,
      interpolations: track.interpolations,
    })),
  };
}

function sameInterpolations(
  a: TrackerInterpolationRange[] | undefined,
  b: TrackerInterpolationRange[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((range, i) => range === b[i]);
}

/**
 * Rows of each track whose painted cell no longer matches `tracks`.
 *
 * Comparison is by object identity per entry — the editing composables
 * (`useTrackerEditing`) replace entry objects on every keystroke, so an
 * identical identity means an unchanged cell and a changed identity means a
 * repaint. Mutating an entry object in place is NOT detected; that is not
 * a supported edit path.
 *
 * Returns `null` when the change is too broad for incremental repair —
 * layout change, selection change, track count change, or more than
 * `INCREMENTAL_MAX_RATIO` of the grid — and the caller must repaint the
 * whole static bitmap. An empty array means nothing painted needs to change.
 */
export function diffPaintState(
  painted: PaintState,
  tracks: TrackerTrackData[],
  rows: number,
  showExtraEffectColumn: boolean,
  selection: TrackerSelectionRect | null,
): CellDiff[] | null {
  if (painted.rowCount !== rows) return null;
  if (painted.showExtraEffectColumn !== showExtraEffectColumn) return null;
  if (
    (painted.selection === null) !== (selection === null) ||
    (painted.selection !== null &&
      selection !== null &&
      (painted.selection.rowStart !== selection.rowStart ||
        painted.selection.rowEnd !== selection.rowEnd ||
        painted.selection.trackStart !== selection.trackStart ||
        painted.selection.trackEnd !== selection.trackEnd))
  ) {
    return null;
  }
  if (painted.tracks.length !== tracks.length) return null;

  const diffs: CellDiff[] = [];
  let changedCells = 0;
  for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
    const prev = painted.tracks[trackIndex]!;
    const track = tracks[trackIndex]!;
    if (prev.entries === track.entries && sameInterpolations(prev.interpolations, track.interpolations)) {
      continue;
    }
    // The entries array itself was replaced: diff row by row. Sparse and
    // out-of-order entry lists are valid, so key both sides by entry.row.
    const prevByRow = new Map<number, TrackerEntryData>();
    for (const entry of prev.entries) prevByRow.set(entry.row, entry);
    const nextByRow = new Map<number, TrackerEntryData>();
    for (const entry of track.entries) nextByRow.set(entry.row, entry);

    const rowsChanged = new Set<number>();
    for (const [row, entry] of nextByRow) {
      if (prevByRow.get(row) !== entry) rowsChanged.add(row);
    }
    for (const [row] of prevByRow) {
      if (!nextByRow.has(row)) rowsChanged.add(row);
    }
    changedCells += rowsChanged.size;
    // An interpolation-range edit re-tints the effect column of rows the
    // ranges cover; without per-row range knowledge, repaint the whole
    // track column. That is bounded work (one column, ≤ row count), so it
    // rides along outside the grid-wide ratio below — which guards against
    // pathological full-bitmap repairs, not single-column ones.
    if (!sameInterpolations(prev.interpolations, track.interpolations)) {
      for (let row = 0; row < rows; row++) rowsChanged.add(row);
    }
    if (rowsChanged.size > 0) {
      const sorted = [...rowsChanged].sort((a, b) => a - b);
      diffs.push({ trackIndex, rows: sorted });
    }
  }

  const totalCells = tracks.length * rows;
  if (totalCells > 0 && changedCells / totalCells > INCREMENTAL_MAX_RATIO) return null;
  return diffs;
}
