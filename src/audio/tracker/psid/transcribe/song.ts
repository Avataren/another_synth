import {
  BLANK_SID_ROW,
  SID_MAX_PATTERN_ROWS,
  SID_NOTE_FIRST,
  SID_NOTE_KEY_OFF,
  SID_NOTE_LAST,
  type SidDocRow,
  type SidFlatCell,
  type SidFlatPattern,
  type SidFlatSubsong,
} from 'src/audio/tracker/sid-doc';
import type { TraceFrames } from './frames';
import { rowOfFrame, rowStart, type RowGrid } from './grid';
import type { NoteProgram } from './notes';

/**
 * The rows of a transcribed subsong (plan-psid-import.md §3) and their flat
 * song: per voice a row per grid row (the note, its instrument), the start
 * tempo on row 0 of voice 1 (`F`, or funktempo `E` with the two lengths in
 * a speed-table row), and the loop: the trace's own when the capture found
 * the machine repeating, else the shortest repeating tail of the rows.
 */

export interface SubsongRows {
  /** Per voice, one row per grid row. */
  readonly voices: readonly SidDocRow[][];
  /** Rows the song plays before it loops (the loop's end). */
  readonly length: number;
  /** The row the song loops back to. */
  readonly loopRow: number;
  /** Where the loop came from. */
  readonly loop: 'exact' | 'found' | 'none';
}

/** A row's note for GoatTracker note index `index` (clamped to the rows' range C-0..G#7). */
const rowNote = (index: number): number => Math.max(SID_NOTE_FIRST, Math.min(SID_NOTE_LAST, index + 1));

/** Where a subsong loops, in rows: it plays rows [0, length) and continues at `loopRow`. */
export interface SongLoop {
  readonly loopRow: number;
  readonly length: number;
  readonly kind: 'exact' | 'found' | 'none';
}

/**
 * Where the transcribed subsong loops: the trace's own loop when the capture
 * found the machine repeating (`loopFrame`), else the shortest repeating tail
 * of the notes (`noteKeys`: per row, what each voice starts there), else the
 * end of the capture back to the start.
 */
export function findLoop(f: TraceFrames, grid: RowGrid, noteKeys: readonly string[]): SongLoop {
  const length = noteKeys.length;
  if (f.loopFrame !== null) {
    // Frames [loopFrame, end) repeat: the rows from the one before the loop frame
    // (a note's row starts a frame before its gate) to the row of the last frame.
    const loopRow = Math.max(0, Math.min(length - 1, rowOfFrame(grid, f.loopFrame - 1)));
    const end = Math.max(loopRow + 1, rowOfFrame(grid, f.frames - 1));
    return { loopRow, length: end, kind: 'exact' };
  }
  // The last row's notes are cut short by the end of the capture: not compared.
  const found = repeatingTail(noteKeys.slice(0, -1));
  if (found !== null) return { loopRow: found.start, length: found.start + found.period, kind: 'found' };
  return { loopRow: 0, length, kind: 'none' };
}

/**
 * The rows of a subsong, `loop.length` long: `instrumentOf` gives each
 * note's instrument number (1-based), `tempoRow` the command on row 0 of
 * voice 1 (or null).
 */
