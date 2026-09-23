import {
  SID_NOTE_COUNT,
  formatInstrumentId,
  midiToTrackerNote,
  sidFreqRegToHz,
  sidNoteFreqReg,
  type TrackerEntryData,
  type TrackerPattern,
  type TrackerTrackData,
} from '@another-synth/tracker-playback';
import { SID_NOTE_FIRST, SID_NOTE_KEY_OFF, SID_NOTE_LAST, type SidDoc, type SidDocRow } from './types';

/**
 * The SID note table index (0 = C-0 .. 92 = G#7) a row note plays at under
 * `transpose`: clamped into the table, as the Rust player clamps it
 * (`player.rs`, `note_index`). `undefined` for a row with no note.
 */
export function sidNoteIndex(note: number, transpose: number): number | undefined {
  if (note < SID_NOTE_FIRST || note > SID_NOTE_LAST) return undefined;
  return Math.max(0, Math.min(SID_NOTE_COUNT - 1, note - SID_NOTE_FIRST + transpose));
}

/** C-0 (table index 0) is MIDI 12 in the tracker's note names (`midiToTrackerNote`: C-4 = 60). */
const SID_INDEX_TO_MIDI = 12;

/** The id of the grid pattern of position `index`: stable across projections. */
export function sidPositionPatternId(index: number): string {
  return `sid-pos-${index}`;
}

/** One play of a pattern on a channel's timeline: its `length` rows from song row `start`, under `transpose`. */
interface Segment {
  readonly start: number;
  readonly pattern: number;
  readonly transpose: number;
  readonly length: number;
}

/**
 * A channel's orderlist laid out in rows, long enough to cover `total` rows:
 * one pass from the start, then round again from `restart`, as the player
 * loops it.
 */
function channelTimeline(doc: SidDoc, channel: number, subsong: number, total?: number): Segment[] {
  const list = doc.subsongs[subsong]?.orderlists[channel];
  if (list === undefined) return [];
  const segments: Segment[] = [];
  let at = 0;
  const push = (index: number) => {
    const entry = list.entries[index];
    if (entry === undefined) return;
    const length = doc.patterns[entry.pattern]?.rows.length ?? 0;
    for (let r = 0; r < entry.repeat; r++) {
      segments.push({ start: at, pattern: entry.pattern, transpose: entry.transpose, length });
      at += length;
    }
  };
  for (let i = 0; i < list.entries.length; i++) push(i);
  if (total === undefined) return segments;
  while (at < total) {
    for (let i = list.restart; i < list.entries.length && at < total; i++) push(i);
  }
  return segments;
}

function rowToEntry(row: SidDocRow, index: number, transpose: number): TrackerEntryData | undefined {
  const noteIndex = sidNoteIndex(row.note, transpose);
  const keyOff = row.note === SID_NOTE_KEY_OFF;
  const hasCommand = row.command !== 0 || row.param !== 0;
  if (noteIndex === undefined && !keyOff && row.instrument === 0 && !hasCommand) return undefined;
  const entry: TrackerEntryData = { row: index };
  if (noteIndex !== undefined) {
    entry.note = midiToTrackerNote(noteIndex + SID_INDEX_TO_MIDI);
    // The pitch the chip sounds: the table's register, not equal temperament.
    entry.frequency = sidFreqRegToHz(sidNoteFreqReg(noteIndex));
  } else if (keyOff) {
    entry.note = '###';
  }
  if (row.instrument > 0) entry.instrument = formatInstrumentId(row.instrument);
  if (hasCommand) {
    entry.effectCommand = row.command;
    entry.effectParam = row.param;
    entry.macro = `${row.command.toString(16).toUpperCase()}${row.param.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return entry;
}

/**
 * The grid of a SID song (subsong `subsong`, default 0).
 *
 * The tracker's row model has one sequence of song-wide patterns; a SID song
 * has an orderlist per channel, and the three advance independently (a
 * channel may play two 32-row patterns while another plays one of 64). So
 * the song is laid out in rows per channel, its length is the longest
 * channel's first pass (a shorter one loops from its `restart`, as the player
 * loops it), and a position starts wherever ANY channel starts a pattern.
 * Each position therefore sits inside exactly one orderlist step per channel,
 * whose transpose is the position's `positionTranspose`. Notes are shown as
 * they sound (transposed) and carry the chip's own frequency (`frequency`,
 * the note table's register), which is what the TS engine plays for them.
 *
 * Display and TS-engine model only: the song plays in the Rust player from
 * the doc (`sid-file-codec.ts`), and S4 decides how an edit of this grid maps
 * back onto the doc's shared patterns.
 */
export function projectSidPatterns(doc: SidDoc, subsong = 0): TrackerPattern[] {
  const channels = doc.channels;
  const firstPass = Array.from({ length: channels }, (_, c) => channelTimeline(doc, c, subsong));
  const total = Math.max(...firstPass.map((segs) => segs.reduce((n, s) => n + s.length, 0)));
  const timelines = Array.from({ length: channels }, (_, c) => channelTimeline(doc, c, subsong, total));
  const starts = new Set<number>();
  for (const segs of timelines) for (const s of segs) if (s.start < total) starts.add(s.start);
  const bounds = [...starts].sort((a, b) => a - b);
  const cursor = new Array<number>(channels).fill(0);

  return bounds.map((start, index) => {
    const end = bounds[index + 1] ?? total;
    const tracks: TrackerTrackData[] = [];
    const positionTranspose: number[] = [];
    for (let c = 0; c < channels; c++) {
      const segs = timelines[c] as Segment[];
      let k = cursor[c] as number;
      while (k + 1 < segs.length && (segs[k + 1] as Segment).start <= start) k += 1;
      cursor[c] = k;
      const seg = segs[k] as Segment;
      const rows = doc.patterns[seg.pattern]?.rows ?? [];
      const entries: TrackerEntryData[] = [];
      for (let r = start; r < end; r++) {
        const row = rows[r - seg.start];
        if (row === undefined) continue;
        const entry = rowToEntry(row, r - start, seg.transpose);
        if (entry) entries.push(entry);
      }
      tracks.push({ id: `sid-ch-${c + 1}`, name: `Voice ${c + 1}`, entries });
      positionTranspose.push(seg.transpose);
    }
    return { id: sidPositionPatternId(index), name: `Position ${index}`, rows: end - start, tracks, positionTranspose };
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
