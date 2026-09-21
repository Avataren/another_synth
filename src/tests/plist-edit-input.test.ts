// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { AhxInstrument } from '@another-synth/tracker-playback';
import { defaultAhxInstrument, emptyPListEntry } from 'src/audio/tracker/ahx-instrument-edit';
import {
  PLIST_MENU_ACTIONS,
  PLIST_STOPS,
  plistKeyAction,
  runPListIntent,
  snapToStop,
  stepStop,
  type PListCursor,
  type PListKeyAction,
  type PListKeyEnv,
  type PListKeyLike,
} from 'src/audio/tracker/plist-edit-input';
import { AHX_DEFAULT_OCTAVE } from 'src/composables/useAhxPlayInput';

/** The key table of plan §4.2, as pure data: the cursor and a key in, the action out. */
const key = (k: string, over: Partial<PListKeyLike> = {}): PListKeyLike => ({
  key: k,
  code: over.code ?? (k.length === 1 ? (/[a-z]/i.test(k) ? `Key${k.toUpperCase()}` : /[0-9]/.test(k) ? `Digit${k}` : k) : k),
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...over,
});
const env = (over: Partial<PListKeyEnv> = {}): PListKeyEnv => ({ rowCount: 10, rowFixed: false, stepSize: 1, octave: AHX_DEFAULT_OCTAVE, ...over });
const cur = (row: number, column: PListCursor['column'], nibble: PListCursor['nibble'] = 0): PListCursor => ({ row, column, nibble });
const edit = (a: PListKeyAction) => {
  if (a.type !== 'edit') throw new Error(`expected an edit, got ${JSON.stringify(a)}`);
  return a;
};

describe('the cursor stops', () => {
  it('are Note, Tone and three digits for each command, and no volume column', () => {
    expect(PLIST_STOPS.map((s) => `${s.column}.${s.nibble}`)).toEqual(['0.0', '1.0', '4.0', '4.1', '4.2', '5.0', '5.1', '5.2']);
    expect((PLIST_STOPS as readonly { column: number }[]).some((s) => s.column === 2 || s.column === 3)).toBe(false);
  });

  it('a click on a volume column goes to the nearer stop; every canvas column maps to a legal one', () => {
    expect(snapToStop(2)).toEqual({ column: 1, nibble: 0 });
    expect(snapToStop(3)).toEqual({ column: 4, nibble: 0 });
    expect(snapToStop(0)).toEqual({ column: 0, nibble: 0 });
    expect(snapToStop(1)).toEqual({ column: 1, nibble: 0 });
    expect(snapToStop(4, 2)).toEqual({ column: 4, nibble: 2 });
    expect(snapToStop(5, 1)).toEqual({ column: 5, nibble: 1 });
    expect(snapToStop(5)).toEqual({ column: 5, nibble: 0 });
    for (const column of [0, 1, 2, 3, 4, 5]) {
      for (const nibble of [undefined, 0, 1, 2]) {
        const stop = snapToStop(column, nibble);
        expect(PLIST_STOPS).toContainEqual(stop);
      }
    }
  });

  it('stepStop does not wrap at either end and steps across the volume gap in one move', () => {
    expect(stepStop({ column: 0, nibble: 0 }, -1)).toEqual({ column: 0, nibble: 0 });
    expect(stepStop({ column: 5, nibble: 2 }, 1)).toEqual({ column: 5, nibble: 2 });
    expect(stepStop({ column: 1, nibble: 0 }, 1)).toEqual({ column: 4, nibble: 0 });
    expect(stepStop({ column: 4, nibble: 2 }, 1)).toEqual({ column: 5, nibble: 0 });
    expect(stepStop({ column: 4, nibble: 0 }, -1)).toEqual({ column: 1, nibble: 0 });
  });
});