export function subsongRows(
  loop: SongLoop,
  grid: RowGrid,
  programs: readonly NoteProgram[],
  instrumentOf: ReadonlyMap<NoteProgram, number>,
  gateTimerOf: (instrument: number) => number,
  tempo: readonly { readonly row: number; readonly length: number }[],
  commands: readonly { readonly row: number; readonly command: number; readonly param: number }[] = [],
): SubsongRows {
  const length = loop.length;
  const voices: SidDocRow[][] = [0, 1, 2].map(() => Array.from({ length }, () => BLANK_SID_ROW));
  // Every note names its instrument: a pattern then plays the same wherever it
  // is used (GoatTracker's packer drops the repeats).
  for (const p of programs) {
    if (p.note.row >= length) continue;
    voices[p.note.voice]![p.note.row] = { note: rowNote(p.base), instrument: instrumentOf.get(p) ?? 0, command: 0, param: 0 };
  }
  // Key-offs: GoatTracker clears the gate when it reads the row, the gate timer's
  // frames before the row starts; the row whose reading lands nearest the original's.
  for (const p of programs) {
    if (p.keyOff === null || p.note.row >= length) continue;
    const ins = instrumentOf.get(p) ?? 0;
    const at = p.note.tick0 + p.keyOff + gateTimerOf(ins);
    const k = rowOfFrame(grid, at);
    const row = at - rowStart(grid, k) <= rowStart(grid, k + 1) - at ? k : k + 1;
    const v = voices[p.note.voice]!;
    if (row <= p.note.row || row >= length) continue;
    // Only into empty rows before the voice's next note.
    let clear = true;
    for (let r = p.note.row + 1; r <= row; r++) if (v[r]!.note !== 0) clear = false;
    if (clear) v[row] = { ...v[row]!, note: SID_NOTE_KEY_OFF };
  }
  // Tempo commands (F sets every voice's) and the song's other commands, on the
  // first voice whose command is free.
  const all = [...tempo.map((t) => ({ row: t.row, command: 0xf, param: t.length })), ...commands];
  for (const { row, command, param } of all) {
    if (row >= length) continue;
    const v = voices.find((x) => x[row]!.command === 0);
    if (v !== undefined) v[row] = { ...v[row]!, command, param };
  }
  return { voices, length, loopRow: loop.loopRow, loop: loop.kind };
}

/**
 * The shortest period whose repetition runs to the end of `keys`, and where
 * it starts: at least two periods seen, at least 8 rows long.
 */
function repeatingTail(keys: readonly string[]): { start: number; period: number } | null {
  const length = keys.length;
  let best: { start: number; period: number } | null = null;
  for (let p = 8; p * 2 <= length; p++) {
    let s = length - p;
    while (s > 0 && keys[s - 1] === keys[s - 1 + p]) s--;
    if (length - s < 2 * p) continue;
    if (best === null || s + p < best.start + best.period) best = { start: s, period: p };
  }
  return best;
}

/**
 * The flat subsong of `rows`: positions of `patternRows` rows (the part
 * before the loop and the loop each cut on their own, so the loop starts a
 * position), identical positions sharing one pattern id. `prefix` makes ids
 * unique across subsongs.
 */
export function flatSubsong(rows: SubsongRows, patternRows: number, prefix: string): SidFlatSubsong {
  const size = Math.max(1, Math.min(SID_MAX_PATTERN_ROWS, patternRows));
  const cuts: [number, number][] = [];
  const cut = (from: number, to: number): void => {
    for (let r = from; r < to; r += size) cuts.push([r, Math.min(to, r + size)]);
  };
  cut(0, rows.loopRow);
  const loopIndex = cuts.length;
  cut(rows.loopRow, rows.length);
  const patterns: Record<string, SidFlatPattern> = {};
  const byKey = new Map<string, string>();
  const sequence: string[] = [];
  for (const [from, to] of cuts) {
    const cells: SidFlatCell[] = rows.voices.map((v) => ({ transpose: 0, rows: v.slice(from, to), start: true }));
    const key = cells.map((c) => c.rows.map((x) => `${x.note}.${x.instrument}.${x.command}.${x.param}`).join(',')).join('|');
    let id = byKey.get(key);
    if (id === undefined) {
      id = `${prefix}p${byKey.size}`;
      byKey.set(key, id);
      patterns[id] = { rows: to - from, cells };
    }
    sequence.push(id);
  }
  return { patterns, sequence, restarts: [loopIndex, loopIndex, loopIndex].map((i) => Math.min(i, sequence.length - 1)) };
}
