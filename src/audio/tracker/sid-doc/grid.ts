import {
  SID_NOTE_COUNT,
  formatInstrumentId,
  midiToTrackerNote,
  parseTrackerNoteSymbol,
  sidFreqRegToHz,
  sidNoteFreqReg,
  type TrackerEntryData,
} from '@another-synth/tracker-playback';
import { BLANK_SID_ROW } from './doc';
import {
  SID_CHANNELS,
  SID_NOTE_FIRST,
  SID_NOTE_KEY_OFF,
  SID_NOTE_LAST,
  type SidDoc,
  type SidDocRow,
} from './types';

/**
 * The grid of a SID song and the way back from it (plan-sid-tracking.md S4).
 *
 * The tracker's row model is one sequence of song-wide patterns; a SID song
 * has an orderlist per channel over a shared pool of patterns, and the three
 * advance independently. `sidGridLayout` lays the song out in rows per
 * channel and cuts a grid position wherever ANY channel starts a pattern
 * (S3's projection rule), so each (position, channel) cell is a contiguous
 * slice of exactly ONE pattern, played under one orderlist transpose: its
 * `SidGridCell`. That is what makes the grid editable:
 *
 * THE EDIT MAPPING (S4's decision). An edit of a cell is an edit of the
 * pattern slice the cell shows: row `r` of the cell is row `offset + r` of
 * `pattern`, and a typed note is stored un-transposed (`note - transpose`).
 * Because patterns are shared, the edit shows everywhere that slice plays:
 * every other cell of the same pattern (another channel, a repeat, a later
 * orderlist entry, a looped pass) is re-projected. This is GoatTracker's own
 * model (a pattern is edited once and plays wherever an orderlist names it),
 * and the same "a shared track changes for every cell using it" rule the AHX
 * write-back follows. What the grid cannot do is change the orderlists: add or
 * remove positions, lengthen a pattern, reorder. Those stay refused in the
 * grid (the song's structure is its doc's).
 *
 * The projection is `projectSidPatterns` (projection.ts), built on the same
 * layout, so the two cannot disagree about which slice a cell is.
 */

/** One grid cell: which slice of which pattern it shows, and under which transpose. */
export interface SidGridCell {
  /** Index into `doc.patterns`. */
  readonly pattern: number;
  /** The orderlist entry's transpose, in semitones. */
  readonly transpose: number;
  /** The pattern row the cell's row 0 is. */
  readonly offset: number;
  /** Rows the cell shows (the position's length). */
  readonly rows: number;
}

export interface SidGridLayout {
  /** Song row each position starts at; `starts.length` positions. */
  readonly starts: readonly number[];
  /** The song's length in rows: the longest channel's first pass. */
  readonly total: number;
  /** `cells[position][channel]`. */
  readonly cells: readonly (readonly SidGridCell[])[];
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

/** The song laid out as grid positions (subsong `subsong`, default 0). See the file header. */
export function sidGridLayout(doc: SidDoc, subsong = 0): SidGridLayout {
  const channels = doc.channels;
  const firstPass = Array.from({ length: channels }, (_, c) => channelTimeline(doc, c, subsong));
  const total = Math.max(...firstPass.map((segs) => segs.reduce((n, s) => n + s.length, 0)));
  const timelines = Array.from({ length: channels }, (_, c) => channelTimeline(doc, c, subsong, total));
  const starts = new Set<number>();
  for (const segs of timelines) for (const s of segs) if (s.start < total) starts.add(s.start);
  const bounds = [...starts].sort((a, b) => a - b);
  const cursor = new Array<number>(channels).fill(0);
  const cells = bounds.map((start, index) => {
    const end = bounds[index + 1] ?? total;
    const row: SidGridCell[] = [];
    for (let c = 0; c < channels; c++) {
      const segs = timelines[c] as Segment[];
      let k = cursor[c] as number;
      while (k + 1 < segs.length && (segs[k + 1] as Segment).start <= start) k += 1;
      cursor[c] = k;
      const seg = segs[k] as Segment;
      row.push({ pattern: seg.pattern, transpose: seg.transpose, offset: start - seg.start, rows: end - start });
    }
    return row;
  });
  return { starts: bounds, total, cells };
}

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
export const SID_INDEX_TO_MIDI = 12;
/** The MIDI range a SID note can be typed in: C-0 .. G#7. */
export const SID_MIN_INPUT_MIDI = SID_INDEX_TO_MIDI;
export const SID_MAX_INPUT_MIDI = SID_INDEX_TO_MIDI + SID_NOTE_COUNT - 1;

/** A doc row as it shows in a cell under `transpose` (`undefined`: an empty cell). */
export function sidRowToEntry(row: SidDocRow, index: number, transpose: number): TrackerEntryData | undefined {
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

/** The entries a cell shows. */
export function sidCellEntries(doc: SidDoc, cell: SidGridCell): TrackerEntryData[] {
  const rows = doc.patterns[cell.pattern]?.rows ?? [];
  const entries: TrackerEntryData[] = [];
  for (let r = 0; r < cell.rows; r++) {
    const row = rows[cell.offset + r];
    if (row === undefined) continue;
    const entry = sidRowToEntry(row, r, cell.transpose);
    if (entry) entries.push(entry);
  }
  return entries;
}

const isMissing = (value: string | undefined): boolean => value === undefined || value === '';

/** Two entries show the same thing (key order and `undefined` fields aside). */
export function sidEntriesEqual(a: TrackerEntryData | undefined, b: TrackerEntryData | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof TrackerEntryData)[]);
  for (const key of keys) {
    const x = a[key];
    const y = b[key];
    if (x === undefined && y === undefined) continue;
    if (x !== y) return false;
  }
  return true;
}

