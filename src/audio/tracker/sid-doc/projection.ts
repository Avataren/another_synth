import type { TrackerPattern, TrackerTrackData } from '@another-synth/tracker-playback';
import { sidImpliedTempo, type SidFlatPattern, type SidFlatSubsong } from './flat';
import { sidCellEntries, sidGridLayout, sidRowToEntry } from './grid';
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
 * The song's tempo in the tracker's terms. A SID song ticks on the PAL frame
 * (50.1245 Hz, `player.rs` `frame_cycles`) times its multispeed and starts at
 * `sidImpliedTempo` ticks per row (the doc's tempo per 1x, as GoatTracker and
 * the Rust player start; an F command on the first row then sets its own);
 * the engine ticks at BPM * 2 / 5 Hz, so 50 Hz is 125 BPM (0.25 % slow of the
 * player, which owns the transport and reports its own row) and the ticks per
 * row are the speed. The engine's BPM stops at 255 and its speed at 31, so a
 * multispeed of 3 or more is carried at 250 BPM with the speed scaled to keep
 * the row rate (rounded: only the TS engine's clock, never the player's, is
 * approximated).
 */
export function sidDocTiming(doc: SidDoc): { bpm: number; initialSpeed: number } {
  const ticks = sidImpliedTempo(doc);
  const bpm = 125 * doc.speedMultiplier;
  if (bpm <= 255) return { bpm, initialSpeed: Math.max(1, Math.min(31, ticks)) };
  return { bpm: 250, initialSpeed: Math.max(1, Math.min(31, Math.round((ticks * 2) / doc.speedMultiplier))) };
}

/** The grid pattern of flat pattern `id` (`flat.ts`): its voices' rows as they sound, named `name`. */
export function projectSidFlatPattern(id: string, pattern: SidFlatPattern, name: string): TrackerPattern {
  const tracks: TrackerTrackData[] = pattern.cells.map((cell, c) => {
    const entries = [];
    for (let r = 0; r < pattern.rows; r++) {
      const entry = sidRowToEntry(cell.rows[r] as NonNullable<(typeof cell.rows)[number]>, r, cell.transpose);
      if (entry) entries.push(entry);
    }
    return { id: `sid-ch-${c + 1}`, name: `Voice ${c + 1}`, entries };
  });
  return { id, name, rows: pattern.rows, tracks, positionTranspose: pattern.cells.map((cell) => cell.transpose) };
}

/**
 * The grid of a flat subsong: one grid pattern per flat pattern, in the
 * flat's order, each named by `names` (a grid pattern's name is the editor's
 * own; the doc has none) or `Pattern <n>`.
 */
export function projectSidFlatSubsong(flat: SidFlatSubsong, names: Readonly<Record<string, string>> = {}): TrackerPattern[] {
  return Object.entries(flat.patterns).map(([id, pattern], index) => projectSidFlatPattern(id, pattern, names[id] ?? `Pattern ${index}`));
}
