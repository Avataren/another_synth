import { describe, expect, it } from 'vitest';
import {
  INCREMENTAL_MAX_RATIO,
  buildPaintState,
  diffPaintState,
  type PaintState,
} from 'src/components/tracker/pattern-canvas/pattern-diff';
import type {
  TrackerEntryData,
  TrackerSelectionRect,
  TrackerTrackData,
} from 'src/components/tracker/tracker-types';

/**
 * Pure tests for the cell-level paint diff (§3.3): which rows of which
 * track changed since the bitmap was painted, and when the change is too
 * broad for incremental repair.
 */

const ROWS = 64;

function makeEntry(row: number, note = 'C-4'): TrackerEntryData {
  return { row, note };
}

function makeTrack(id: string, rows: number[], note = 'C-4'): TrackerTrackData {
  return {
    id,
    name: `Track ${id}`,
    entries: rows.map((row) => makeEntry(row, note)),
  };
}

/** A copy sharing every entry object — what a track-level reassignment
 *  without content changes looks like (e.g. Vue re-sorting). */
function copyTrack(track: TrackerTrackData): TrackerTrackData {
  return { ...track, entries: [...track.entries] };
}

function paint(
  tracks: TrackerTrackData[],
  selection: TrackerSelectionRect | null = null,
): PaintState {
  return buildPaintState(tracks, ROWS, false, selection);
}

describe('buildPaintState', () => {
  it('snapshots layout, selection and per-track entry references', () => {
    const selection: TrackerSelectionRect = { rowStart: 0, rowEnd: 2, trackStart: 0, trackEnd: 1 };
    const tracks = [makeTrack('a', [0, 1])];
    const state = buildPaintState(tracks, ROWS, true, selection);
    expect(state.rowCount).toBe(ROWS);
    expect(state.showExtraEffectColumn).toBe(true);
    expect(state.selection).toEqual(selection);
    expect(state.selection).not.toBe(selection); // copied
    expect(state.tracks[0]!.entries).toBe(tracks[0]!.entries);
  });
});

describe('diffPaintState — no-op cases', () => {
  it('identical tracks yield an empty diff (no repaint at all)', () => {
    const tracks = [makeTrack('a', [0, 1, 2]), makeTrack('b', [4])];
    const painted = paint(tracks);
    expect(diffPaintState(painted, tracks, ROWS, false, null)).toEqual([]);
  });

  it('a new array sharing the entry objects (no edit) is still a no-op', () => {
    const tracks = [makeTrack('a', [0, 1, 2])];
    const painted = paint(tracks);
    expect(diffPaintState(painted, [copyTrack(tracks[0]!)], ROWS, false, null)).toEqual([]);
  });

  it('a rebuilt track with fresh entry objects repaints every painted row', () => {
    // Importing/paste rebuilds all entry objects: every present row changes.
    const tracks = [makeTrack('a', [0, 1, 2])];
    const painted = paint(tracks);
    const rebuilt = [makeTrack('a', [0, 1, 2])]; // equal content, fresh objects
    expect(diffPaintState(painted, rebuilt, ROWS, false, null)).toEqual([
      { trackIndex: 0, rows: [0, 1, 2] },
    ]);
  });
});

describe('diffPaintState — single-cell edits', () => {
  it('detects a replaced entry object as exactly that row', () => {
    const tracks = [makeTrack('a', [0, 1, 2, 3])];
    const painted = paint(tracks);
    const edited = copyTrack(tracks[0]!);
    edited.entries[2] = makeEntry(2, 'D-5');
    expect(diffPaintState(painted, [edited], ROWS, false, null)).toEqual([
      { trackIndex: 0, rows: [2] },
    ]);
  });

  it('detects an added entry (previously empty row)', () => {
    const tracks = [makeTrack('a', [0])];
    const painted = paint(tracks);
    const edited = copyTrack(tracks[0]!);
    edited.entries.push(makeEntry(7));
    expect(diffPaintState(painted, [edited], ROWS, false, null)).toEqual([
      { trackIndex: 0, rows: [7] },
    ]);
  });

  it('detects a removed entry (cleared step)', () => {
    const tracks = [makeTrack('a', [0, 7])];
    const painted = paint(tracks);
    const cleared = copyTrack(tracks[0]!);
    cleared.entries = cleared.entries.filter((e) => e.row !== 7);
    expect(diffPaintState(painted, [cleared], ROWS, false, null)).toEqual([
      { trackIndex: 0, rows: [7] },
    ]);
  });

  it('ignores untouched tracks and reports changed rows sorted', () => {
    const tracks = [makeTrack('a', [0]), makeTrack('b', [1, 2, 3])];
    const painted = paint(tracks);
    const editedB = copyTrack(tracks[1]!);
    editedB.entries[0] = makeEntry(1, 'E-5');
    editedB.entries.push(makeEntry(9));
    expect(diffPaintState(painted, [tracks[0]!, editedB], ROWS, false, null)).toEqual([
      { trackIndex: 1, rows: [1, 9] },
    ]);
  });
});