const nibble = (char: string): number => (char === '.' ? 0 : Number.parseInt(char, 16));
const isNibble = (char: string): boolean => char === '.' || /^[0-9a-fA-F]$/.test(char);

/** What a SID row is stored as, from what a grid entry shows under `transpose`; or why it cannot be. */
function entryToSidRow(entry: TrackerEntryData, transpose: number, instruments: number): SidDocRow | { error: string } {
  const at = `Row ${entry.row}`;
  if (!isMissing(entry.volume) || !isMissing(entry.volumeCommand)) {
    return { error: `${at}: SID rows have no volume column: use the envelope (command 5/6) or the master volume (command D).` };
  }
  if (!isMissing(entry.macro2)) return { error: `${at}: SID rows have one command column.` };

  let note = 0;
  if (!isMissing(entry.note)) {
    const parsed = parseTrackerNoteSymbol(entry.note);
    if (parsed.isNoteOff) {
      note = SID_NOTE_KEY_OFF;
    } else if (parsed.midi === undefined) {
      return { error: `${at}: "${entry.note}" is not a note.` };
    } else {
      const index = parsed.midi - SID_INDEX_TO_MIDI;
      if (index < 0 || index >= SID_NOTE_COUNT) return { error: `${at}: SID notes go from C-0 to G#7.` };
      const stored = index - transpose + SID_NOTE_FIRST;
      if (stored < SID_NOTE_FIRST || stored > SID_NOTE_LAST) {
        const sign = transpose > 0 ? `+${transpose}` : `${transpose}`;
        return { error: `${at}: this position plays the pattern transposed ${sign}, so ${entry.note} would need a note outside C-0 to G#7.` };
      }
      note = stored;
    }
  }

  let instrument = 0;
  if (!isMissing(entry.instrument)) {
    if (!/^\d{1,3}$/.test(entry.instrument as string)) return { error: `${at}: "${entry.instrument}" is not an instrument number.` };
    instrument = Number(entry.instrument);
    if (instrument > instruments) {
      return { error: `${at}: instrument ${formatInstrumentId(instrument)} does not exist (this song has ${instruments}).` };
    }
  }

  let command = 0;
  let param = 0;
  if (!isMissing(entry.macro)) {
    const macro = entry.macro as string;
    if (macro.length !== 3 || ![...macro].every(isNibble)) {
      return { error: `${at}: "${macro}" is not a SID command (a hex digit and two hex digits).` };
    }
    command = nibble(macro.charAt(0));
    param = nibble(macro.charAt(1)) * 16 + nibble(macro.charAt(2));
  } else if (entry.effectCommand !== undefined || entry.effectParam !== undefined) {
    command = entry.effectCommand ?? 0;
    param = entry.effectParam ?? 0;
    if (!Number.isInteger(command) || command < 0 || command > 15 || !Number.isInteger(param) || param < 0 || param > 255) {
      return { error: `${at}: command ${command}/${param} does not fit a SID row.` };
    }
  }
  return { note, instrument, command, param };
}

