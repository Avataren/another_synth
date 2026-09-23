import {
  DEFAULT_SID_INSTRUMENT,
  addSidInstrument,
  setSidInstrument,
  setSidTableRow,
  type SidDoc,
  type SidInstrument,
  type SidInstrumentFilter,
  type SidOpResult,
  type SidTableName,
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
  pulseWidth: 0xfff,
  firstWave: 0xff,
  gateTimer: 63,
  vibratoDelay: 0xff,
} as const;
export type SidInstrumentNumberField = keyof typeof SID_INSTRUMENT_NUMBER_FIELDS;

export type SidInstrumentPatch = Partial<Omit<SidInstrument, 'filter'>> & { filter?: Partial<SidInstrumentFilter> };

/** Instrument `n` (1-based) with `patch` applied. */
export function editSidInstrument(doc: SidDoc, n: number, patch: SidInstrumentPatch): SidOpResult {
  const ins = doc.instruments[n - 1];
  if (!ins) return { ok: false, reason: `There is no instrument ${n}.` };
  return setSidInstrument(doc, n, { ...ins, ...patch, filter: { ...ins.filter, ...(patch.filter ?? {}) } });
}

/** Flips one bit of the instrument's control byte (a waveform, ring, sync or test). Never the gate. */
export function toggleSidControlBit(doc: SidDoc, n: number, bit: number): SidOpResult {
  const ins = doc.instruments[n - 1];
  if (!ins) return { ok: false, reason: `There is no instrument ${n}.` };
  if (bit === 0x01) return { ok: false, reason: 'The gate bit is the player\'s: an instrument never sets it.' };
  return editSidInstrument(doc, n, { waveform: ins.waveform ^ bit });
}

/** Flips one filter mode bit (LP 1, BP 2, HP 4). */
export function toggleSidFilterMode(doc: SidDoc, n: number, bit: number): SidOpResult {
  const ins = doc.instruments[n - 1];
  if (!ins) return { ok: false, reason: `There is no instrument ${n}.` };
  return editSidInstrument(doc, n, { filter: { mode: ins.filter.mode ^ bit } });
}

/** A new instrument at the end of the list (the default pulse, named): number `instruments.length`. */
export function newSidInstrument(doc: SidDoc, name = ''): SidOpResult {
  return addSidInstrument(doc, { ...DEFAULT_SID_INSTRUMENT, name });
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
