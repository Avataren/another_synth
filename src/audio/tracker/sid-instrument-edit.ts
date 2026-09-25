import {
  DEFAULT_SID_INSTRUMENT,
  NEW_SID_INSTRUMENT_PULSE_ROWS,
  NEW_SID_INSTRUMENT_WAVE_ROWS,
  SID_MAX_TABLE_ROWS,
  makeSidDoc,
  newSidGateTimer,
  setSidInstrument,
  setSidTableRow,
  sidDocProblem,
  type SidDoc,
  type SidInstrument,
  type SidOpResult,
  type SidTableName,
  type SidTableRow,
} from 'src/audio/tracker/sid-doc';

/**
 * The SID instrument page's edits (plan-sid-tracking.md S4), as doc ops: each
 * returns a `SidOpResult` the page hands to the store's `editSidDoc` (one
 * undo step, committed to the doc, which the slots, the grid, the save and
 * the players all follow). Nothing here holds state.
 */

/** Ranges of the instrument's number fields (what `sidInstrumentProblem` accepts). */
export const SID_INSTRUMENT_NUMBER_FIELDS = {
  attack: 15,
  decay: 15,
  sustain: 15,
  release: 15,
  firstWave: 0xff,
  gateTimer: 63,
  vibratoDelay: 0xff,
} as const;
export type SidInstrumentNumberField = keyof typeof SID_INSTRUMENT_NUMBER_FIELDS;

export type SidInstrumentPatch = Partial<SidInstrument>;

/** Instrument `n` (1-based) with `patch` applied. */
export function editSidInstrument(doc: SidDoc, n: number, patch: SidInstrumentPatch): SidOpResult {
  const ins = doc.instruments[n - 1];
  if (!ins) return { ok: false, reason: `There is no instrument ${n}.` };
  return setSidInstrument(doc, n, { ...ins, ...patch });
}

/**
 * What the page's waveform boxes edit: the byte that set the waveform a frame
 * plays (`SidFrameTrace.waveSource`), so a box ticked is heard at that frame.
 */
export type SidWaveTarget =
  | { readonly kind: 'first-frame' }
  | { readonly kind: 'wave-row'; readonly row: number }
  | { readonly kind: 'wave-command'; readonly row: number };

/**
 * The control byte `target` holds for instrument `n`, gate bit included (the
 * instrument's own has none: the player adds it). A wave-table `E0-EF` row is
 * its low nibble, what the player plays.
 */
export function sidWaveTargetByte(doc: SidDoc, n: number, target: SidWaveTarget): number {
  const ins = doc.instruments[n - 1];
  if (!ins) return 0;
  switch (target.kind) {
    case 'first-frame':
      return ins.firstWave;
    case 'wave-row': {
      const left = doc.tables.wave[target.row - 1]?.left ?? 0;
      return left >= 0xe0 && left <= 0xef ? left & 0x0f : left;
    }
    case 'wave-command':
      return doc.tables.wave[target.row - 1]?.right ?? 0;
  }
}

/**
 * Flips control bit `bit` of the byte `target` names. A wave-table row stays
 * a waveform row: a byte with no waveform bits is written as `E0-EF` (the
 * table's own spelling of it), and one past `DF` (noise with pulse and saw)
 * cannot be, since `E0-FF` are the table's other rows. A first-frame byte
 * stays one (not 00, FE or FF, which mean something else).
 */
export function toggleSidWaveTargetBit(doc: SidDoc, n: number, target: SidWaveTarget, bit: number): SidOpResult {
  const ins = doc.instruments[n - 1];
  if (!ins) return { ok: false, reason: `There is no instrument ${n}.` };
  const next = sidWaveTargetByte(doc, n, target) ^ bit;
  switch (target.kind) {
    case 'first-frame':
      if (next === 0 || next >= 0xfe) return { ok: false, reason: `A first-frame byte of ${hexByte(next)} means something else (00 none, FE/FF gate only): pick another bit first.` };
      return editSidInstrument(doc, n, { firstWave: next });
    case 'wave-row': {
      if (next > 0xdf) return { ok: false, reason: `Wave table row ${hexByte(target.row)} cannot hold ${hexByte(next)}: E0-FF are the table's commands. Use a command 7 row (F7 ${hexByte(next)}) for it.` };
      const left = (next & 0xf0) === 0 ? 0xe0 | next : next;
      return editSidTableByte(doc, 'wave', target.row - 1, 'left', left);
    }
    case 'wave-command':
      return editSidTableByte(doc, 'wave', target.row - 1, 'right', next);
  }
}

