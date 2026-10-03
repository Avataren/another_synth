import {
  a2mEntrySignature,
  formatInstrumentId,
  midiToTrackerNote,
  parseTrackerNoteSymbol,
  type TrackerEntryData,
  type TrackerPattern,
} from '@another-synth/tracker-playback';
import {
  a2mDocOf,
  a2mText,
  type A2mDoc,
  type A2mPatternJson,
  type A2mSongJson,
  type A2mSparseCell,
} from 'src/audio/tracker/a2m-codec';

/**
 * Adlib Tracker II's song, to and from the tracker's grid.
 *
 * The grid shows what the module holds: notes (AT2's note 1 is C-0), key-off
 * as `###`, the instrument number, and both effect columns in AT2's own
 * letters (`0`..`Z`, `&`, `%`, ...) with the parameter in hex. It is the
 * module's own numbering for the module's own version, nothing converted; the
 * one thing the text cannot say (a fixed note, a note number past the
 * keyboard) rides along as `a2mCell` while the row is untouched.
 *
 * `compileA2mSong` is the way back: the doc (everything that is not a
 * pattern) plus the grid make the song `a2m_from_json` writes, and that file
 * is what plays and what is exported.
 */

/** AT2's effect letters by effect number (`techinfo.htm`'s table: 0x00..0x2F). */
export const A2M_EFFECT_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ&%!@=#$~^`><';
const KEY_OFF = 255;
/** AT2's note 1 is C-0: MIDI 12. */
const NOTE_TO_MIDI = 11;
const MAX_NOTE = 96;
/** `0x90 + note` is a "fixed" note: it plays as the note and the editor will not transpose it. */
const FIXED_NOTE_FLAG = 0x90;
const MAX_ORDERS = 128;
const ORDER_MARKER = 0x80;

type Cell6 = [number, number, number, number, number, number];

const hex2 = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');

/** One effect column as AT2 writes it, or undefined for an empty one. */
export function a2mEffectColumnText(fx: number, param: number): string | undefined {
  if (fx === 0 && param === 0) return undefined;
  const letter = A2M_EFFECT_CHARS[fx];
  return letter === undefined ? `?${hex2(param)}` : `${letter}${hex2(param)}`;
}

/** An effect column's `[effect, param]`; `[0, 0]` for an empty or unreadable one. */
export function parseA2mEffectColumn(text: string | undefined): [number, number] {
  const t = (text ?? '').trim().toUpperCase();
  const match = /^(.)([0-9A-F]{2})$/.exec(t);
  if (!match) return [0, 0];
  const fx = A2M_EFFECT_CHARS.indexOf(match[1]!);
  return fx < 0 ? [0, 0] : [fx, Number.parseInt(match[2]!, 16)];
}

/** The grid's id for pattern number `pattern`. Stable, so a reload keeps a selection. */
export function a2mPatternId(pattern: number): string {
  return `a2m-pat-${pattern}`;
}

function noteText(note: number): string | undefined {
  if (note === 0) return undefined;
  if (note === KEY_OFF) return '###';
  const plain = note > FIXED_NOTE_FLAG && note <= FIXED_NOTE_FLAG + MAX_NOTE ? note - FIXED_NOTE_FLAG : note;
  return midiToTrackerNote(Math.min(127, plain + NOTE_TO_MIDI));
}

/** The grid entry for a cell, or undefined for an empty one. */
export function a2mCellToEntry(row: number, cell: Cell6): TrackerEntryData | undefined {
  const [note, instrument, fx1, p1, fx2, p2] = cell;
  const macro = a2mEffectColumnText(fx1, p1);
  const macro2 = a2mEffectColumnText(fx2, p2);
  if (note === 0 && instrument === 0 && macro === undefined && macro2 === undefined) return undefined;
  const entry: TrackerEntryData = { row };
  const text = noteText(note);
  if (text !== undefined) entry.note = text;
  if (instrument > 0) entry.instrument = formatInstrumentId(instrument);
  if (macro !== undefined) entry.macro = macro;
  if (macro2 !== undefined) entry.macro2 = macro2;
  // Only a cell the text cannot say keeps its bytes.
  const derived = derivedCell(entry);
  if (derived.some((v, i) => v !== cell[i])) {
    entry.a2mCell = [...cell] as Cell6;
    entry.a2mSig = a2mEntrySignature(entry);
  }
  return entry;
}

function derivedCell(entry: TrackerEntryData): Cell6 {
  let note = 0;
  if (entry.note === '###') note = KEY_OFF;
  else if (entry.note) {
    const parsed = parseTrackerNoteSymbol(entry.note);
    if (parsed.midi !== undefined) {
      const n = parsed.midi - NOTE_TO_MIDI;
      note = n >= 1 && n <= MAX_NOTE ? n : 0;
    }
  }
  const id = Number.parseInt(entry.instrument ?? '', 10);
  const instrument = Number.isFinite(id) && id > 0 && id <= 255 ? id : 0;
  const [fx1, p1] = parseA2mEffectColumn(entry.macro);
  const [fx2, p2] = parseA2mEffectColumn(entry.macro2);
  return [note, instrument, fx1, p1, fx2, p2];
}

/** The cell a grid entry stands for: its own bytes while the row is as imported, else derived from the text. */
export function a2mEntryToCell(entry: TrackerEntryData): Cell6 {
  if (entry.a2mCell && entry.a2mSig === a2mEntrySignature(entry)) return [...entry.a2mCell] as Cell6;
  return derivedCell(entry);
}

