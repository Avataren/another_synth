import { SID_FILE_VERSION, makeSidDoc } from './doc';
import {
  GT_INSTRUMENT_NAME_LENGTH,
  GT_MAGIC_GT1,
  GT_MAGIC_GTS5,
  GT_SUBTUNE_COUNT_OFFSET,
  GT_TEXT_LENGTH,
  GT_TEXT_OFFSETS,
  GtFormatError,
  GtReader,
  decodeGtOrderlist,
  gtText,
  hex,
  magicOf,
  readGtOrderlists,
  type GtImportNote,
  type GtSongHints,
} from './gt-sng-common';
import { readGt1Song } from './gt-sng-gt1';
import {
  SID_CHANNELS,
  SID_DEFAULT_CHIP_MODEL,
  SID_DEFAULT_TEMPO,
  SID_MAX_INSTRUMENTS,
  SID_MAX_PATTERN_ROWS,
  SID_MAX_PATTERNS,
  SID_MAX_SUBSONGS,
  SID_NOTE_KEY_OFF,
  SID_NOTE_KEY_ON,
  SID_NOTE_NONE,
  SID_TABLE_NAMES,
  type SidDoc,
  type SidDocPattern,
  type SidDocRow,
  type SidInstrument,
  type SidSubsong,
  type SidTable,
  type SidTableName,
  type SidTables,
} from './types';

/**
 * GoatTracker `.sng` -> `SidDoc` (plan-sid-tracking.md S5). Dispatches on the
 * magic bytes, never the extension:
 *   - `GTS5`: GoatTracker 2's format, readme §6.1 (offsets cited per field);
 *   - `GTS!`: GoatTracker 1's, converted (`gt-sng-gt1.ts`);
 *   - `GTS2`/`GTS3`/`GTS4` (GT2 betas, none in the wild corpus): refused with
 *     the reason; anything else is not a GoatTracker song.
 * A file is read whole or refused whole: no partial doc ever leaves here.
 */

/** Readme §6.1.6: note bytes $60-$BC are C-0..G#7, the doc's notes 1..93. */
export const GT_NOTE_FIRST = 0x60;
export const GT_NOTE_LAST = 0xbc;
export const GT_NOTE_REST = 0xbd;
export const GT_NOTE_KEY_OFF = 0xbe;
export const GT_NOTE_KEY_ON = 0xbf;
export const GT_PATTERN_END = 0xff;
/** Readme §6.1.3: +0 AD, +1 SR, +2..+5 wave/pulse/filter/speed pointers, +6 vibrato delay, +7 gate timer, +8 first wave, +9 name. */
export const GT_INSTRUMENT_BYTES = 9 + GT_INSTRUMENT_NAME_LENGTH;
/** Readme §3.3: HR/Gate Timer bit $80 disables hard restart, $40 disables gate-off. */
export const GT_GATE_NO_HARD_RESTART = 0x80;
export const GT_GATE_NO_GATEOFF = 0x40;

export type GtSongVariant = 'GTS5' | 'GTS!';

export type GtSongImport =
  | {
      readonly ok: true;
      readonly doc: SidDoc;
      readonly variant: GtSongVariant;
      /** What the import inferred or could not carry, per occurrence (the D-log counts them). */
      readonly notes: readonly GtImportNote[];
    }
  | { readonly ok: false; readonly reason: string };

/** Whether `bytes` start like a GoatTracker song (any `GTS` magic, so a beta file gets its refusal). */
export function looksLikeGtSong(bytes: Uint8Array): boolean {
  return /^GTS[!2-5]$/.test(magicOf(bytes));
}

/**
 * The doc a `.sng` holds, or why it holds none. Never throws. `hints` carries
 * what the file cannot (GT's command-line chip model and speed multiplier).
 */
export function importGtSong(bytes: Uint8Array, hints: GtSongHints = {}): GtSongImport {
  const magic = magicOf(bytes);
  try {
    const notes: GtImportNote[] = [];
    let fields: SidDoc;
    let variant: GtSongVariant;
    if (magic === GT_MAGIC_GTS5) {
      fields = readGts5(bytes, notes, hints);
      variant = 'GTS5';
    } else if (magic === GT_MAGIC_GT1) {
      fields = readGt1Song(bytes, notes, docHeader(bytes, hints));
      variant = 'GTS!';
    } else if (/^GTS[234]$/.test(magic)) {
      return {
        ok: false,
        reason: `it is a GoatTracker 2 beta song (${magic}); only GTS5 (GoatTracker 2.59 on) and GTS! (GoatTracker 1) songs are read. Load and save it in a current GoatTracker to convert it`,
      };
    } else {
      return { ok: false, reason: 'it is not a GoatTracker song (no GTS5 or GTS! identification string)' };
    }
    return { ok: true, doc: makeSidDoc(fields), variant, notes };
  } catch (error) {
    if (error instanceof GtFormatError) return { ok: false, reason: error.message };
    return { ok: false, reason: `its data does not make a valid SID song (${(error as Error).message})` };
  }
}

