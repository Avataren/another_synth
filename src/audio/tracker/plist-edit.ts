/**
 * The PList edit core: what a keystroke or a menu pick does to an AHX
 * instrument's PList, as pure functions (plan `.ai/plan-plist-canvas.md` §2.3).
 * No UI, no Vue state beyond the shared edit notice.
 *
 * Every op takes the instrument and returns `{ ok: true, instrument, changed }`
 * or `{ ok: false, reason }` (the shape of the doc ops' `AhxOpResult`, with the
 * instrument where they carry a doc). A refusal changes nothing and says why; the
 * input is never touched, and an op that would change nothing returns the very
 * same instrument with `changed: false`.
 *
 * The ops compose the table's own primitives (`editAhxPListEntry`,
 * `addAhxPListEntry`, `removeAhxPListEntry`, `duplicateAhxPListEntry`,
 * `clearAhxPListEntry` in `ahx-instrument-edit.ts`), so a canvas edit and a table
 * edit produce the same instrument. What they add is *feedback*: the primitives
 * silently ignore a command the format cannot hold and silently clamp, and a
 * typed key has to say why nothing happened. So each op asks the same predicates
 * the table uses (`ahxPListCommandsFor`, `ahxFxParamMax`, `AHX_PLIST_MAX_NOTE`,
 * `AHX_FIELD_MAX.plistWaveform`, `AHX_MAX_PLIST_ENTRIES`, `ahxWaveformKind`)
 * first, and only then calls the primitive. No rule is written twice.
 *
 * The size limit is not here (an op knows an instrument, not the song):
 * `commitPListEdit` asks the store, which asks `instrumentGrowthRefusal`.
 */
import {
  AHX_FIELD_MAX,
  AHX_MAX_PLIST_ENTRIES,
  AHX_PLIST_MAX_NOTE,
  ahxPListCommandsFor,
  type AhxInstrument,
  type AhxSongFormat,
} from '@another-synth/tracker-playback';
import { clearAhxEditNotice, reportAhxEditNotice } from './ahx-edit-notice';
import { ahxWaveformKind } from './ahx-instrument-display';
import {
  addAhxPListEntry,
  ahxFxParamMax,
  clearAhxPListEntry,
  duplicateAhxPListEntry,
  editAhxPListEntry,
  removeAhxPListEntry,
  type AhxPListEdit,
} from './ahx-instrument-edit';

export type PListOpResult<Extra extends object = object> =
  | ({ readonly ok: true; readonly instrument: AhxInstrument; readonly changed: boolean } & Extra)
  | { readonly ok: false; readonly reason: string };

/** An insert or a delete: the notice about Jump commands (§4.7), when there is one to give. */
export type PListRowOpResult = PListOpResult<{ readonly notice?: string }>;

/** What an op needs to know of the song: its format decides the commands, its version the parameter range. */
export interface PListEditContext {
  readonly format: AhxSongFormat;
  /** The AHX header's version byte (0..2); irrelevant to HVL. Default 1. */
  readonly version?: number;
}

/**
 * The largest waveform field a key writes: 0 keeps the tone, 1..4 are the four
 * waves, and the numbers the format holds above that (5..7) are display-only
 * (`ahxWaveformKind` calls them unknown). Derived, so it cannot drift from it.
 */
export const PLIST_MAX_WRITABLE_WAVEFORM = Array.from({ length: AHX_FIELD_MAX.plistWaveform + 1 }, (_, w) => w)
  .filter((w) => ahxWaveformKind(w) !== 'unknown')
  .reduce((max, w) => Math.max(max, w), 0);

const AHX_JUMP_COMMAND = 5;

const hex = (n: number): string => n.toString(16).toUpperCase();
const hex2 = (n: number): string => hex(n).padStart(2, '0');
const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

const refuse = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

const sameEntries = (a: AhxInstrument, b: AhxInstrument): boolean =>
  JSON.stringify(a.plist.entries) === JSON.stringify(b.plist.entries);

/** `next` is what an op made of `ins`; an op that changed nothing hands `ins` back. */
function done(ins: AhxInstrument, next: AhxInstrument): PListOpResult {
  return sameEntries(ins, next) ? { ok: true, instrument: ins, changed: false } : { ok: true, instrument: next, changed: true };
}

function rowProblem(ins: AhxInstrument, row: number): string | null {
  const count = ins.plist.entries.length;
  if (isInt(row, 0, count - 1)) return null;
  if (count === 0) return 'This PList has no rows.';
  return `There is no PList row ${String(row)}: this PList has ${count}.`;
}

const commandName = (format: AhxSongFormat): string => (format === 'hvl' ? 'an HVL' : 'an AHX');