/**
 * A new instrument at the end of the list: number `instruments.length`.
 * GoatTracker's defaults (`DEFAULT_SID_INSTRUMENT`, its gate timer at the
 * song's multispeed) with rows of its own appended to the wave and pulse
 * tables (`NEW_SID_INSTRUMENT_WAVE_ROWS`, `..._PULSE_ROWS`), so it sounds and
 * can be shaped without touching another instrument.
 */
export function newSidInstrument(doc: SidDoc, name = ''): SidOpResult {
  const wave = doc.tables.wave.length + 1;
  const pulse = doc.tables.pulse.length + 1;
  if (wave + 1 > SID_MAX_TABLE_ROWS || pulse + 1 > SID_MAX_TABLE_ROWS) {
    return { ok: false, reason: `The wave or pulse table has no room for a new instrument's 2 rows (${SID_MAX_TABLE_ROWS} at most).` };
  }
  const tables = {
    ...doc.tables,
    wave: [...doc.tables.wave, ...NEW_SID_INSTRUMENT_WAVE_ROWS],
    pulse: [...doc.tables.pulse, ...NEW_SID_INSTRUMENT_PULSE_ROWS],
  };
  const ins: SidInstrument = { ...DEFAULT_SID_INSTRUMENT, name, gateTimer: newSidGateTimer(doc.speedMultiplier), wavePtr: wave, pulsePtr: pulse };
  return finish({ ...doc, instruments: [...doc.instruments, ins], tables });
}

const STOP: SidTableRow = { left: 0xff, right: 0x00 };

function finish(fields: SidDoc): SidOpResult {
  const problem = sidDocProblem(fields);
  return problem === null ? { ok: true, doc: makeSidDoc(fields) } : { ok: false, reason: `That edit would break the song: ${problem}.` };
}

/** Appends `rows` to `table` and points instrument `n` at the first. */
function appendAndPoint(doc: SidDoc, n: number, table: 'pulse' | 'filter', rows: readonly SidTableRow[]): SidOpResult {
  const ins = doc.instruments[n - 1];
  if (!ins) return { ok: false, reason: `There is no instrument ${n}.` };
  const start = doc.tables[table].length + 1;
  if (start - 1 + rows.length > SID_MAX_TABLE_ROWS) return { ok: false, reason: `The ${table} table has no room for ${rows.length} more rows.` };
  const instruments = doc.instruments.slice();
  instruments[n - 1] = { ...ins, [table === 'pulse' ? 'pulsePtr' : 'filterPtr']: start };
  return finish({ ...doc, instruments, tables: { ...doc.tables, [table]: [...doc.tables[table], ...rows] } });
}

// ---------------------------------------------------------------------------
// The start of the pulse and filter tables: what the page's simple controls
// edit. A GoatTracker instrument has no width or filter of its own; its first
// table rows set them.
// ---------------------------------------------------------------------------

/** A pulse-table row that sets the width (`80-FE`: high nibble in the left byte's low digit). */
const isWidthRow = (row: SidTableRow | undefined): row is SidTableRow => !!row && row.left >= 0x80 && row.left !== 0xff;

/**
 * The width instrument `n`'s pulse table starts at: its first row, when that
 * row sets one. `null` when it has no pulse table (the channel keeps its
 * width) or starts with a sweep or a jump.
 */