/** Rows and tracks of a file's patterns, by version (`rust-wasm/src/opl/a2/model.rs` `layout`). */
export function a2mLayout(version: number): { rows: number; channels: number; maxPatterns: number } {
  if (version <= 4) return { rows: 64, channels: 9, maxPatterns: 64 };
  if (version <= 8) return { rows: 64, channels: 18, maxPatterns: 64 };
  return { rows: 256, channels: 20, maxPatterns: 128 };
}

/** The leading order entries that name patterns: what the grid's sequence shows. */
export function a2mOrderPatterns(order: ReadonlyArray<number>): number[] {
  const out: number[] = [];
  for (const entry of order) {
    if (entry >= ORDER_MARKER) break;
    out.push(entry);
  }
  return out;
}

/**
 * How many patterns the grid holds: the file's, and one more than the highest
 * the order names (the player plays a pattern past the file's count as an
 * empty one, or as a spare one the file's last block holds).
 */
function patternCount(song: A2mSongJson): number {
  const top = Math.max(-1, ...a2mOrderPatterns(song.order));
  return Math.min(a2mLayout(song.version).maxPatterns, Math.max(song.patterns.length, top + 1));
}

function buildPattern(song: A2mSongJson, n: number, source: A2mPatternJson | undefined): TrackerPattern {
  const rows = song.pattern_len;
  const tracks = song.tracks;
  const byTrack: TrackerEntryData[][] = Array.from({ length: tracks }, () => []);
  // Sparse cells arrive row-major, so each track's entries come out in row order.
  for (const [row, ch, ...rest] of source?.cells ?? []) {
    if (row >= rows || ch >= tracks) continue;
    const entry = a2mCellToEntry(row, rest as Cell6);
    if (entry) byTrack[ch]!.push(entry);
  }
  const named = a2mText(song.pattern_names[n] ?? []).trim();
  return {
    id: a2mPatternId(n),
    name: named || `Pattern ${n}`,
    rows,
    tracks: byTrack.map((entries, t) => ({ id: `${a2mPatternId(n)}-t${t}`, name: `Ch ${t + 1}`, entries })),
  };
}

/** The grid's patterns and sequence for `song`. */
export function a2mGridOf(song: A2mSongJson): { patterns: TrackerPattern[]; sequence: string[] } {
  const count = patternCount(song);
  const patterns: TrackerPattern[] = [];
  for (let n = 0; n < count; n++) {
    patterns.push(buildPattern(song, n, song.patterns[n] ?? song.spare_patterns[n - song.patterns.length]));
  }
  // An order entry past this version's pattern limit names nothing the file can hold (v1-8 hold 64).
  return { patterns, sequence: a2mOrderPatterns(song.order).filter((n) => n < count).map(a2mPatternId) };
}

/** A song the format cannot hold; the message is for the user. */
export class A2mCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'A2mCompileError';
  }
}

/** What compiling the grid dropped, for a note under the export. */
export interface A2mCompileNotes {
  /** Notes outside C-0..B-7, which AT2 cannot hold. */
  notesOutOfRange: number;
}

/**
 * The song `doc`, `patterns` and `sequence` make. Pattern `n` is the grid's
 * n-th pattern; the order list is the sequence followed by the doc's own
 * jump/end markers, which the grid does not show.
 */
export function compileA2mSong(
  doc: A2mDoc,
  patterns: ReadonlyArray<TrackerPattern>,
  sequence: ReadonlyArray<string>,
  notes?: A2mCompileNotes,
): A2mSongJson {
  const layout = a2mLayout(doc.version);
  if (patterns.length === 0) throw new A2mCompileError('The song has no patterns.');
  if (patterns.length > layout.maxPatterns) {
    throw new A2mCompileError(
      `Adlib Tracker II (version ${doc.version}) holds ${layout.maxPatterns} patterns at most; this song has ${patterns.length}.`,
    );
  }
  if (sequence.length === 0) throw new A2mCompileError('The song has an empty order list.');
  const index = new Map(patterns.map((p, i) => [p.id, i]));
  const order = sequence.map((id) => {
    const at = index.get(id);
    if (at === undefined) throw new A2mCompileError(`The order list names a pattern that does not exist (${id}).`);
    return at;
  });
  const marker = doc.order.findIndex((b) => b >= ORDER_MARKER);
  const tail = marker < 0 ? [] : doc.order.slice(marker);
  if (order.length > MAX_ORDERS) {
    throw new A2mCompileError(`An order list holds ${MAX_ORDERS} positions at most; this one has ${order.length}.`);
  }
  const fullOrder = [...order, ...tail, ...new Array<number>(MAX_ORDERS).fill(ORDER_MARKER)].slice(0, MAX_ORDERS);

  const tracks = doc.tracks;
  let longest = 1;
  const compiled: A2mPatternJson[] = patterns.map((p) => {
    longest = Math.max(longest, p.rows);
    const cells: A2mSparseCell[] = [];
    p.tracks.slice(0, tracks).forEach((track, ch) => {
      for (const entry of track.entries) {
        if (entry.row < 0 || entry.row >= layout.rows) continue;
        const cell = a2mEntryToCell(entry);
        if (entry.note && entry.note !== '###' && cell[0] === 0 && notes) notes.notesOutOfRange += 1;
        if (cell.some((v) => v !== 0)) cells.push([entry.row, ch, ...cell]);
      }
    });
    cells.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return { rows: layout.rows, channels: layout.channels, cells };
  });
  return {
    ...doc,
    order: fullOrder,
    pattern_len: Math.min(longest, layout.rows),
    patterns: compiled,
    spare_patterns: [],
  };
}

/** The doc half of a freshly parsed song. */
export function a2mDocFromSong(song: A2mSongJson): A2mDoc {
  return a2mDocOf(song);
}