/** Why `command` cannot be written to a PList of `format`, or `null`. */
export function plistCommandProblem(command: number, format: AhxSongFormat): string | null {
  if (!isInt(command, 0, 15)) return `A PList command is one hex digit (got ${String(command)}).`;
  if (ahxPListCommandsFor(format).includes(command)) return null;
  return `Command ${hex(command)} is not available in ${commandName(format)} PList.`;
}

/** Why `param` cannot be the parameter of `command` in this song, or `null`. */
export function plistParamProblem(command: number, param: number, context: PListEditContext): string | null {
  const max = ahxFxParamMax(command, context.format, context.version ?? 1);
  if (!isInt(param, 0, 255)) return `A command parameter is 0 to FF (got ${String(param)}).`;
  if (param <= max) return null;
  return `Command ${hex(command)} takes a parameter of 0 to ${hex(max)} in a version-0 AHX file (got ${hex2(param)}).`;
}

/** Why `edit` cannot be written to row `row`, or `null`. */
function editProblem(ins: AhxInstrument, row: number, edit: AhxPListEdit, context: PListEditContext): string | null {
  const bad = rowProblem(ins, row);
  if (bad !== null) return bad;
  const entry = ins.plist.entries[row]!;
  switch (edit.field) {
    case 'note':
      return isInt(edit.value, 0, AHX_PLIST_MAX_NOTE) ? null : `A PList note is 0 to ${AHX_PLIST_MAX_NOTE} (got ${String(edit.value)}).`;
    case 'waveform':
      return isInt(edit.value, 0, PLIST_MAX_WRITABLE_WAVEFORM)
        ? null
        : `A PList tone is 0 to ${PLIST_MAX_WRITABLE_WAVEFORM} (got ${String(edit.value)}).`;
    case 'fixed':
      return typeof edit.value === 'boolean' ? null : 'Fixed is on or off.';
    case 'fx': {
      const problem = plistCommandProblem(edit.value, context.format);
      if (problem !== null) return problem;
      // A row cannot end up holding a parameter the file has no room for.
      return plistParamProblem(edit.value, entry.fxParam[edit.slot] ?? 0, context);
    }
    case 'fxParam':
      return plistParamProblem(entry.fx[edit.slot] ?? 0, edit.value, context);
  }
}

/**
 * Change one field of PList row `row`. Refuses a value the field cannot hold,
 * and (unlike the primitive, which clamps or ignores) says why.
 */
export function modifyPListEntry(
  ins: AhxInstrument,
  row: number,
  edit: AhxPListEdit,
  context: PListEditContext,
): PListOpResult {
  const problem = editProblem(ins, row, edit, context);
  if (problem !== null) return refuse(problem);
  return done(ins, editAhxPListEntry(ins, row, edit, context.format));
}

/** Turns Fixed on or off for the row. */
export function togglePListFixed(ins: AhxInstrument, row: number, context: PListEditContext): PListOpResult {
  const bad = rowProblem(ins, row);
  if (bad !== null) return refuse(bad);
  return modifyPListEntry(ins, row, { field: 'fixed', value: !ins.plist.entries[row]!.fixed }, context);
}

// ---------------------------------------------------------------------------
// A command typed a nibble at a time
// ---------------------------------------------------------------------------

/** 0 = the command digit, 1 = the parameter's high nibble, 2 = its low nibble. */
export type PListNibble = 0 | 1 | 2;

/**
 * Writes one hex digit of command slot `slot`: nibble 0 the command, nibble 1
 * the parameter's high half, nibble 2 its low half; the other nibbles stay.
 */
export function writePListNibble(
  ins: AhxInstrument,
  row: number,
  slot: 0 | 1,
  nibble: PListNibble,
  digit: number,
  context: PListEditContext,
): PListOpResult {
  if (!isInt(digit, 0, 15)) return refuse(`A hex digit is 0 to F (got ${String(digit)}).`);
  const bad = rowProblem(ins, row);
  if (bad !== null) return refuse(bad);
  const param = ins.plist.entries[row]!.fxParam[slot] ?? 0;
  if (nibble === 0) return modifyPListEntry(ins, row, { field: 'fx', slot, value: digit }, context);
  const value = nibble === 1 ? (digit << 4) | (param & 0x0f) : (param & 0xf0) | digit;
  return modifyPListEntry(ins, row, { field: 'fxParam', slot, value }, context);
}

/** What `+` and `-` step. */
export type PListNudgeTarget =
  | { readonly field: 'note' }
  | { readonly field: 'waveform' }
  /** `nibble` as in `writePListNibble`; a step of 1 on nibble 1 is 16 in the parameter. */
  | { readonly field: 'nibble'; readonly slot: 0 | 1; readonly nibble: PListNibble };

/**
 * Steps a field by `delta` (a note by semitones, the tone through 0..4, a
 * nibble through 0..F), clamped and never wrapping. A step that lands on a
 * value the field cannot take (a command the format lacks) is refused; a step
 * into the end of the range changes nothing and is not an error.
 */