describe('moving', () => {
  it('rows: Up/Down/PageUp/PageDown/Home/End, clamped', () => {
    const at = (k: string, c: PListCursor) => plistKeyAction(key(k), c, env());
    expect(at('ArrowDown', cur(3, 1))).toEqual({ type: 'move', cursor: cur(4, 1) });
    expect(at('ArrowDown', cur(9, 1))).toEqual({ type: 'move', cursor: cur(9, 1) });
    expect(at('ArrowUp', cur(0, 4, 2))).toEqual({ type: 'move', cursor: cur(0, 4, 2) });
    expect(at('PageDown', cur(3, 0))).toEqual({ type: 'move', cursor: cur(9, 0) });
    expect(at('PageUp', cur(3, 0))).toEqual({ type: 'move', cursor: cur(0, 0) });
    expect(at('Home', cur(6, 5, 1))).toEqual({ type: 'move', cursor: cur(0, 5, 1) });
    expect(at('End', cur(6, 5, 1))).toEqual({ type: 'move', cursor: cur(9, 5, 1) });
  });

  it('Left/Right: through the stops, no wrap', () => {
    expect(plistKeyAction(key('ArrowRight'), cur(2, 1), env())).toEqual({ type: 'move', cursor: cur(2, 4, 0) });
    expect(plistKeyAction(key('ArrowRight'), cur(2, 4, 2), env())).toEqual({ type: 'move', cursor: cur(2, 5, 0) });
    expect(plistKeyAction(key('ArrowRight'), cur(2, 5, 2), env())).toEqual({ type: 'move', cursor: cur(2, 5, 2) });
    expect(plistKeyAction(key('ArrowLeft'), cur(2, 0), env())).toEqual({ type: 'move', cursor: cur(2, 0) });
    expect(plistKeyAction(key('ArrowLeft'), cur(2, 4, 0), env())).toEqual({ type: 'move', cursor: cur(2, 1) });
  });
});

describe('a command, a digit at a time', () => {
  it('every hex digit, either case, writes the nibble under the cursor and moves to the next digit (one undo step so far)', () => {
    for (const [k, digit] of [['0', 0], ['9', 9], ['a', 10], ['F', 15], ['c', 12]] as const) {
      expect(plistKeyAction(key(k), cur(2, 4, 0), env())).toEqual({
        type: 'edit',
        intent: { kind: 'nibble', row: 2, slot: 0, nibble: 0, digit },
        cursorAfter: cur(2, 4, 1),
        continues: true,
      });
    }
    expect(edit(plistKeyAction(key('A'), cur(2, 5, 1), env())).intent).toEqual({ kind: 'nibble', row: 2, slot: 1, nibble: 1, digit: 10 });
  });

  it('after the last digit: the first digit of the row an edit step down, and the step is over', () => {
    const a = edit(plistKeyAction(key('B'), cur(2, 4, 2), env({ stepSize: 1 })));
    expect(a).toMatchObject({ cursorAfter: cur(3, 4, 0), continues: false, intent: { kind: 'nibble', nibble: 2, digit: 11 } });
    expect(edit(plistKeyAction(key('B'), cur(2, 4, 2), env({ stepSize: 3 }))).cursorAfter).toEqual(cur(5, 4, 0));
    // The edit step of the tracker can be 0: the cursor stays on the row.
    expect(edit(plistKeyAction(key('B'), cur(2, 4, 2), env({ stepSize: 0 }))).cursorAfter).toEqual(cur(2, 4, 0));
    // The last row: no row below, so back to the first digit of the same row.
    expect(edit(plistKeyAction(key('B'), cur(9, 5, 2), env())).cursorAfter).toEqual(cur(9, 5, 0));
  });

  it('a letter that is not a hex digit is refused and says so', () => {
    expect(plistKeyAction(key('g'), cur(0, 4, 1), env())).toEqual({ type: 'refuse', reason: 'G is not a hex digit (0 to 9, A to F).' });
  });

  it('+ and − step the digit; Shift with the numpad key steps the parameter by 16', () => {
    expect(edit(plistKeyAction(key('+'), cur(1, 4, 0), env()))).toMatchObject({
      intent: { kind: 'nudge', row: 1, target: { field: 'nibble', slot: 0, nibble: 0 }, delta: 1 },
      cursorAfter: cur(1, 4, 0),
      continues: false,
    });
    expect(edit(plistKeyAction(key('-'), cur(1, 5, 2), env())).intent).toEqual({ kind: 'nudge', row: 1, target: { field: 'nibble', slot: 1, nibble: 2 }, delta: -1 });
    const big = key('+', { code: 'NumpadAdd', shiftKey: true });
    expect(edit(plistKeyAction(big, cur(1, 4, 2), env())).intent).toEqual({ kind: 'nudge', row: 1, target: { field: 'nibble', slot: 0, nibble: 2 }, delta: 16 });
    expect(edit(plistKeyAction(key('-', { code: 'NumpadSubtract', shiftKey: true }), cur(1, 4, 1), env())).intent).toEqual({
      kind: 'nudge',
      row: 1,
      target: { field: 'nibble', slot: 0, nibble: 2 },
      delta: -16,
    });
    // On a US keyboard `+` is Shift+= : that is the small step, not the big one.
    expect(edit(plistKeyAction(key('+', { code: 'Equal', shiftKey: true }), cur(1, 4, 2), env())).intent).toMatchObject({ delta: 1 });
  });

  it('Delete and Backspace clear the whole command from any of its digits', () => {
    for (const k of ['Delete', 'Backspace']) {
      expect(edit(plistKeyAction(key(k), cur(1, 4, 2), env())).intent).toEqual({ kind: 'clear-cell', row: 1, target: { command: 0 } });
      expect(edit(plistKeyAction(key(k), cur(1, 5, 0), env())).intent).toEqual({ kind: 'clear-cell', row: 1, target: { command: 1 } });
    }
  });
});

