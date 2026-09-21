/**
 * What a key or a menu pick means to the PList canvas, as pure functions (plan
 * `.ai/plan-plist-canvas.md` §4.2, §4.5): the cursor's stops, the key table, and
 * the *intent* a key or a menu item asks for. No Vue, no store, no DOM: the host
 * component reads the keyboard, this decides, `runPListIntent` turns an intent
 * into one of the `plist-edit.ts` ops, and the page commits it.
 *
 * An intent is plain data (which row, which field, which digit), so the canvas
 * key, the context menu and the table's own row buttons all end in the same op.
 */
import { ahxNoteIndexFromMidi, type AhxInstrument } from '@another-synth/tracker-playback';
import { TRACKER_NOTE_KEY_MAP } from 'src/composables/keyboard/note-key-map';
import { AHX_DEFAULT_OCTAVE } from 'src/composables/useAhxPlayInput';
import {
  clearPListCell,
  clearPListRow,
  deletePListRow,
  duplicatePListRow,
  insertPListRowAfter,
  insertPListRowBefore,
  modifyPListEntry,
  nudgePListEntry,
  togglePListFixed,
  writePListNibble,
  type PListClearTarget,
  type PListEditContext,
  type PListNibble,
  type PListNudgeTarget,
  type PListOpResult,
  PLIST_MAX_WRITABLE_WAVEFORM,
} from './plist-edit';

/** The canvas columns a cursor can stand on: Note, Tone, Command 1, Command 2 (2 and 3 are the volume the PList lacks). */
export type PListColumn = 0 | 1 | 4 | 5;

export interface PListStop {
  readonly column: PListColumn;
  /** Which digit of a command; always 0 in the Note and Tone cells. */
  readonly nibble: PListNibble;
}

export interface PListCursor extends PListStop {
  readonly row: number;
}

/** Left to right, the places a cursor can stand. */
export const PLIST_STOPS: readonly PListStop[] = [
  { column: 0, nibble: 0 },
  { column: 1, nibble: 0 },
  { column: 4, nibble: 0 },
  { column: 4, nibble: 1 },
  { column: 4, nibble: 2 },
  { column: 5, nibble: 0 },
  { column: 5, nibble: 1 },
  { column: 5, nibble: 2 },
];

/** Rows a Page Up / Page Down moves: what the card shows before it scrolls. */
export const PLIST_PAGE_ROWS = 8;

/**
 * The stop a click on canvas column `column` (and command digit `nibble`) means.
 * The two volume columns hold nothing in a PList, so a click there goes to the
 * nearer stop: the second-to-last one to Tone, the last one to Command 1.
 */
export function snapToStop(column: number, nibble?: number): PListStop {
  const clampedNibble = (Math.min(2, Math.max(0, nibble ?? 0)) | 0) as PListNibble;
  if (column <= 0) return PLIST_STOPS[0]!;
  if (column === 1 || column === 2) return PLIST_STOPS[1]!;
  if (column === 3) return PLIST_STOPS[2]!;
  return { column: column >= 5 ? 5 : 4, nibble: clampedNibble };
}

const stopIndex = (stop: PListStop): number => PLIST_STOPS.findIndex((s) => s.column === stop.column && s.nibble === stop.nibble);

/** `delta` stops left (negative) or right, stopping at the ends. */
export function stepStop(stop: PListStop, delta: number): PListStop {
  const index = Math.min(PLIST_STOPS.length - 1, Math.max(0, stopIndex(stop) + delta));
  return PLIST_STOPS[index]!;
}

// ---------------------------------------------------------------------------
// Intents
// ---------------------------------------------------------------------------

/** What one key or menu item asks of row `row`. */
export type PListIntent =
  | { readonly kind: 'nibble'; readonly row: number; readonly slot: 0 | 1; readonly nibble: PListNibble; readonly digit: number }
  | { readonly kind: 'tone'; readonly row: number; readonly value: number }
  | { readonly kind: 'note'; readonly row: number; readonly value: number }
  | { readonly kind: 'nudge'; readonly row: number; readonly target: PListNudgeTarget; readonly delta: number }
  | { readonly kind: 'clear-cell'; readonly row: number; readonly target: PListClearTarget }
  | { readonly kind: 'fixed'; readonly row: number }
  | { readonly kind: 'insert-above'; readonly row: number }
  /** `row` -1 puts the new row first; the row count appends. */
  | { readonly kind: 'insert-below'; readonly row: number }
  | { readonly kind: 'duplicate'; readonly row: number }
  | { readonly kind: 'delete'; readonly row: number }
  | { readonly kind: 'clear'; readonly row: number };

export type PListMenuAction = 'insert-above' | 'insert-below' | 'duplicate' | 'delete' | 'clear' | 'fixed';