export function sidInstrumentStartWidth(doc: SidDoc, n: number): { readonly row: number; readonly width: number } | null {
  const ptr = doc.instruments[n - 1]?.pulsePtr ?? 0;
  const row = ptr ? doc.tables.pulse[ptr - 1] : undefined;
  return isWidthRow(row) ? { row: ptr, width: ((row.left & 0x0f) << 8) | row.right } : null;
}

/**
 * Sets the width instrument `n`'s pulse table starts at (0..4095): its first
 * row when that sets a width; with no pulse table, a new `set, stop` pair it
 * points at. A table starting with a sweep or jump is refused (edit the
 * table itself: a row inserted there would move the other instruments' rows).
 */
export function setSidInstrumentStartWidth(doc: SidDoc, n: number, width: number): SidOpResult {
  const ins = doc.instruments[n - 1];
  if (!ins) return { ok: false, reason: `There is no instrument ${n}.` };
  if (!Number.isInteger(width) || width < 0 || width > 0xfff) return { ok: false, reason: `${width} is not a pulse width (0-FFF).` };
  const row: SidTableRow = { left: 0x80 | (width >> 8), right: width & 0xff };
  if (ins.pulsePtr === 0) return appendAndPoint(doc, n, 'pulse', [row, STOP]);
  if (!isWidthRow(doc.tables.pulse[ins.pulsePtr - 1])) {
    return { ok: false, reason: `Pulse table row ${hexByte(ins.pulsePtr)} is a sweep or a jump, not a width: set the width in the table.` };
  }
  return setSidTableRow(doc, 'pulse', ins.pulsePtr - 1, row);
}

/** What instrument `n`'s filter table starts with: a mode row (`80-F0`), and the cutoff row after it if there is one. */
export interface SidInstrumentFilterStart {
  /** 1-based row of the mode row. */
  readonly row: number;
  /** LP 1 | BP 2 | HP 4 (0: the filter's output is off). */
  readonly mode: number;
  readonly resonance: number;
  /** Which voices go through the filter: bit 0 voice 1, bit 1 voice 2, bit 2 voice 3. */
  readonly voices: number;
  /** The cutoff row's value (the register's high 8 bits), or null when the next row sets none. */
  readonly cutoff: number | null;
}

export type SidInstrumentFilterPatch = Partial<Pick<SidInstrumentFilterStart, 'mode' | 'resonance' | 'voices'>> & { readonly cutoff?: number };

/** A filter-table row that sets the mode, resonance and routing. */
const isModeRow = (row: SidTableRow | undefined): row is SidTableRow => !!row && row.left >= 0x80 && row.left <= 0xf0 && (row.left & 0x0f) === 0;

/** What instrument `n`'s filter table starts with, or null (no filter table, or it starts with a cutoff, sweep or jump). */
export function sidInstrumentFilterStart(doc: SidDoc, n: number): SidInstrumentFilterStart | null {
  const ptr = doc.instruments[n - 1]?.filterPtr ?? 0;
  const table = doc.tables.filter;
  const row = ptr ? table[ptr - 1] : undefined;
  if (!isModeRow(row)) return null;
  const next = table[ptr];
  return {
    row: ptr,
    mode: (row.left >> 4) & 0x07,
    resonance: row.right >> 4,
    voices: row.right & 0x07,
    cutoff: next && next.left === 0x00 ? next.right : null,
  };
}

/**
 * Edits the start of instrument `n`'s filter table. With no filter table it
 * appends mode, cutoff and stop rows (low-pass, resonance 0, cutoff $40,
 * every voice filtered, unless `patch` says otherwise) and points at them.
 * A table that does not start with a mode row, or a cutoff edit where no
 * cutoff row follows it, is refused: edit the table itself.
 */