describe('the Tone cell', () => {
  it('0..4 and T S Q N write the tone; 5..9 are sent to the op, which refuses them with the range', () => {
    for (const [k, value] of [['0', 0], ['1', 1], ['4', 4], ['t', 1], ['S', 2], ['q', 3], ['n', 4], ['7', 7]] as const) {
      expect(edit(plistKeyAction(key(k), cur(0, 1), env())).intent).toEqual({ kind: 'tone', row: 0, value });
    }
    expect(plistKeyAction(key('x'), cur(0, 1), env())).toMatchObject({ type: 'refuse' });
    const r = runPListIntent(instrument(3), { kind: 'tone', row: 0, value: 7 }, { format: 'ahx', version: 1 });
    expect(r).toEqual({ ok: false, reason: 'A PList tone is 0 to 4 (got 7).' });
  });

  it('+ and − cycle 0..4 (the op clamps); Delete clears the tone', () => {
    expect(edit(plistKeyAction(key('+'), cur(0, 1), env())).intent).toEqual({ kind: 'nudge', row: 0, target: { field: 'waveform' }, delta: 1 });
    expect(edit(plistKeyAction(key('Delete'), cur(0, 1), env())).intent).toEqual({ kind: 'clear-cell', row: 0, target: 'tone' });
  });
});

describe('the Note cell', () => {
  it('+ and − step a semitone; Shift with the numpad key an octave; F toggles Fixed; Delete clears the note', () => {
    expect(edit(plistKeyAction(key('+'), cur(0, 0), env())).intent).toEqual({ kind: 'nudge', row: 0, target: { field: 'note' }, delta: 1 });
    expect(edit(plistKeyAction(key('-', { code: 'NumpadSubtract', shiftKey: true }), cur(0, 0), env())).intent).toMatchObject({ delta: -12 });
    expect(edit(plistKeyAction(key('f'), cur(0, 0), env())).intent).toEqual({ kind: 'fixed', row: 0 });
    expect(edit(plistKeyAction(key('F'), cur(0, 0), env())).intent).toEqual({ kind: 'fixed', row: 0 });
    expect(edit(plistKeyAction(key('Delete'), cur(0, 0), env())).intent).toEqual({ kind: 'clear-cell', row: 0, target: 'note' });
  });

  it('a piano key enters that pitch at the page’s octave, on a FIXED row only', () => {
    // KeyQ = MIDI 60 at octave 4; the AHX note index is midi − 23 (C-4 is note 37).
    const q = key('q');
    expect(edit(plistKeyAction(q, cur(2, 0), env({ rowFixed: true }))).intent).toEqual({ kind: 'note', row: 2, value: 37 });
    expect(edit(plistKeyAction(q, cur(2, 0), env({ rowFixed: true, octave: 5 }))).intent).toEqual({ kind: 'note', row: 2, value: 49 });
    expect(edit(plistKeyAction(q, cur(2, 0), env({ rowFixed: true, octave: 3 }))).intent).toEqual({ kind: 'note', row: 2, value: 25 });
    // A note entry moves down by the edit step, like the tracker's.
    expect(edit(plistKeyAction(q, cur(2, 0), env({ rowFixed: true, stepSize: 2 }))).cursorAfter).toEqual(cur(4, 0));
    // A relative row is stepped: a piano key is refused with the way out.
    const refused = plistKeyAction(q, cur(2, 0), env({ rowFixed: false }));
    expect(refused).toEqual({
      type: 'refuse',
      reason: 'A relative note is stepped, not played in: use + and −, or press F to make this row a fixed pitch and play a key.',
    });
  });

  it('a printable key the cell does not take is refused; a key that is not printable passes', () => {
    expect(plistKeyAction(key('a'), cur(0, 0), env())).toMatchObject({ type: 'refuse' });
    expect(plistKeyAction(key('F5'), cur(0, 0), env())).toEqual({ type: 'pass' });
    expect(plistKeyAction(key('Tab'), cur(0, 0), env())).toEqual({ type: 'pass' });
    expect(plistKeyAction(key('Escape'), cur(0, 0), env())).toEqual({ type: 'pass' });
    expect(plistKeyAction(key('F2'), cur(0, 0), env())).toEqual({ type: 'pass' });
    expect(plistKeyAction(key(' '), cur(0, 0), env())).toEqual({ type: 'pass' });
  });
});

