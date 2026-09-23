import { markRaw } from 'vue';
import {
  SID_CHANNELS,
  SID_DEFAULT_CHIP_MODEL,
  SID_DEFAULT_TEMPO,
  SID_MAX_INSTRUMENT_NAME_LENGTH,
  SID_MAX_INSTRUMENTS,
  SID_MAX_ORDER_ENTRIES,
  SID_MAX_PATTERN_ROWS,
  SID_MAX_PATTERNS,
  SID_MAX_REPEAT,
  SID_MAX_SPEED_MULTIPLIER,
  SID_MAX_SUBSONGS,
  SID_MAX_TABLE_ROWS,
  SID_MAX_TEMPO,
  SID_MAX_TEXT_LENGTH,
  SID_MAX_TRANSPOSE,
  SID_MIN_PATTERN_ROWS,
  SID_MIN_TRANSPOSE,
  SID_NOTE_FIRST,
  SID_NOTE_KEY_OFF,
  SID_NOTE_KEY_ON,
  SID_NOTE_LAST,
  SID_NOTE_NONE,
  SID_TABLE_NAMES,
  type SidDoc,
  type SidDocPattern,
  type SidDocRow,
  type SidInstrument,
  type SidOrderlist,
} from './types';

/** The codec version a doc is written as (`sid-file-codec.ts`). */
export const SID_FILE_VERSION = 1;

/** The one empty row. Shared by every blank cell of every pattern. */
export const BLANK_SID_ROW: SidDocRow = Object.freeze({ note: SID_NOTE_NONE, instrument: 0, command: 0, param: 0 });

export const isBlankSidRow = (row: SidDocRow): boolean =>
  row.note === SID_NOTE_NONE && row.instrument === 0 && row.command === 0 && row.param === 0;

export const sidRowsEqual = (a: SidDocRow, b: SidDocRow): boolean =>
  a.note === b.note && a.instrument === b.instrument && a.command === b.command && a.param === b.param;

/** A pattern of `rows` blank rows. */
export const blankSidPattern = (rows: number): SidDocPattern => ({ rows: Array.from({ length: rows }, () => BLANK_SID_ROW) });

/**
 * A plain instrument: a pulse wave at half width with a short envelope, no
 * tables, no filter, no hard restart. What a new song's instrument 1 is.
 */
export const DEFAULT_SID_INSTRUMENT: SidInstrument = Object.freeze({
  name: '',
  attack: 0,
  decay: 9,
  sustain: 0,
  release: 0,
  waveform: 0x40,
  pulseWidth: 0x800,
  filter: Object.freeze({ enabled: false, cutoff: 0, resonance: 0, mode: 0 }),
  firstWave: 0,
  gateTimer: 0,
  hardRestart: false,
  vibratoDelay: 0,
  wavePtr: 0,
  pulsePtr: 0,
  filterPtr: 0,
  speedPtr: 0,
});

/**
 * The single place a doc is made: raw (never a Vue Proxy: the store compares
 * docs and their patterns by identity) and frozen at the top level, so a stray
 * assignment throws in a test instead of corrupting shared structure. Patterns,
 * rows, orderlists and tables are shared between docs and are immutable by
 * type, not frozen. Throws when the fields break a rule of the model
 * (`sidDocProblem`): a doc that exists is one the codec can write.
 */
export function makeSidDoc(fields: SidDoc): SidDoc {
  const problem = sidDocProblem(fields);
  if (problem !== null) throw new Error(`Not a valid SID doc: ${problem}.`);
  return Object.freeze(markRaw({ ...fields }));
}

/** Voices of a SID doc: its `channels` (always `SID_CHANNELS` until dual SID, S7). */
export const sidDocChannels = (doc: SidDoc): number => doc.channels;

export interface NewSidDocOptions {
  songName?: string;
  chipModel?: SidDoc['chipModel'];
  speedMultiplier?: number;
  tempo?: number;
  patternRows?: number;
}

/**
 * A new song: one subsong whose three orderlists each play their own blank
 * pattern, one default instrument, empty tables.
 */