export function nudgePListEntry(
  ins: AhxInstrument,
  row: number,
  target: PListNudgeTarget,
  delta: number,
  context: PListEditContext,
): PListOpResult {
  if (!Number.isInteger(delta)) return refuse(`A step is a whole number (got ${String(delta)}).`);
  const bad = rowProblem(ins, row);
  if (bad !== null) return refuse(bad);
  const entry = ins.plist.entries[row]!;
  const clampTo = (value: number, max: number): number => Math.min(max, Math.max(0, value));
  switch (target.field) {
    case 'note':
      return modifyPListEntry(ins, row, { field: 'note', value: clampTo(entry.note + delta, AHX_PLIST_MAX_NOTE) }, context);
    case 'waveform':
      return modifyPListEntry(
        ins,
        row,
        { field: 'waveform', value: clampTo(entry.waveform + delta, PLIST_MAX_WRITABLE_WAVEFORM) },
        context,
      );
    case 'nibble': {
      if (target.nibble === 0) {
        return modifyPListEntry(ins, row, { field: 'fx', slot: target.slot, value: clampTo((entry.fx[target.slot] ?? 0) + delta, 15) }, context);
      }
      const param = entry.fxParam[target.slot] ?? 0;
      const max = ahxFxParamMax(entry.fx[target.slot] ?? 0, context.format, context.version ?? 1);
      const step = target.nibble === 1 ? delta * 16 : delta;
      return modifyPListEntry(ins, row, { field: 'fxParam', slot: target.slot, value: clampTo(param + step, max) }, context);
    }
  }
}

/** What Delete clears: a note, a tone, or the whole of one command (its digit and its parameter). */
export type PListClearTarget = 'note' | 'tone' | { readonly command: 0 | 1 };