describe('rows and the store-level keys', () => {
  it('Insert adds a row above; Ctrl+Delete and Ctrl+Backspace remove the cursor row, the cursor staying on a row that exists', () => {
    expect(edit(plistKeyAction(key('Insert'), cur(3, 4, 1), env()))).toMatchObject({ intent: { kind: 'insert-above', row: 3 }, cursorAfter: cur(3, 4, 1), continues: false });
    for (const k of ['Delete', 'Backspace']) {
      expect(edit(plistKeyAction(key(k, { ctrlKey: true }), cur(3, 1), env())).intent).toEqual({ kind: 'delete', row: 3 });
    }
    expect(edit(plistKeyAction(key('Delete', { ctrlKey: true }), cur(9, 1), env())).cursorAfter).toEqual(cur(8, 1));
    expect(edit(plistKeyAction(key('Delete', { ctrlKey: true }), cur(0, 1), env({ rowCount: 1 }))).cursorAfter).toEqual(cur(0, 1));
  });

  it('Ctrl+Z is undo, Ctrl+Shift+Z redo (Cmd too); every other Ctrl, Alt or Meta combination passes', () => {
    expect(plistKeyAction(key('z', { ctrlKey: true }), cur(0, 0), env())).toEqual({ type: 'undo' });
    expect(plistKeyAction(key('Z', { ctrlKey: true, shiftKey: true }), cur(0, 0), env())).toEqual({ type: 'redo' });
    expect(plistKeyAction(key('z', { metaKey: true }), cur(0, 0), env())).toEqual({ type: 'undo' });
    for (const over of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
      for (const k of ['c', 'a', '5', 'ArrowDown', 'Delete', 'Insert', 'q', 'F5', 'Tab']) {
        if (over.ctrlKey && k === 'Delete') continue;
        expect(plistKeyAction(key(k, over), cur(0, 4, 0), env())).toEqual({ type: 'pass' });
      }
    }
  });

  it('with no rows there is nothing to edit: everything passes', () => {
    expect(plistKeyAction(key('5'), cur(0, 4, 0), env({ rowCount: 0 }))).toEqual({ type: 'pass' });
  });
});

function instrument(rows: number): AhxInstrument {
  const ins = defaultAhxInstrument();
  ins.plist.entries = Array.from({ length: rows }, () => emptyPListEntry());
  return ins;
}

describe('runPListIntent: an intent is exactly one op', () => {
  it('runs every menu action, and the op refuses in words a menu can show', () => {
    const ins = instrument(3);
    const ctx = { format: 'ahx', version: 1 } as const;
    for (const action of PLIST_MENU_ACTIONS) {
      const r = runPListIntent(ins, { kind: action, row: 1 }, ctx);
      expect(r.ok).toBe(true);
    }
    const full = instrument(255);
    const insertAbove = runPListIntent(full, { kind: 'insert-above', row: 0 }, ctx);
    expect(insertAbove).toEqual({ ok: false, reason: 'A PList has at most 255 rows.' });
    expect(runPListIntent(full, { kind: 'duplicate', row: 0 }, ctx)).toEqual({ ok: false, reason: 'A PList has at most 255 rows.' });
    expect(runPListIntent(ins, { kind: 'delete', row: 9 }, ctx)).toEqual({ ok: false, reason: 'There is no PList row 9: this PList has 3.' });
    // Inserting after -1 puts the row first; after the last row it appends.
    expect(runPListIntent(ins, { kind: 'insert-below', row: -1 }, ctx)).toMatchObject({ ok: true, changed: true });
    expect(runPListIntent(ins, { kind: 'insert-below', row: 2 }, ctx)).toMatchObject({ ok: true, changed: true });
  });
});