export function createNewSidDoc(options: NewSidDocOptions = {}): SidDoc {
  const rows = options.patternRows ?? 64;
  const patterns = Array.from({ length: SID_CHANNELS }, () => blankSidPattern(rows));
  const orderlists: SidOrderlist[] = patterns.map((_, channel) => ({
    entries: [{ pattern: channel, transpose: 0, repeat: 1 }],
    restart: 0,
  }));
  return makeSidDoc({
    format: 'sid',
    version: SID_FILE_VERSION,
    songName: options.songName ?? '',
    author: '',
    copyright: '',
    chipModel: options.chipModel ?? SID_DEFAULT_CHIP_MODEL,
    channels: SID_CHANNELS,
    speedMultiplier: options.speedMultiplier ?? 1,
    tempo: options.tempo ?? SID_DEFAULT_TEMPO,
    subsongs: [{ orderlists }],
    patterns,
    instruments: [DEFAULT_SID_INSTRUMENT],
    tables: { wave: [], pulse: [], filter: [], speed: [] },
  });
}

const isInt = (v: unknown, lo: number, hi: number): boolean =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/** Why `text` cannot be stored in a field of `max` latin-1 characters, or null. */
function textProblem(text: unknown, max: number, what: string): string | null {
  if (typeof text !== 'string') return `${what} is not text`;
  if (text.length > max) return `${what} is longer than ${max} characters`;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0xff) return `${what} has a character outside latin-1`;
  }
  return null;
}

const isNote = (note: number): boolean =>
  note === SID_NOTE_NONE || note === SID_NOTE_KEY_OFF || note === SID_NOTE_KEY_ON || (note >= SID_NOTE_FIRST && note <= SID_NOTE_LAST);

/** Why `row` is not a row of a song with `instruments` instruments, or null. */
export function sidRowProblem(row: SidDocRow, instruments: number): string | null {
  if (!isInt(row.note, 0, 255) || !isNote(row.note)) return `note ${String(row.note)} is not a note`;
  if (!isInt(row.instrument, 0, instruments)) return `instrument ${String(row.instrument)} does not exist`;
  if (!isInt(row.command, 0, 0xf)) return `command ${String(row.command)} is not 0-F`;
  if (!isInt(row.param, 0, 0xff)) return `parameter ${String(row.param)} is not a byte`;
  return null;
}

/** Why `ins` breaks a rule of the model, or null. */
export function sidInstrumentProblem(ins: SidInstrument, tableRows: Readonly<Record<'wave' | 'pulse' | 'filter' | 'speed', number>>): string | null {
  const name = textProblem(ins.name, SID_MAX_INSTRUMENT_NAME_LENGTH, 'the name');
  if (name !== null) return name;
  for (const key of ['attack', 'decay', 'sustain', 'release'] as const) {
    if (!isInt(ins[key], 0, 15)) return `${key} is not 0-15`;
  }
  if (!isInt(ins.waveform, 0, 0xff) || (ins.waveform & 0x01) !== 0) return 'the waveform is not a control byte without the gate bit';
  if (!isInt(ins.pulseWidth, 0, 0xfff)) return 'the pulse width is not 0-4095';
  const f = ins.filter;
  if (typeof f !== 'object' || f === null || typeof f.enabled !== 'boolean') return 'the filter is not a filter setting';
  if (!isInt(f.cutoff, 0, 0x7ff)) return 'the filter cutoff is not 0-2047';
  if (!isInt(f.resonance, 0, 15)) return 'the filter resonance is not 0-15';
  if (!isInt(f.mode, 0, 7)) return 'the filter mode is not 0-7';
  if (!isInt(ins.firstWave, 0, 0xff)) return 'the first-frame waveform is not a byte';
  if (!isInt(ins.gateTimer, 0, 63)) return 'the gate timer is not 0-63';
  if (typeof ins.hardRestart !== 'boolean') return 'hard restart is not on or off';
  if (!isInt(ins.vibratoDelay, 0, 0xff)) return 'the vibrato delay is not a byte';
  const ptrs = [
    ['wavePtr', 'wave'],
    ['pulsePtr', 'pulse'],
    ['filterPtr', 'filter'],
    ['speedPtr', 'speed'],
  ] as const;
  for (const [key, table] of ptrs) {
    if (!isInt(ins[key], 0, tableRows[table])) return `${key} points past the ${table} table`;
  }
  return null;
}

/**
 * Why `doc` breaks a rule of the model, or null. Every rule is one the codec
 * relies on to write the doc in its fixed-width fields, so a doc with no
 * problem always serializes, and what it reads back is equal to it.
 */