/**
 * The inverse of `sidCellEntries`: a cell's entries as the pattern slice it
 * shows. A row whose entry still shows exactly what the doc row projects to
 * keeps the doc row itself (a key-on, a note the table clamped, bytes the
 * grid does not display), so only what was edited is re-encoded. Nothing is
 * guessed: an entry a SID row cannot hold, a row outside the cell or the same
 * row twice gives `{ error }` naming the first one. `frequency` is ignored:
 * it is the projection's pitch of the note, which the note decides.
 */
export function sidEntriesToRows(
  entries: readonly TrackerEntryData[],
  doc: SidDoc,
  cell: SidGridCell,
): SidDocRow[] | { error: string } {
  const source = doc.patterns[cell.pattern]?.rows ?? [];
  const byRow = new Map<number, TrackerEntryData>();
  for (const entry of entries) {
    if (!Number.isInteger(entry.row) || entry.row < 0 || entry.row >= cell.rows) {
      return { error: `Row ${entry.row} is outside this position (${cell.rows} rows).` };
    }
    if (byRow.has(entry.row)) return { error: `Row ${entry.row} appears twice.` };
    byRow.set(entry.row, entry);
  }
  const rows: SidDocRow[] = [];
  for (let r = 0; r < cell.rows; r++) {
    const original = source[cell.offset + r] ?? BLANK_SID_ROW;
    const entry = byRow.get(r);
    if (sidEntriesEqual(sidRowToEntry(original, r, cell.transpose), entry)) {
      rows.push(original);
      continue;
    }
    if (entry === undefined) {
      rows.push(BLANK_SID_ROW);
      continue;
    }
    const encoded = entryToSidRow(entry, cell.transpose, doc.instruments.length);
    if ('error' in encoded) return encoded;
    rows.push(encoded);
  }
  return rows;
}

/**
 * What an edit of a SID song wants to write, asked before anything changes
 * (the same checks the AHX gate takes, `AhxEditCheck`). `rows` is the
 * position's length (a paste's `entries` must fit it), `instruments` the
 * song's instrument count.
 */
export function sidEditRefusal(
  check:
    | { readonly kind: 'volume' | 'noteOff' | 'macro2' | 'interpolation' }
    | { readonly kind: 'macroLetter'; readonly char: string }
    | { readonly kind: 'instrument'; readonly value: number }
    | { readonly kind: 'note'; readonly midi: number }
    | { readonly kind: 'channels'; readonly count: number }
    | { readonly kind: 'entries'; readonly entries: readonly TrackerEntryData[] },
  shape: { readonly rows: number; readonly instruments: number },
): string | null {
  switch (check.kind) {
    case 'volume':
      return 'SID rows have no volume column: use the envelope (command 5/6) or the master volume (command D).';
    case 'noteOff':
      return null;
    case 'macro2':
      return 'SID rows have one command column.';
    case 'macroLetter':
      return `"${check.char}" is not a SID command: a command is a hex digit and two hex digits.`;
    case 'instrument':
      if (check.value >= 0 && check.value <= shape.instruments) return null;
      return `Instrument ${formatInstrumentId(check.value)} does not exist (this song has ${shape.instruments}): add it on the instrument page first.`;
    case 'note':
      return check.midi >= SID_MIN_INPUT_MIDI && check.midi <= SID_MAX_INPUT_MIDI ? null : 'SID notes go from C-0 to G#7.';
    case 'interpolation':
      return 'SID commands have no interpolation ranges.';
    case 'channels':
      return check.count === SID_CHANNELS ? null : `A SID song has exactly ${SID_CHANNELS} voices (this needs ${check.count}).`;
    case 'entries': {
      for (const entry of check.entries) {
        if (!Number.isInteger(entry.row) || entry.row < 0 || entry.row >= shape.rows) {
          const needed = check.entries.reduce((max, e) => Math.max(max, e.row + 1), 0);
          return `This needs ${needed} rows; this position has ${shape.rows}.`;
        }
        const encoded = entryToSidRow(entry, 0, shape.instruments);
        if ('error' in encoded) return encoded.error;
      }
      return null;
    }
  }
}