/** The doc fields every variant shares: the §6.1.1 header texts, and the hinted playback facts. */
export function docHeader(bytes: Uint8Array, hints: GtSongHints): Omit<SidDoc, 'subsongs' | 'patterns' | 'instruments' | 'tables'> {
  if (bytes.length < GT_SUBTUNE_COUNT_OFFSET + 1) throw new GtFormatError('the file ends inside the song header');
  const [name, author, copyright] = GT_TEXT_OFFSETS.map((at) => gtText(bytes.subarray(at, at + GT_TEXT_LENGTH))) as [string, string, string];
  return {
    format: 'sid',
    version: SID_FILE_VERSION,
    songName: name,
    author,
    copyright,
    chipModel: hints.chipModel ?? SID_DEFAULT_CHIP_MODEL,
    channels: SID_CHANNELS,
    speedMultiplier: hints.speedMultiplier ?? 1,
    // A .sng has no tempo field: GoatTracker starts every song at 6 (readme §3.2 FXY). INFERRED default.
    tempo: SID_DEFAULT_TEMPO,
  };
}

/** Readme §6.1.6 note byte -> doc note. */
function gtNote(b: number, where: string): number {
  if (b >= GT_NOTE_FIRST && b <= GT_NOTE_LAST) return b - GT_NOTE_FIRST + 1;
  if (b === GT_NOTE_REST) return SID_NOTE_NONE;
  if (b === GT_NOTE_KEY_OFF) return SID_NOTE_KEY_OFF;
  if (b === GT_NOTE_KEY_ON) return SID_NOTE_KEY_ON;
  throw new GtFormatError(`${where}: note byte $${hex(b)} is not a GoatTracker note`);
}

interface Gts5Structure {
  orderlists: Uint8Array[][];
  instruments: Uint8Array[];
  tables: { left: Uint8Array; right: Uint8Array }[];
  patterns: Uint8Array[];
}

/** The §6.1 sections, read blind (byte counts only), for `channels` orderlists per subtune. */
function readGts5Structure(bytes: Uint8Array, channels: number): Gts5Structure {
  const r = new GtReader(bytes, GT_SUBTUNE_COUNT_OFFSET);
  const subtunes = r.byte('the song header');
  if (subtunes < 1 || subtunes > SID_MAX_SUBSONGS) throw new GtFormatError(`it declares ${subtunes} subtunes; a song has 1-${SID_MAX_SUBSONGS}`);
  const orderlists = readGtOrderlists(r, subtunes, channels);
  const instrumentCount = r.byte('the instrument count');
  if (instrumentCount > SID_MAX_INSTRUMENTS) throw new GtFormatError(`it declares ${instrumentCount} instruments; a song has at most ${SID_MAX_INSTRUMENTS}`);
  const instruments = Array.from({ length: instrumentCount }, (_, i) => r.take(GT_INSTRUMENT_BYTES, `instrument ${i + 1}`));
  const tables = SID_TABLE_NAMES.map((name) => {
    const n = r.byte(`the ${name} table`);
    return { left: r.take(n, `the ${name} table`), right: r.take(n, `the ${name} table`) };
  });
  const patternCount = r.byte('the pattern count');
  if (patternCount < 1 || patternCount > SID_MAX_PATTERNS) throw new GtFormatError(`it declares ${patternCount} patterns; a song has 1-${SID_MAX_PATTERNS}`);
  const patterns = Array.from({ length: patternCount }, (_, p) => {
    const m = r.byte(`pattern ${p}`);
    return r.take(m * 4, `pattern ${p}`);
  });
  if (r.left !== 0) throw new GtFormatError(`${r.left} bytes follow the last pattern`);
  return { orderlists, instruments, tables, patterns };
}

