/**
 * The sample pattern the Settings page draws in the Tracker Font preview.
 *
 * A few bars of an invented tune, chosen so every kind of cell shows up: notes
 * (a sharp, a note-off `###`), instrument and volume digits, effect nibbles
 * with letters in them, and empty `---` / `..` cells. The glyphs a font is
 * hardest to tell apart on -- 0/O, 1/l, 5/S, 8/B -- are all in there.
 */

import { STANDARD_TRACK_COLUMNS } from 'src/components/tracker/track-metrics';
import type { PatternLayout } from 'src/components/tracker/pattern-canvas/pattern-layout';
import type { TrackerTrackData } from 'src/components/tracker/tracker-types';

export const PREVIEW_ROW_COUNT = 8;

/** The row the playback bar sits on. */
export const PREVIEW_PLAYBACK_ROW = 3;

/** The editing cursor: track, row and the (semantic) column it is in. */
export const PREVIEW_CURSOR = { trackIndex: 1, row: 5, column: 0, macroNibble: 0 } as const;

export const PREVIEW_TRACKS: TrackerTrackData[] = [
  {
    id: 'preview-lead',
    name: 'Lead',
    entries: [
      { row: 0, note: 'C-4', instrument: '01', volume: '40' },
      { row: 2, note: 'D#4', instrument: '01', volume: '38', macro: '0A7' },
      { row: 3, note: 'G-4', instrument: '01', volume: '40', macro: '437' },
      { row: 4, note: '###' },
      { row: 6, note: 'A#3', instrument: '0B', volume: '2C', macro: '8B0' },
    ],
  },
  {
    id: 'preview-bass',
    name: 'Bass',
    entries: [
      { row: 0, note: 'C-2', instrument: '05', volume: '50', macro: 'C20' },
      { row: 2, note: 'C-2', instrument: '05', volume: '48' },
      { row: 3, note: 'G-2', instrument: '05', volume: '50', macro: '0E5' },
      { row: 5, note: 'D#2', instrument: '05', volume: '50', macro: '1F0' },
      { row: 7, note: '###' },
    ],
  },
  {
    id: 'preview-drums',
    name: 'Drums',
    entries: [
      { row: 0, note: 'C-3', instrument: '10', volume: '64' },
      { row: 1, note: 'F#3', instrument: '12', volume: '30' },
      { row: 3, note: 'D-3', instrument: '11', volume: '5A', macro: 'E90' },
      { row: 4, note: 'C-3', instrument: '10', volume: '64' },
      { row: 5, note: 'F#3', instrument: '12', volume: '30' },
      { row: 7, note: 'D-3', instrument: '11', volume: '5A', macro: '8B5' },
    ],
  },
];

export const PREVIEW_LAYOUT: PatternLayout = {
  trackCount: PREVIEW_TRACKS.length,
  columns: STANDARD_TRACK_COLUMNS,
  rowCount: PREVIEW_ROW_COUNT,
};
