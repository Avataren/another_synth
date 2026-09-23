import type { TrackerPattern, TrackerTrackData } from '@another-synth/tracker-playback';
import { sidCellEntries, sidGridLayout } from './grid';
import type { SidDoc } from './types';

export { sidNoteIndex } from './grid';

/** The id of the grid pattern of position `index`: stable across projections. */
export function sidPositionPatternId(index: number): string {
  return `sid-pos-${index}`;
}

/** The position index of a `sid-pos-<n>` id, or -1 for any other id. */
export function sidPositionIndexOf(patternId: string | null | undefined): number {
  const match = /^sid-pos-(\d+)$/.exec(patternId ?? '');
  return match ? Number(match[1]) : -1;
}

/**
 * The grid of a SID song (subsong `subsong`, default 0).
 *
 * The tracker's row model has one sequence of song-wide patterns; a SID song
 * has an orderlist per channel, and the three advance independently (a
 * channel may play two 32-row patterns while another plays one of 64). So
 * the song is laid out in rows per channel, its length is the longest
 * channel's first pass (a shorter one loops from its `restart`, as the player
 * loops it), and a position starts wherever ANY channel starts a pattern
 * (`sidGridLayout`). Each position therefore sits inside exactly one
 * orderlist step per channel, whose transpose is the position's
 * `positionTranspose`. Notes are shown as they sound (transposed) and carry
 * the chip's own frequency (`frequency`, the note table's register).
 *
 * The song plays in the Rust player from the doc (`sid-file-codec.ts`); an
 * edit of this grid goes back onto the doc's shared patterns through the same
 * layout (`grid.ts` header: the edit mapping, `syncSidWriteBack` in the store).
 */
export function projectSidPatterns(doc: SidDoc, subsong = 0): TrackerPattern[] {
  const layout = sidGridLayout(doc, subsong);
  return layout.cells.map((cells, index) => {
    const tracks: TrackerTrackData[] = cells.map((cell, c) => ({
      id: `sid-ch-${c + 1}`,
      name: `Voice ${c + 1}`,
      entries: sidCellEntries(doc, cell),
    }));
    return {
      id: sidPositionPatternId(index),
      name: `Position ${index}`,
      rows: cells[0]?.rows ?? 1,
      tracks,
      positionTranspose: cells.map((cell) => cell.transpose),
    };
  });
}

/**
 * The song's tempo in the tracker's terms. A SID song ticks at 50 Hz times
 * its multispeed and plays `tempo` ticks per row; the engine ticks at
 * BPM * 2 / 5 Hz, so 50 Hz is 125 BPM and the tempo is the speed. The
 * engine's BPM stops at 255, so a multispeed of 3 or more is carried at
 * 250 BPM with the speed scaled to keep the row rate (rounded: only the
 * TS engine's clock, never the player's, is approximated).
 */
export function sidDocTiming(doc: SidDoc): { bpm: number; initialSpeed: number } {
  const bpm = 125 * doc.speedMultiplier;
  if (bpm <= 255) return { bpm, initialSpeed: Math.min(31, doc.tempo) };
  return { bpm: 250, initialSpeed: Math.max(1, Math.min(31, Math.round((doc.tempo * 2) / doc.speedMultiplier))) };
}