export function clearPListCell(
  ins: AhxInstrument,
  row: number,
  target: PListClearTarget,
  context: PListEditContext,
): PListOpResult {
  const bad = rowProblem(ins, row);
  if (bad !== null) return refuse(bad);
  if (target === 'note') return modifyPListEntry(ins, row, { field: 'note', value: 0 }, context);
  if (target === 'tone') return modifyPListEntry(ins, row, { field: 'waveform', value: 0 }, context);
  // Command 0 and parameter 0 are always writable: no validation to run.
  const slot = target.command;
  const noCommand = editAhxPListEntry(ins, row, { field: 'fx', slot, value: 0 }, context.format);
  return done(ins, editAhxPListEntry(noCommand, row, { field: 'fxParam', slot, value: 0 }, context.format));
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** How many command slots hold a Jump (5xx). */
export function countPListJumps(ins: Pick<AhxInstrument, 'plist'>): number {
  let count = 0;
  for (const entry of ins.plist.entries) for (const fx of entry.fx) if (fx === AHX_JUMP_COMMAND) count++;
  return count;
}

/**
 * Inserting or deleting a row moves every later row and leaves the Jump
 * parameters alone (absolute row numbers, §4.7): say so, once, when an AHX
 * instrument has Jumps and rows did move. `at` is the row that was inserted or
 * removed. HVL is not told: its command 5 is not assumed to be a Jump (D94).
 */
export function plistJumpNotice(after: AhxInstrument, at: number, context: PListEditContext, inserted: boolean): string | undefined {
  if (context.format !== 'ahx') return undefined;
  const moved = after.plist.entries.length - (inserted ? at + 1 : at);
  const jumps = countPListJumps(after);
  if (moved <= 0 || jumps === 0) return undefined;
  const which = jumps === 1 ? '1 Jump command (5xx) still points at its old row number' : `${jumps} Jump commands (5xx) still point at their old row numbers`;
  return `Rows after ${hex2(at)} moved; ${which}.`;
}

const FULL = `A PList has at most ${AHX_MAX_PLIST_ENTRIES} rows.`;

function rowOp(next: AhxInstrument, at: number, inserted: boolean, context: PListEditContext): PListRowOpResult {
  const notice = plistJumpNotice(next, at, context, inserted);
  return { ok: true, instrument: next, changed: true, ...(notice === undefined ? {} : { notice }) };
}

/** An empty row before row `row` (`row` = the row count appends). */
export function insertPListRowBefore(ins: AhxInstrument, row: number, context: PListEditContext): PListRowOpResult {
  if (!isInt(row, 0, ins.plist.entries.length)) return refuse(`There is no place for a row at ${String(row)}: this PList has ${ins.plist.entries.length}.`);
  if (ins.plist.entries.length >= AHX_MAX_PLIST_ENTRIES) return refuse(FULL);
  return rowOp(addAhxPListEntry(ins, row - 1), row, true, context);
}

/** An empty row after row `row` (`-1` puts it first). */
export function insertPListRowAfter(ins: AhxInstrument, row: number, context: PListEditContext): PListRowOpResult {
  if (!isInt(row, -1, ins.plist.entries.length - 1)) return refuse(`There is no PList row ${String(row)} to insert after: this PList has ${ins.plist.entries.length}.`);
  if (ins.plist.entries.length >= AHX_MAX_PLIST_ENTRIES) return refuse(FULL);
  return rowOp(addAhxPListEntry(ins, row), row + 1, true, context);
}

/** A copy of row `row` right after it. */
export function duplicatePListRow(ins: AhxInstrument, row: number, context: PListEditContext): PListRowOpResult {
  const bad = rowProblem(ins, row);
  if (bad !== null) return refuse(bad);
  if (ins.plist.entries.length >= AHX_MAX_PLIST_ENTRIES) return refuse(FULL);
  return rowOp(duplicateAhxPListEntry(ins, row), row + 1, true, context);
}

/** Row `row` removed; removing the last row leaves an empty PList, which is legal. */
export function deletePListRow(ins: AhxInstrument, row: number, context: PListEditContext): PListRowOpResult {
  const bad = rowProblem(ins, row);
  if (bad !== null) return refuse(bad);
  return rowOp(removeAhxPListEntry(ins, row), row, false, context);
}

/** Row `row` emptied in place: no row moves, so there is no Jump notice. */
export function clearPListRow(ins: AhxInstrument, row: number): PListOpResult {
  const bad = rowProblem(ins, row);
  if (bad !== null) return refuse(bad);
  return done(ins, clearAhxPListEntry(ins, row));
}

// ---------------------------------------------------------------------------
// Committing: the guards, the undo step, the write and what it says
// ---------------------------------------------------------------------------

/** What `commitPListEdit` needs of the tracker store (which satisfies it as it is). */
export interface PListEditHost {
  /** The song has undo (an editable AHX song). */
  readonly canUndo: () => boolean;
  readonly pushHistory: () => void;
  /** Why the store would refuse `next` for the slot (`null` when it would take it). */
  readonly ahxInstrumentRefusal: (slot: number, next: AhxInstrument) => string | null;
  readonly updateAhxInstrument: (slot: number, next: AhxInstrument) => 'applied' | 'kept' | 'rejected';
}

/**
 * One edit gesture: the run of writes that is one undo step (a keystroke, a
 * menu pick; a run of nibble strokes into one cell). The host closes it when
 * the cursor moves; `commitPListEdit` closes it after any write that does not
 * `continues`.
 */
export interface PListGesture {
  /** An undo step has been recorded for this gesture. */
  readonly recorded: boolean;
  close(): void;
}

export function createPListGesture(): PListGesture & { markRecorded(): void } {
  let recorded = false;
  return {
    get recorded() {
      return recorded;
    },
    markRecorded() {
      recorded = true;
    },
    close() {
      recorded = false;
    },
  };
}

export type PListCommitResult =
  | { readonly ok: true; readonly outcome: 'applied' | 'kept'; readonly changed: boolean }
  | { readonly ok: false; readonly reason: string };

/**
 * Writes an op's result to the song, once per gesture on the undo stack.
 * Order, as Song Edit §1.3 has it: refuse first (the op's own refusal, then the
 * store's: an invalid instrument or the size limit), then `pushHistory()` (once
 * per gesture, only where the song has undo), then the write, then the notice.
 * A refusal says why on the shared edit notice and leaves the song and the
 * undo stack alone; an op that changed nothing does not touch either.
 */
export function commitPListEdit(
  host: PListEditHost,
  gesture: PListGesture & { markRecorded(): void },
  slot: number,
  result: PListOpResult<{ readonly notice?: string }>,
  options: { readonly continues?: boolean } = {},
): PListCommitResult {
  const finish = (): void => {
    if (options.continues !== true) gesture.close();
  };
  if (!result.ok) {
    reportAhxEditNotice(result.reason);
    return result;
  }
  if (!result.changed) {
    finish();
    return { ok: true, outcome: 'applied', changed: false };
  }
  const refusal = host.ahxInstrumentRefusal(slot, result.instrument);
  if (refusal !== null) {
    reportAhxEditNotice(refusal);
    return { ok: false, reason: refusal };
  }
  if (host.canUndo() && !gesture.recorded) {
    host.pushHistory();
    gesture.markRecorded();
  }
  const outcome = host.updateAhxInstrument(slot, result.instrument);
  if (outcome === 'rejected') {
    // The store said yes a moment ago: nothing here can get this far.
    const reason = 'That change is not a valid instrument for this song and was not applied.';
    reportAhxEditNotice(reason);
    return { ok: false, reason };
  }
  if (result.notice !== undefined) reportAhxEditNotice(result.notice);
  else clearAhxEditNotice();
  finish();
  return { ok: true, outcome, changed: true };
}