export function setSidInstrumentFilterStart(doc: SidDoc, n: number, patch: SidInstrumentFilterPatch): SidOpResult {
  const ins = doc.instruments[n - 1];
  if (!ins) return { ok: false, reason: `There is no instrument ${n}.` };
  const start = sidInstrumentFilterStart(doc, n);
  if (ins.filterPtr !== 0 && start === null) {
    return { ok: false, reason: `Filter table row ${hexByte(ins.filterPtr)} does not set a mode: edit the filter in the table.` };
  }
  const mode = patch.mode ?? start?.mode ?? 1;
  const resonance = patch.resonance ?? start?.resonance ?? 0;
  const voices = patch.voices ?? start?.voices ?? 0x07;
  const cutoff = patch.cutoff ?? start?.cutoff ?? 0x40;
  if (!Number.isInteger(mode) || mode < 0 || mode > 7) return { ok: false, reason: `${mode} is not a filter mode (0-7).` };
  if (!Number.isInteger(resonance) || resonance < 0 || resonance > 15) return { ok: false, reason: `${resonance} is not a resonance (0-F).` };
  if (!Number.isInteger(voices) || voices < 0 || voices > 7) return { ok: false, reason: `${voices} is not a set of voices (0-7).` };
  if (!Number.isInteger(cutoff) || cutoff < 0 || cutoff > 0xff) return { ok: false, reason: `${cutoff} is not a cutoff (00-FF).` };
  const modeRow: SidTableRow = { left: 0x80 | (mode << 4), right: (resonance << 4) | voices };
  const cutoffRow: SidTableRow = { left: 0x00, right: cutoff };
  if (start === null) return appendAndPoint(doc, n, 'filter', [modeRow, cutoffRow, STOP]);
  if (patch.cutoff !== undefined && start.cutoff === null) {
    return { ok: false, reason: `Filter table row ${hexByte(start.row + 1)} is not a cutoff row: set the cutoff in the table.` };
  }
  const rows = doc.tables.filter.slice();
  rows[start.row - 1] = modeRow;
  if (start.cutoff !== null) rows[start.row] = cutoffRow;
  return finish({ ...doc, tables: { ...doc.tables, filter: rows } });
}

/**
 * The waveform bits (no gate) instrument `n` starts with: its wave table's
 * first waveform row, else its first-frame byte when that is a waveform,
 * else 0. What the table templates build on.
 */
export function sidInstrumentWaveform(doc: SidDoc, n: number): number {
  const ins = doc.instruments[n - 1];
  if (!ins) return 0;
  const first = ins.wavePtr ? doc.tables.wave[ins.wavePtr - 1] : undefined;
  if (first && first.left >= 0x10 && first.left <= 0xdf) return first.left & 0xfe;
  return ins.firstWave < 0xfe && (ins.firstWave & 0xf0) !== 0 ? ins.firstWave & 0xfe : 0;
}

/** Writes one byte of a table row (`side` left or right); `index` = the table's length appends a row. */
export function editSidTableByte(doc: SidDoc, table: SidTableName, index: number, side: 'left' | 'right', value: number): SidOpResult {
  const rows = doc.tables[table];
  const current = rows[index] ?? { left: 0, right: 0 };
  if (!Number.isInteger(value) || value < 0 || value > 0xff) return { ok: false, reason: `${value} is not a byte (00-FF).` };
  return setSidTableRow(doc, table, index, { ...current, [side]: value });
}

/**
 * The rows (1-based) a table plays from `ptr`: forward until the table ends,
 * a stop (`FF 00`) or a jump, which is followed once (a loop back ends the
 * walk). What the page highlights as "this instrument's" rows.
 */
export function sidTableRowsFrom(doc: SidDoc, table: SidTableName, ptr: number): number[] {
  const rows = doc.tables[table];
  const seen = new Set<number>();
  let at = ptr;
  while (at >= 1 && at <= rows.length && !seen.has(at)) {
    seen.add(at);
    const row = rows[at - 1] as { left: number; right: number };
    if (row.left === 0xff) {
      at = row.right;
      continue;
    }
    at += 1;
  }
  return [...seen].sort((a, b) => a - b);
}

/** Two hex digits. */
export const hexByte = (value: number): string => value.toString(16).toUpperCase().padStart(2, '0');
