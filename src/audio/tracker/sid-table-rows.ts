import {
  SID_MAX_TABLE_ROWS,
  SID_TABLE_NAMES,
  makeSidDoc,
  sidDocProblem,
  type SidChipModel,
  type SidDoc,
  type SidDocPattern,
  type SidInstrument,
  type SidOpResult,
  type SidTableName,
  type SidTableRow,
} from 'src/audio/tracker/sid-doc';
import {
  hexByte,
  sidInstrumentFilterStart,
  sidInstrumentStartWidth,
  sidInstrumentWaveform,
  sidTableRowsFrom,
} from 'src/audio/tracker/sid-instrument-edit';
import { sidCutoffHz } from 'src/audio/tracker/sid-instrument-visuals';

/**
 * The SID page's table rows, for people rather than for the player: what a
 * row does in words (the player's semantics, `player.rs`'s header), which
 * instruments reach which rows, and the row edits GoatTracker's table editor
 * makes (insert and delete that keep every pointer on its data, starter
 * sequences an instrument is pointed at). Pure: each edit is a `SidOpResult`
 * for the store's `editSidDoc`, one undo step.
 */

/** The instrument field that points into each table. */
export const SID_TABLE_POINTER: Record<SidTableName, 'wavePtr' | 'pulsePtr' | 'filterPtr' | 'speedPtr'> = {
  wave: 'wavePtr',
  pulse: 'pulsePtr',
  filter: 'filterPtr',
  speed: 'speedPtr',
};

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const NOTE_NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];
/** Note table index as GoatTracker names it: 0 = C-0. */
export const sidNoteName = (index: number): string => `${NOTE_NAMES[index % 12]}${Math.floor(index / 12)}`;

const WAVE_BITS: ReadonlyArray<readonly [number, string]> = [
  [0x10, 'Tri'],
  [0x20, 'Saw'],
  [0x40, 'Pulse'],
  [0x80, 'Noise'],
];
const MOD_BITS: ReadonlyArray<readonly [number, string]> = [
  [0x04, 'ring'],
  [0x02, 'sync'],
  [0x08, 'test'],
];

/** A control byte's waveforms, e.g. `Pulse+Saw`, or `no waveform`. */
export function sidWaveformName(control: number): string {
  const waves = WAVE_BITS.filter(([bit]) => control & bit).map(([, name]) => name);
  return waves.length ? waves.join('+') : 'no waveform';
}

/** A control byte in full: waveforms, modulation and the gate, e.g. `Pulse, ring, gate on`. */
export function sidControlName(control: number, withGate = true): string {
  const parts = [sidWaveformName(control), ...MOD_BITS.filter(([bit]) => control & bit).map(([, name]) => name)];
  if (withGate) parts.push(control & 0x01 ? 'gate on' : 'gate off');
  return parts.join(', ');
}

/** The colour class of a control byte in the page's waveform lane. */
export function sidWaveClass(control: number): 'none' | 'tri' | 'saw' | 'pulse' | 'noise' | 'mixed' {
  const sel = control & 0xf0;
  if (sel === 0) return 'none';
  if (sel === 0x10) return 'tri';
  if (sel === 0x20) return 'saw';
  if (sel === 0x40) return 'pulse';
  if (sel === 0x80) return 'noise';
  return 'mixed';
}

const signed = (v: number): number => (v << 24) >> 24;
const plus = (v: number): string => (v >= 0 ? `+${v}` : String(v));

/** A wave-table row's note column (the arpeggio): relative, unchanged or absolute. */
export function sidWaveNoteText(right: number): string {
  if (right === 0x80) return 'same note';
  if (right < 0x80) return right === 0 ? 'note +0' : `note +${right}`;
  return `note ${sidNoteName(right & 0x7f)} (fixed)`;
}

