/**
 * The legend over the PList canvas (plan §1.3): the tracker's canvas has no
 * column captions, and the PList's columns mean different things than a
 * tracker step's (its "instrument" column holds a tone), so four labels say
 * what each column holds. DOM, not canvas pixels, so it is selectable and
 * testable.
 *
 * Positions come from `columnFractionOffsets`, the geometry the canvas draws
 * with, so a label sits over its column. Every text here states only what the
 * projection (`plist-track.ts`) draws.
 */
import {
  columnFractionOffsets,
  entryHorizontalInsetPx,
  GUTTER_WIDTH_PX,
} from 'src/components/tracker/pattern-canvas/pattern-layout';
import { trackColumns, trackWidthPx } from 'src/components/tracker/track-metrics';

export type PListLegendKey = 'note' | 'tone' | 'cmd1' | 'cmd2';

export interface PListLegendCell {
  key: PListLegendKey;
  label: string;
  /** Left edge in px from the canvas panel's content box (gutter included). */
  x: number;
  /** Width of the column the label sits over, px. */
  width: number;
  /** Native tooltip: the full explanation. */
  title: string;
}

/** The one track's width: dual-effect layout, one track. */
export const PLIST_TRACK_WIDTH_PX = trackWidthPx(1, trackColumns(true, true));

/** Canvas grid column each label sits over (dual-effect layout). */
const COLUMN: Readonly<Record<PListLegendKey, number>> = { note: 0, tone: 1, cmd1: 4, cmd2: 5 };

const LABEL: Readonly<Record<PListLegendKey, string>> = {
  note: 'Note',
  tone: 'Tone',
  cmd1: 'Command 1',
  cmd2: 'Command 2',
};

const TITLE: Readonly<Record<PListLegendKey, string>> = {
  note:
    'The pitch this step plays. +05 is 5 semitones above the key played; a note name such as C-2 is a fixed pitch, ' +
    'whatever key is played. --- keeps the pitch as it was.',
  tone: 'The tone this step selects: TR triangle, SA sawtooth, SQ square, NO noise. .. keeps the current tone.',
  cmd1:
    'The first command: a command digit and a two-digit parameter, both in hex, for example 50A. ... means no command. ' +
    'The table below names each command.',
  cmd2:
    'The second command, in the same form as command 1: a command digit and a two-digit hex parameter. ... means no command.',
};

/** The four legend cells for a track `trackWidth` px wide (the canvas's own column geometry). */
export function plistLegendCells(trackWidth: number = PLIST_TRACK_WIDTH_PX): PListLegendCell[] {
  const offsets = columnFractionOffsets(trackWidth, trackColumns(true, true));
  return (Object.keys(COLUMN) as PListLegendKey[]).map((key) => {
    const column = COLUMN[key];
    return {
      key,
      label: LABEL[key],
      x: GUTTER_WIDTH_PX + entryHorizontalInsetPx + offsets[column]!,
      width: offsets[column + 1]! - offsets[column]!,
      title: TITLE[key],
    };
  });
}