describe('diffPaintState — too-broad changes return null (full repaint)', () => {
  it('a row-count change is a full repaint', () => {
    const tracks = [makeTrack('a', [0])];
    const painted = paint(tracks);
    expect(diffPaintState(painted, tracks, ROWS + 16, false, null)).toBeNull();
  });

  it('a dual-effect flag flip is a full repaint', () => {
    const tracks = [makeTrack('a', [0])];
    const painted = paint(tracks);
    expect(diffPaintState(painted, tracks, ROWS, true, null)).toBeNull();
  });

  it('a selection change is a full repaint (selection tints the gutter)', () => {
    const tracks = [makeTrack('a', [0])];
    const painted = paint(tracks);
    const selection: TrackerSelectionRect = { rowStart: 0, rowEnd: 1, trackStart: 0, trackEnd: 0 };
    expect(diffPaintState(painted, tracks, ROWS, false, selection)).toBeNull();
  });

  it('a track-count change is a full repaint', () => {
    const tracks = [makeTrack('a', [0])];
    const painted = paint(tracks);
    expect(diffPaintState(painted, [...tracks, makeTrack('b', [1])], ROWS, false, null)).toBeNull();
  });

  it('a changed interpolation range repaints the track column', () => {
    const base = makeTrack('a', [0, 4]);
    base.interpolations = [{ startRow: 0, endRow: 8, macroIndex: 0, startValue: 0, endValue: 1, interpolation: 'linear' }];
    const painted = paint([base]);
    const edited = copyTrack(base);
    edited.interpolations = [
      { startRow: 0, endRow: 8, macroIndex: 0, startValue: 0, endValue: 1, interpolation: 'linear' },
      { startRow: 9, endRow: 12, macroIndex: 0, startValue: 1, endValue: 0, interpolation: 'exponential' },
    ];
    const diffs = diffPaintState(painted, [edited], ROWS, false, null);
    // The interpolation tints ride along outside the ratio (one bounded
    // column), repainting every row of that track.
    expect(diffs).toEqual([{ trackIndex: 0, rows: Array.from({ length: ROWS }, (_, r) => r) }]);
  });

  it('more than a quarter of the grid changed → null', () => {
    // 2 tracks × 64 rows = 128 cells; 33 changed cells > 25%.
    const tracks = [makeTrack('a', Array.from({ length: ROWS }, (_, i) => i)), makeTrack('b', [])];
    const painted = paint(tracks);
    const pasted = copyTrack(tracks[0]!);
    for (let row = 0; row < 33; row++) pasted.entries[row] = makeEntry(row, 'D-5');
    expect(diffPaintState(painted, [pasted, tracks[1]!], ROWS, false, null)).toBeNull();
  });

  it('exactly at the threshold still repairs incrementally', () => {
    // 2 tracks × 64 = 128 cells; 32 changed = exactly 25%, not over.
    const tracks = [makeTrack('a', Array.from({ length: ROWS }, (_, i) => i)), makeTrack('b', [])];
    const painted = paint(tracks);
    const pasted = copyTrack(tracks[0]!);
    for (let row = 0; row < 32; row++) pasted.entries[row] = makeEntry(row, 'D-5');
    const diffs = diffPaintState(painted, [pasted, tracks[1]!], ROWS, false, null);
    expect(diffs).not.toBeNull();
    expect(diffs).toHaveLength(1);
    expect(INCREMENTAL_MAX_RATIO).toBe(0.25);
  });
});

describe('diffPaintState — sparse entries', () => {
  it('handles out-of-order and gapped entry lists by row key', () => {
    const sparse = makeTrack('a', [20, 3, 11]);
    const painted = paint([sparse]);
    const edited = copyTrack(sparse);
    // sparse[1] is the entry at row 3 (list is out of order); replace it.
    edited.entries[1] = makeEntry(3, 'G#5');
    expect(diffPaintState(painted, [edited], ROWS, false, null)).toEqual([
      { trackIndex: 0, rows: [3] },
    ]);
  });
});