function readGts5(bytes: Uint8Array, notes: GtImportNote[], hints: GtSongHints): SidDoc {
  const header = docHeader(bytes, hints);
  let s: Gts5Structure;
  try {
    s = readGts5Structure(bytes, SID_CHANNELS);
  } catch (error) {
    // The S7 probe: a stereo (6-orderlist) song reads exactly as one. Say so
    // rather than blame the bytes.
    let dual = false;
    try {
      readGts5Structure(bytes, 2 * SID_CHANNELS);
      dual = true;
    } catch {
      // Not dual SID either: the first reason stands.
    }
    if (dual) throw new GtFormatError('it is a dual-SID (6-channel) song; dual SID is not supported yet (plan-sid-tracking.md S7)');
    throw error;
  }

  const patterns: SidDocPattern[] = s.patterns.map((data, p) => {
    const m = data.length / 4;
    // Measured: the stored length counts the $FF pattern-end row (readme §6.1.6 "Value $FF is pattern end").
    if (m < 2 || data[(m - 1) * 4] !== GT_PATTERN_END) throw new GtFormatError(`pattern ${p} does not end with the pattern-end row`);
    if (m - 1 > SID_MAX_PATTERN_ROWS) throw new GtFormatError(`pattern ${p} has ${m - 1} rows; a pattern has at most ${SID_MAX_PATTERN_ROWS}`);
    const rows: SidDocRow[] = [];
    for (let i = 0; i < m - 1; i++) {
      const where = `pattern ${p} row ${i}`;
      const [n, ins, cmd, param] = [data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!, data[i * 4 + 3]!];
      if (ins > s.instruments.length) throw new GtFormatError(`${where}: instrument ${ins} does not exist (the song has ${s.instruments.length})`);
      if (cmd > 0x0f) throw new GtFormatError(`${where}: command byte $${hex(cmd)} is not 0-F`);
      rows.push({ note: gtNote(n, where), instrument: ins, command: cmd, param });
    }
    return { rows };
  });

  const subsongs: SidSubsong[] = s.orderlists.map((lists, sub) => ({
    orderlists: lists.map((data, c) => {
      const { list, loopDiffers } = decodeGtOrderlist(data, `subtune ${sub} channel ${c + 1}`, patterns.length);
      if (loopDiffers) {
        notes.push({ kind: 'loop-transpose', message: `subtune ${sub} channel ${c + 1}: its loop replays with a running transpose/repeat the doc cannot hold; the first pass's is kept` });
      }
      return list;
    }),
  }));

  // Readme §6.1.4: 4 tables, each n left bytes then n right bytes.
  const tableRows = s.tables.map(({ left, right }) => Array.from(left, (l, i) => ({ left: l, right: right[i]! })));
  const instruments: SidInstrument[] = s.instruments.map((b, i) => {
    const gate = b[7]!;
    const noGateOff = (gate & GT_GATE_NO_GATEOFF) !== 0;
    const ptrs = [b[2]!, b[3]!, b[4]!, b[5]!];
    ptrs.forEach((ptr, t) => {
      const table = tableRows[t]!;
      if (ptr > table.length) {
        // GoatTracker's tables are 255 rows in memory and the file stores the
        // used prefix: past it are blank rows. INFERRED from the two corpus
        // instruments that point there.
        notes.push({ kind: 'table-padded', message: `instrument ${i + 1}: its ${SID_TABLE_NAMES[t]} pointer ${ptr} is past the table's ${table.length} rows; blank rows added` });
        while (table.length < ptr) table.push({ left: 0, right: 0 });
      }
    });
    return {
      name: gtText(b.subarray(9, 9 + GT_INSTRUMENT_NAME_LENGTH)),
      attack: b[0]! >> 4,
      decay: b[0]! & 0x0f,
      sustain: b[1]! >> 4,
      release: b[1]! & 0x0f,
      // A GT instrument has no waveform, pulse width or filter of its own: its
      // tables set them. The doc's neutral values say "none".
      waveform: 0,
      pulseWidth: 0,
      filter: { enabled: false, cutoff: 0, resonance: 0, mode: 0 },
      firstWave: b[8]!,
      gateTimer: gate & 0x3f,
      hardRestart: (gate & GT_GATE_NO_HARD_RESTART) === 0,
      noGateOff,
      vibratoDelay: b[6]!,
      wavePtr: ptrs[0]!,
      pulsePtr: ptrs[1]!,
      filterPtr: ptrs[2]!,
      speedPtr: ptrs[3]!,
    };
  });
  const tables = Object.fromEntries(SID_TABLE_NAMES.map((name, t) => [name, tableRows[t] as SidTable])) as Record<SidTableName, SidTable>;
  return { ...header, subsongs, patterns, instruments, tables: tables as SidTables };
}