/** The menu's items, in the order it lists them. */
export const PLIST_MENU_ACTIONS: readonly PListMenuAction[] = ['insert-above', 'insert-below', 'duplicate', 'delete', 'clear', 'fixed'];

/** The one op an intent is. */
export function runPListIntent(
  ins: AhxInstrument,
  intent: PListIntent,
  context: PListEditContext,
): PListOpResult<{ readonly notice?: string }> {
  switch (intent.kind) {
    case 'nibble':
      return writePListNibble(ins, intent.row, intent.slot, intent.nibble, intent.digit, context);
    case 'tone':
      return modifyPListEntry(ins, intent.row, { field: 'waveform', value: intent.value }, context);
    case 'note':
      return modifyPListEntry(ins, intent.row, { field: 'note', value: intent.value }, context);
    case 'nudge':
      return nudgePListEntry(ins, intent.row, intent.target, intent.delta, context);
    case 'clear-cell':
      return clearPListCell(ins, intent.row, intent.target, context);
    case 'fixed':
      return togglePListFixed(ins, intent.row, context);
    case 'insert-above':
      return insertPListRowBefore(ins, intent.row, context);
    case 'insert-below':
      return insertPListRowAfter(ins, intent.row, context);
    case 'duplicate':
      return duplicatePListRow(ins, intent.row, context);
    case 'delete':
      return deletePListRow(ins, intent.row, context);
    case 'clear':
      return clearPListRow(ins, intent.row);
  }
}

// ---------------------------------------------------------------------------
// The key table (§4.2)
// ---------------------------------------------------------------------------

/** The parts of a `KeyboardEvent` the table reads. */
export interface PListKeyLike {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}

/** What the key table needs to know besides the key and the cursor. */
export interface PListKeyEnv {
  readonly rowCount: number;
  /** The cursor row's Fixed flag: a piano key enters a pitch only on a fixed row. */
  readonly rowFixed: boolean;
  /** The tracker's edit step: rows the cursor moves down after a finished entry. */
  readonly stepSize: number;
  /** The page's octave (the on-screen piano's), for a piano key entered as a pitch. */
  readonly octave: number;
}

export type PListKeyAction =
  /** Not ours: leave the key to the page (Escape, F2, Tab, the browser's shortcuts). */
  | { readonly type: 'pass' }
  /** The cursor moves; nothing is written. */
  | { readonly type: 'move'; readonly cursor: PListCursor }
  /** Write, then (if it worked) put the cursor at `cursorAfter`; `continues` keeps the undo step open for the next stroke. */
  | { readonly type: 'edit'; readonly intent: PListIntent; readonly cursorAfter: PListCursor; readonly continues: boolean }
  /** Ours, and it cannot be done: say why, change nothing. */
  | { readonly type: 'refuse'; readonly reason: string }
  | { readonly type: 'undo' }
  | { readonly type: 'redo' };

const PASS: PListKeyAction = { type: 'pass' };

const isNumpadStep = (event: PListKeyLike): boolean => event.code === 'NumpadAdd' || event.code === 'NumpadSubtract';

/**
 * `+` / `-` and their size. On most keyboards `+` is Shift and `=`, so Shift
 * cannot mean "bigger" there: the big step is Shift with the *numpad* `+` / `-`.
 */
function stepOf(event: PListKeyLike): { delta: 1 | -1; big: boolean } | null {
  if (event.key !== '+' && event.key !== '-') return null;
  return { delta: event.key === '+' ? 1 : -1, big: event.shiftKey && isNumpadStep(event) };
}

const TONE_KEYS: Readonly<Record<string, number>> = { t: 1, s: 2, q: 3, n: 4 };

const hexDigitOf = (key: string): number | null => (/^[0-9a-fA-F]$/.test(key) ? parseInt(key, 16) : null);
const isPrintableAlnum = (key: string): boolean => /^[0-9a-zA-Z]$/.test(key);

/**
 * The key table: what `event` does with the cursor on `cursor`. `pass` means
 * the key is not the canvas's; every other action is a key the canvas took, so
 * the host stops it and keeps it from reaching anything else.
 */