export function sidDocProblem(doc: SidDoc): string | null {
  if (doc.format !== 'sid') return 'it is not a SID doc';
  if (doc.version !== SID_FILE_VERSION) return `version ${String(doc.version)} is not ${SID_FILE_VERSION}`;
  for (const [text, what] of [
    [doc.songName, 'the song name'],
    [doc.author, 'the author'],
    [doc.copyright, 'the copyright'],
  ] as const) {
    const problem = textProblem(text, SID_MAX_TEXT_LENGTH, what);
    if (problem !== null) return problem;
  }
  if (doc.chipModel !== '8580' && doc.chipModel !== '6581') return `chip model ${String(doc.chipModel)} is not 8580 or 6581`;
  if (doc.channels !== SID_CHANNELS) return `a SID song has ${SID_CHANNELS} channels`;
  if (!isInt(doc.speedMultiplier, 1, SID_MAX_SPEED_MULTIPLIER)) return `the speed multiplier is not 1-${SID_MAX_SPEED_MULTIPLIER}`;
  if (!isInt(doc.tempo, 1, SID_MAX_TEMPO)) return `the tempo is not 1-${SID_MAX_TEMPO}`;
  if (!Array.isArray(doc.patterns) || doc.patterns.length < 1 || doc.patterns.length > SID_MAX_PATTERNS) {
    return `a song has 1-${SID_MAX_PATTERNS} patterns`;
  }
  if (!Array.isArray(doc.instruments) || doc.instruments.length > SID_MAX_INSTRUMENTS) return `a song has 0-${SID_MAX_INSTRUMENTS} instruments`;
  const tables = doc.tables;
  if (typeof tables !== 'object' || tables === null) return 'the tables are missing';
  for (const name of SID_TABLE_NAMES) {
    const table = tables[name];
    if (!Array.isArray(table) || table.length > SID_MAX_TABLE_ROWS) return `the ${name} table has more than ${SID_MAX_TABLE_ROWS} rows`;
    for (const [i, row] of table.entries()) {
      if (!isInt(row?.left, 0, 0xff) || !isInt(row?.right, 0, 0xff)) return `${name} table row ${i + 1} is not two bytes`;
    }
  }
  const tableRows = {
    wave: tables.wave.length,
    pulse: tables.pulse.length,
    filter: tables.filter.length,
    speed: tables.speed.length,
  };
  for (const [i, ins] of doc.instruments.entries()) {
    const problem = sidInstrumentProblem(ins, tableRows);
    if (problem !== null) return `instrument ${i + 1}: ${problem}`;
  }
  for (const [p, pattern] of doc.patterns.entries()) {
    const rows = pattern?.rows;
    if (!Array.isArray(rows) || rows.length < SID_MIN_PATTERN_ROWS || rows.length > SID_MAX_PATTERN_ROWS) {
      return `pattern ${p} has not ${SID_MIN_PATTERN_ROWS}-${SID_MAX_PATTERN_ROWS} rows`;
    }
    for (const [r, row] of rows.entries()) {
      const problem = sidRowProblem(row, doc.instruments.length);
      if (problem !== null) return `pattern ${p} row ${r}: ${problem}`;
    }
  }
  if (!Array.isArray(doc.subsongs) || doc.subsongs.length < 1 || doc.subsongs.length > SID_MAX_SUBSONGS) {
    return `a song has 1-${SID_MAX_SUBSONGS} subsongs`;
  }
  for (const [s, subsong] of doc.subsongs.entries()) {
    const lists = subsong?.orderlists;
    if (!Array.isArray(lists) || lists.length !== doc.channels) return `subsong ${s} has not one orderlist per channel`;
    for (const [c, list] of lists.entries()) {
      const where = `subsong ${s} channel ${c + 1}`;
      if (!Array.isArray(list.entries) || list.entries.length < 1 || list.entries.length > SID_MAX_ORDER_ENTRIES) {
        return `${where}: an orderlist has 1-${SID_MAX_ORDER_ENTRIES} entries`;
      }
      if (!isInt(list.restart, 0, list.entries.length - 1)) return `${where}: the restart is past the end`;
      for (const [e, entry] of list.entries.entries()) {
        if (!isInt(entry.pattern, 0, doc.patterns.length - 1)) return `${where} entry ${e}: pattern ${String(entry.pattern)} does not exist`;
        if (!isInt(entry.transpose, SID_MIN_TRANSPOSE, SID_MAX_TRANSPOSE)) return `${where} entry ${e}: the transpose is out of range`;
        if (!isInt(entry.repeat, 1, SID_MAX_REPEAT)) return `${where} entry ${e}: the repeat is not 1-${SID_MAX_REPEAT}`;
      }
    }
  }
  return null;
}