const WAVE_COMMANDS: Record<number, string> = {
  0x1: 'slide up, speed row',
  0x2: 'slide down, speed row',
  0x3: 'glide, speed row',
  0x4: 'vibrato, speed row',
  0x5: 'attack/decay',
  0x6: 'sustain/release',
  0x7: 'waveform',
  0x9: 'pulse table from row',
  0xa: 'filter table from row',
  0xb: 'resonance/routing',
  0xc: 'cutoff',
  0xd: 'volume',
};

/** Where a `FF` row goes: a stop (right `00`, or past the table) or a jump. */
function jumpText(right: number, length: number): string {
  if (right === 0) return 'Stop (the table ends here)';
  if (right > length) return `Jump to row ${hexByte(right)}, which does not exist: stops`;
  return `Jump to row ${hexByte(right)}`;
}

/**
 * What row `row` (at 1-based `n`) of `table` does when an instrument reaches
 * it, in a line: the player's reading of the two bytes.
 */
export function describeSidTableRow(table: SidTableName, row: SidTableRow, length: number, chip: SidChipModel = '6581'): string {
  const { left, right } = row;
  if (table !== 'speed' && left === 0xff) return jumpText(right, length);
  switch (table) {
    case 'wave': {
      if (left === 0x00) return `Keep waveform, ${sidWaveNoteText(right)}`;
      if (left <= 0x0f) return `Wait ${left} frame${left === 1 ? '' : 's'}, then ${sidWaveNoteText(right)}`;
      if (left <= 0xdf) return `${sidControlName(left)}, ${sidWaveNoteText(right)}`;
      if (left <= 0xef) return `${sidControlName(left & 0x0f)}, ${sidWaveNoteText(right)}`;
      const cmd = left & 0x0f;
      const what = WAVE_COMMANDS[cmd];
      // $F0, $F8, $FE: illegal in GoatTracker, whose editor stops the song
      // there (gplay.c:534-538) and whose packer refuses it (greloc.c:401-409).
      if (!what) return `Command ${cmd.toString(16).toUpperCase()}: illegal in GoatTracker, which stops the song here (this player moves on)`;
      if (cmd === 0x7) return `Command 7: waveform ${hexByte(right)} (${sidControlName(right)})`;
      return `Command ${cmd.toString(16).toUpperCase()}: ${what} ${hexByte(right)}`;
    }
    case 'pulse': {
      if (left >= 0x80) {
        const width = ((left & 0x0f) << 8) | right;
        return `Set width ${width.toString(16).toUpperCase().padStart(3, '0')} (${((width / 4096) * 100).toFixed(1)} %)`;
      }
      if (left === 0) return 'Hold (00 frames: the table stays here)';
      return `Sweep ${plus(signed(right))} a frame for ${left} frame${left === 1 ? '' : 's'}`;
    }
    case 'filter': {
      if (left >= 0x80) {
        const mode = (left >> 4) & 0x07;
        const modes = [mode & 1 ? 'LP' : '', mode & 2 ? 'BP' : '', mode & 4 ? 'HP' : ''].filter(Boolean).join('+') || 'off';
        const voices = [1, 2, 3].filter((v) => right & (1 << (v - 1)));
        return `Mode ${modes}, resonance ${right >> 4}, filtered voices ${voices.length ? voices.join(',') : 'none'}`;
      }
      if (left === 0) return `Set cutoff ${hexByte(right)} (${Math.round(sidCutoffHz(chip, right << 3))} Hz)`;
      return `Cutoff sweep ${plus(signed(right))} a frame for ${left} frame${left === 1 ? '' : 's'}`;
    }
    case 'speed': {
      const vib = left >= 0x80 ? `vibrato fine: speed ${left & 0x7f}, depth = note gap >> ${right}` : `vibrato speed ${left}, depth ${right}`;
      return `${vib} · or slide speed ${hexByte(left)}${hexByte(right)}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Who reaches a row
// ---------------------------------------------------------------------------

/** Per 1-based row of `table`, the instruments (1-based) whose pointer reaches it. */
export function sidTableUsers(doc: SidDoc, table: SidTableName): Map<number, number[]> {
  const users = new Map<number, number[]>();
  doc.instruments.forEach((ins, i) => {
    const ptr = ins[SID_TABLE_POINTER[table]];
    if (ptr === 0) return;
    for (const row of sidTableRowsFrom(doc, table, ptr)) {
      const list = users.get(row) ?? [];
      list.push(i + 1);
      users.set(row, list);
    }
  });
  return users;
}

// ---------------------------------------------------------------------------
// Inserting and deleting rows
// ---------------------------------------------------------------------------

/**
 * Pattern commands whose parameter is a row of `table` (the player's command
 * set): 8/9/A start the wave/pulse/filter table; 1-4 and E read a speed row.
 */
const PATTERN_COMMANDS: Record<SidTableName, readonly number[]> = {
  wave: [0x8],
  pulse: [0x9],
  filter: [0xa],
  speed: [0x1, 0x2, 0x3, 0x4, 0xe],
};

/**
 * The table a wave-table row's command names a row of ($F1-$F4 and $FE the
 * speed table, $F8 the wave table, $F9 pulse, $FA filter), or null for any
 * other row and for a parameter of 0.
 */
function waveCommandTable(row: SidTableRow): SidTableName | null {
  if (row.left < 0xf0 || row.left === 0xff || row.right === 0) return null;
  const cmd = row.left & 0x0f;
  return cmd >= 0x1 && cmd <= 0x4 ? 'speed' : cmd === 0xe ? 'speed' : cmd === 0x8 ? 'wave' : cmd === 0x9 ? 'pulse' : cmd === 0xa ? 'filter' : null;
}

/**
 * Moves every reference to a row of `table` through `move` (a 1-based row
 * to its new number): the instruments' pointers, the table's own jumps,
 * wave-table commands ($F1-$F4, $FE speed; $F8 wave; $F9 pulse; $FA filter)
 * and pattern commands. What GoatTracker's table editor does on insert and
 * delete, so no instrument or song command lands on other data.
 */
function remapReferences(doc: SidDoc, table: SidTableName, rows: SidTableRow[], move: (row: number) => number): SidDoc {
  const key = SID_TABLE_POINTER[table];
  const instruments = doc.instruments.map((ins): SidInstrument => {
    const ptr = ins[key];
    const next = ptr === 0 ? 0 : move(ptr);
    return next === ptr ? ins : { ...ins, [key]: next };
  });
  const tables = { ...doc.tables, [table]: rows };
  // Jumps in the edited table itself.
  tables[table] = rows.map((row) => (row.left === 0xff && row.right !== 0 ? { left: 0xff, right: move(row.right) } : row));
  // Wave-table commands that name a row of this table.
  tables.wave = tables.wave.map((row) => (waveCommandTable(row) === table ? { left: row.left, right: move(row.right) } : row));
  const commands = PATTERN_COMMANDS[table];
  const patterns = doc.patterns.map((pattern): SidDocPattern => {
    let changed = false;
    const next = pattern.rows.map((row) => {
      if (row.param === 0 || !commands.includes(row.command)) return row;
      const param = move(row.param);
      if (param === row.param) return row;
      changed = true;
      return { ...row, param };
    });
    return changed ? { rows: next } : pattern;
  });
  return { ...doc, instruments, tables, patterns };
}

function finish(fields: SidDoc): SidOpResult {
  const problem = sidDocProblem(fields);
  return problem === null ? { ok: true, doc: makeSidDoc(fields) } : { ok: false, reason: `That edit would break the song: ${problem}.` };
}

/**
 * Inserts `row` before 1-based row `at` of `table` (`at` = length + 1
 * appends). Every pointer, jump and command naming row `at` or later moves
 * down with its data.
 */
export function insertSidTableRow(doc: SidDoc, table: SidTableName, at: number, row: SidTableRow = { left: 0, right: 0 }): SidOpResult {
  const rows = doc.tables[table];
  if (rows.length >= SID_MAX_TABLE_ROWS) return { ok: false, reason: `The ${table} table is full (${SID_MAX_TABLE_ROWS} rows).` };
  if (!Number.isInteger(at) || at < 1 || at > rows.length + 1) return { ok: false, reason: `The ${table} table has no row ${at}.` };
  const next = [...rows.slice(0, at - 1), { left: row.left, right: row.right }, ...rows.slice(at - 1)];
  return finish(remapReferences(doc, table, next, (r) => (r >= at ? r + 1 : r)));
}

/**
 * Deletes 1-based row `at` of `table`. References past it move up with their
 * data; one to the deleted row itself then names the row that took its
 * place (or the new last row, or none when the table is left empty).
 */
export function deleteSidTableRow(doc: SidDoc, table: SidTableName, at: number): SidOpResult {
  const rows = doc.tables[table];
  if (!Number.isInteger(at) || at < 1 || at > rows.length) return { ok: false, reason: `The ${table} table has no row ${at}.` };
  const next = [...rows.slice(0, at - 1), ...rows.slice(at)];
  return finish(remapReferences(doc, table, next, (r) => Math.min(next.length, r > at ? r - 1 : r)));
}

/** Sets 1-based row `at` of `table` to `00 00`. */
export function clearSidTableRow(doc: SidDoc, table: SidTableName, at: number): SidOpResult {
  const rows = doc.tables[table];
  if (!rows[at - 1]) return { ok: false, reason: `The ${table} table has no row ${at}.` };
  const copy = rows.slice();
  copy[at - 1] = { left: 0, right: 0 };
  return finish({ ...doc, tables: { ...doc.tables, [table]: copy } });
}

// ---------------------------------------------------------------------------
// Starter sequences
// ---------------------------------------------------------------------------

export interface SidTableTemplate {
  readonly id: string;
  readonly label: string;
  readonly title: string;
}

export const SID_TABLE_TEMPLATES: Record<SidTableName, readonly SidTableTemplate[]> = {
  wave: [
    { id: 'hold', label: 'One waveform', title: 'The instrument\'s waveform with the gate on, at the played note, then stop.' },
    { id: 'major', label: 'Major arpeggio', title: 'Root, +4, +7 on the instrument\'s waveform, looping.' },
    { id: 'minor', label: 'Minor arpeggio', title: 'Root, +3, +7 on the instrument\'s waveform, looping.' },
    { id: 'octave', label: 'Octave arpeggio', title: 'Root and +12, looping.' },
    { id: 'drum', label: 'Drum hit', title: 'A frame of noise at a high fixed note, then pulse falling in pitch, then released.' },
  ],
  pulse: [
    { id: 'set', label: 'Fixed width', title: 'Set the width the instrument starts at (50 % if it sets none), then stop.' },
    { id: 'sweep', label: 'Up/down sweep', title: 'Start at 25 %, sweep up and down for ever (the classic PWM).' },
  ],
  filter: [
    { id: 'sweep', label: 'Low-pass sweep', title: 'Low-pass, resonance 8, voice 1 filtered (the preview voice; set the routing bits for the voice the song plays it on): the cutoff opens, then stops.' },
    { id: 'set', label: 'Fixed low-pass', title: 'Low-pass at the instrument\'s cutoff and resonance (cutoff 40, resonance 0 if it sets none), every voice filtered, then stop.' },
  ],
  speed: [{ id: 'vibrato', label: 'Vibrato', title: 'A row of vibrato: speed 4, depth 20. Tune both on the Vibrato card.' }],
};

/** The rows of a starter sequence appended at 1-based row `start`, for instrument `n` of `doc`. */
function templateRows(doc: SidDoc, table: SidTableName, id: string, start: number, n: number): SidTableRow[] | null {
  const own = sidInstrumentWaveform(doc, n);
  const wave = ((own & 0xf0) || 0x40) | (own & 0x0e) | 0x01;
  const loop = (to: number): SidTableRow => ({ left: 0xff, right: to });
  const stop: SidTableRow = { left: 0xff, right: 0 };
  switch (`${table}:${id}`) {
    case 'wave:hold':
      return [{ left: wave, right: 0 }, stop];
    case 'wave:major':
      return [{ left: wave, right: 0 }, { left: wave, right: 4 }, { left: wave, right: 7 }, loop(start)];
    case 'wave:minor':
      return [{ left: wave, right: 0 }, { left: wave, right: 3 }, { left: wave, right: 7 }, loop(start)];
    case 'wave:octave':
      return [{ left: wave, right: 0 }, { left: wave, right: 12 }, loop(start)];
    case 'wave:drum':
      return [
        { left: 0x81, right: 0x80 | 60 },
        { left: 0x41, right: 0x80 | 40 },
        { left: 0x41, right: 0x80 | 36 },
        { left: 0x40, right: 0x80 | 32 },
        stop,
      ];
    case 'pulse:set': {
      const width = sidInstrumentStartWidth(doc, n)?.width ?? 0x800;
      return [{ left: 0x80 | (width >> 8), right: width & 0xff }, stop];
    }
    case 'pulse:sweep':
      return [{ left: 0x84, right: 0x00 }, { left: 0x40, right: 0x20 }, { left: 0x40, right: 0xe0 }, loop(start + 1)];
    case 'filter:sweep':
      return [{ left: 0x90, right: 0x81 }, { left: 0x00, right: 0x10 }, { left: 0x60, right: 0x02 }, stop];
    case 'filter:set': {
      const now = sidInstrumentFilterStart(doc, n);
      return [
        { left: 0x80 | ((now?.mode || 1) << 4), right: ((now?.resonance ?? 0) << 4) | 0x07 },
        { left: 0x00, right: now?.cutoff ?? 0x40 },
        stop,
      ];
    }
    case 'speed:vibrato':
      return [{ left: 0x04, right: 0x20 }];
    default:
      return null;
  }
}

/**
 * Appends a starter sequence to `table` and points instrument `n` at its
 * first row: a fresh part of the table that no other instrument reaches, so
 * the instrument can be shaped without changing the others. One undo step.
 */
export function appendSidTableTemplate(doc: SidDoc, table: SidTableName, id: string, n: number): SidOpResult {
  const ins = doc.instruments[n - 1];
  if (!ins) return { ok: false, reason: `There is no instrument ${n}.` };
  const start = doc.tables[table].length + 1;
  const rows = templateRows(doc, table, id, start, n);
  if (!rows) return { ok: false, reason: `There is no ${table} sequence "${id}".` };
  if (start - 1 + rows.length > SID_MAX_TABLE_ROWS) return { ok: false, reason: `The ${table} table has no room for ${rows.length} more rows.` };
  const instruments = doc.instruments.slice();
  instruments[n - 1] = { ...ins, [SID_TABLE_POINTER[table]]: start };
  return finish({ ...doc, instruments, tables: { ...doc.tables, [table]: [...doc.tables[table], ...rows] } });
}

// ---------------------------------------------------------------------------
// Rows nothing reaches
// ---------------------------------------------------------------------------

/** Per table, a set of 1-based rows. */
export type SidTableRowSets = Record<SidTableName, Set<number>>;

const emptyRowSets = (): SidTableRowSets => ({ wave: new Set(), pulse: new Set(), filter: new Set(), speed: new Set() });

/**
 * The rows reached from the starts `seed` names: from a start, a table plays
 * on row by row and follows its jumps (`sidTableRowsFrom`); a speed-table
 * start is that one row (a vibrato, a slide speed, a funktempo pair). A
 * reached wave row whose command names a row of a table ($F1-$F4, $F8, $F9,
 * $FA, $FE) reaches from there too.
 */
function reachFrom(doc: SidDoc, seed: (start: (table: SidTableName, row: number) => void) => void): SidTableRowSets {
  const sets = emptyRowSets();
  const start = (table: SidTableName, ptr: number): void => {
    if (ptr === 0) return;
    const rows = table === 'speed' ? (ptr <= doc.tables.speed.length ? [ptr] : []) : sidTableRowsFrom(doc, table, ptr);
    for (const r of rows) {
      if (sets[table].has(r)) continue;
      sets[table].add(r);
      if (table !== 'wave') continue;
      const row = doc.tables.wave[r - 1] as SidTableRow;
      const target = waveCommandTable(row);
      if (target !== null) start(target, row.right);
    }
  };
  seed(start);
  return sets;
}

/** The rows instrument `n` (1-based) reaches: from its four pointers, and through its wave rows' commands. */
export function sidInstrumentTableRows(doc: SidDoc, n: number): SidTableRowSets {
  const ins = doc.instruments[n - 1];
  return reachFrom(doc, (start) => {
    if (!ins) return;
    for (const table of SID_TABLE_NAMES) start(table, ins[SID_TABLE_POINTER[table]]);
  });
}

/**
 * The rows something in the song reaches: any instrument (used by a pattern
 * or not), and any pattern command that names a table row (8/9/A, 1-4, E),
 * in any pattern. Wider than what an export keeps (only what the song plays),
 * so an instrument waiting to be used keeps its rows.
 */
export function sidReachedTableRows(doc: SidDoc): SidTableRowSets {
  return reachFrom(doc, (start) => {
    for (const ins of doc.instruments) for (const table of SID_TABLE_NAMES) start(table, ins[SID_TABLE_POINTER[table]]);
    for (const pattern of doc.patterns) {
      for (const row of pattern.rows) {
        if (row.param === 0) continue;
        for (const table of SID_TABLE_NAMES) if (PATTERN_COMMANDS[table].includes(row.command)) start(table, row.param);
      }
    }
  });
}

/** Per table, the rows nothing in the song reaches (`sidReachedTableRows`). */
export function sidUnusedTableRows(doc: SidDoc): SidTableRowSets {
  const reached = sidReachedTableRows(doc);
  const unused = emptyRowSets();
  for (const table of SID_TABLE_NAMES) {
    for (let r = 1; r <= doc.tables[table].length; r++) if (!reached[table].has(r)) unused[table].add(r);
  }
  return unused;
}

/** How many rows `sets` holds, all tables together. */
export const sidRowSetsSize = (sets: SidTableRowSets): number => SID_TABLE_NAMES.reduce((n, t) => n + sets[t].size, 0);

/**
 * `doc` without rows `remove` of each table; every pointer, jump and command
 * that names a row kept is renumbered with it (`remapReferences`). A
 * reference to a removed row becomes 0 (none / a stop): meant for rows
 * nothing reaches, whose only references are from other unreached rows.
 * Fields only: the caller validates (`finish`).
 */
export function withoutSidTableRows(doc: SidDoc, remove: SidTableRowSets): SidDoc {
  let next = doc;
  for (const table of SID_TABLE_NAMES) {
    const gone = remove[table];
    if (gone.size === 0) continue;
    const rows = next.tables[table];
    const kept: SidTableRow[] = [];
    const renumber = new Map<number, number>();
    rows.forEach((row, i) => {
      if (gone.has(i + 1)) return;
      kept.push(row);
      renumber.set(i + 1, kept.length);
    });
    next = remapReferences(next, table, kept, (r) => renumber.get(r) ?? 0);
  }
  return next;
}

/**
 * Removes every row nothing in the song reaches (`sidUnusedTableRows`), the
 * rest renumbered: GoatTracker's tables as dense as an export packs them,
 * without dropping an instrument no pattern plays yet. One undo step.
 */
export function removeUnusedSidTableRows(doc: SidDoc): SidOpResult {
  const unused = sidUnusedTableRows(doc);
  if (sidRowSetsSize(unused) === 0) return { ok: true, doc };
  return finish(withoutSidTableRows(doc, unused));
}
