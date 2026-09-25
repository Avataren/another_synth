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

/**
 * What the page's waveform boxes edit: the byte that set the waveform a frame
 * plays (`SidFrameTrace.waveSource`), so a box ticked is heard at that frame.
 */
export type SidWaveTarget =
  | { readonly kind: 'instrument' }
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
    case 'instrument':
      return ins.waveform;
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
  if (target.kind === 'instrument') return toggleSidControlBit(doc, n, bit);
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