export function plistKeyAction(event: PListKeyLike, cursor: PListCursor, env: PListKeyEnv): PListKeyAction {
  const { row, column, nibble } = cursor;
  const last = env.rowCount - 1;
  if (env.rowCount <= 0) return PASS;
  const at = (over: Partial<PListCursor>): PListCursor => ({ ...cursor, ...over });
  const key = event.key;

  // Undo and redo, and the one Ctrl combination that deletes a row.
  if ((event.ctrlKey || event.metaKey) && !event.altKey && (key === 'z' || key === 'Z')) {
    return { type: event.shiftKey ? 'redo' : 'undo' };
  }
  if (event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && (key === 'Delete' || key === 'Backspace')) {
    return { type: 'edit', intent: { kind: 'delete', row }, cursorAfter: at({ row: Math.max(0, Math.min(row, last - 1)) }), continues: false };
  }
  if (event.ctrlKey || event.altKey || event.metaKey) return PASS;

  // Moving: rows, and the stops of a row.
  if (!event.shiftKey) {
    switch (key) {
      case 'ArrowDown':
        return { type: 'move', cursor: at({ row: Math.min(last, row + 1) }) };
      case 'ArrowUp':
        return { type: 'move', cursor: at({ row: Math.max(0, row - 1) }) };
      case 'PageDown':
        return { type: 'move', cursor: at({ row: Math.min(last, row + PLIST_PAGE_ROWS) }) };
      case 'PageUp':
        return { type: 'move', cursor: at({ row: Math.max(0, row - PLIST_PAGE_ROWS) }) };
      case 'Home':
        return { type: 'move', cursor: at({ row: 0 }) };
      case 'End':
        return { type: 'move', cursor: at({ row: last }) };
      case 'ArrowLeft':
        return { type: 'move', cursor: { row, ...stepStop({ column, nibble }, -1) } };
      case 'ArrowRight':
        return { type: 'move', cursor: { row, ...stepStop({ column, nibble }, 1) } };
    }
  }

  // Rows.
  if (key === 'Insert' && !event.shiftKey) return { type: 'edit', intent: { kind: 'insert-above', row }, cursorAfter: cursor, continues: false };

  // Cells.
  if (key === 'Delete' || key === 'Backspace') {
    const target: PListClearTarget = column === 0 ? 'note' : column === 1 ? 'tone' : { command: column === 4 ? 0 : 1 };
    return { type: 'edit', intent: { kind: 'clear-cell', row, target }, cursorAfter: cursor, continues: false };
  }

  const step = stepOf(event);
  const stay = (intent: PListIntent): PListKeyAction => ({ type: 'edit', intent, cursorAfter: cursor, continues: false });

  if (column === 0) {
    if (step !== null) return stay({ kind: 'nudge', row, target: { field: 'note' }, delta: step.delta * (step.big ? 12 : 1) });
    if (key === 'f' || key === 'F') return stay({ kind: 'fixed', row });
    const base = TRACKER_NOTE_KEY_MAP[event.code];
    if (base !== undefined && !event.shiftKey) {
      if (!env.rowFixed) {
        return {
          type: 'refuse',
          reason: 'A relative note is stepped, not played in: use + and −, or press F to make this row a fixed pitch and play a key.',
        };
      }
      const note = ahxNoteIndexFromMidi(base + (env.octave - AHX_DEFAULT_OCTAVE) * 12);
      if (note === undefined) return PASS;
      return {
        type: 'edit',
        intent: { kind: 'note', row, value: note },
        cursorAfter: at({ row: Math.max(0, Math.min(last, row + Math.max(0, env.stepSize))) }),
        continues: false,
      };
    }
    return isPrintableAlnum(key)
      ? { type: 'refuse', reason: 'The Note cell takes + and −, F for Fixed, and (on a fixed row) a piano key.' }
      : PASS;
  }

  if (column === 1) {
    if (step !== null) return stay({ kind: 'nudge', row, target: { field: 'waveform' }, delta: step.delta });
    const wave = /^[0-9]$/.test(key) ? Number(key) : TONE_KEYS[key.toLowerCase()];
    if (wave !== undefined) return stay({ kind: 'tone', row, value: wave });
    return isPrintableAlnum(key)
      ? { type: 'refuse', reason: `The Tone cell takes 0 to ${PLIST_MAX_WRITABLE_WAVEFORM}, or T, S, Q, N (triangle, sawtooth, square, noise).` }
      : PASS;
  }

  // A command: its digit and the two digits of its parameter.
  const slot = column === 4 ? 0 : 1;
  if (step !== null) {
    // Shift on a parameter is a step of 16 in the value; on the digit it is the same step.
    const target: PListNudgeTarget = { field: 'nibble', slot, nibble: step.big && nibble !== 0 ? 2 : nibble };
    return stay({ kind: 'nudge', row, target, delta: step.delta * (step.big && nibble !== 0 ? 16 : 1) });
  }
  const digit = hexDigitOf(key);
  if (digit !== null) {
    const finished = nibble === 2;
    return {
      type: 'edit',
      intent: { kind: 'nibble', row, slot, nibble, digit },
      // The tracker's macro entry: on to the next digit, and after the last one to the first digit, an edit step down.
      cursorAfter: finished
        ? at({ row: Math.max(0, Math.min(last, row + Math.max(0, env.stepSize))), nibble: 0 })
        : at({ nibble: (nibble + 1) as PListNibble }),
      continues: !finished,
    };
  }
  return isPrintableAlnum(key) ? { type: 'refuse', reason: `${key.toUpperCase()} is not a hex digit (0 to 9, A to F).` } : PASS;
}
