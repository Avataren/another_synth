import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import type { AhxInstrument } from '@another-synth/tracker-playback';

vi.mock('src/components/tracker/pattern-canvas/PatternCanvas.vue', async () => ({
  default: (await import('./helpers/pattern-canvas-stub')).PatternCanvasStub,
}));

import PListCanvas from 'src/components/ahx/PListCanvas.vue';
import PListCanvasMenu from 'src/components/ahx/PListCanvasMenu.vue';
import PatternCanvas from 'src/components/tracker/pattern-canvas/PatternCanvas.vue';
import { rowHeightPx, rowPitchPx } from 'src/components/tracker/pattern-canvas/pattern-layout';
import { defaultAhxInstrument } from 'src/audio/tracker/ahx-instrument-edit';
import { PLIST_MENU_ACTIONS } from 'src/audio/tracker/plist-edit-input';

/**
 * T11: the keyboard and mouse layer of the PList canvas (batch B6). The host
 * takes keys and clicks and turns them into events; the page commits them. What
 * is asserted here is what the host emits (and does not), against the key table
 * of plan §4.2. Pixels and real focus are the browser check (E-10..E-15).
 */
const rowsOf = (n: number): AhxInstrument['plist']['entries'] =>
  Array.from({ length: n }, (_, i) => ({ note: i + 1, waveform: (i % 4) + 1, fixed: i % 2 === 0, fx: [0, 0] as [number, number], fxParam: [0, 0] as [number, number] }));
const instrumentWith = (n: number): AhxInstrument => {
  const ins = defaultAhxInstrument();
  ins.plist = { speed: 2, entries: rowsOf(n) };
  return ins;
};

type Props = {
  instrument: AhxInstrument | null;
  selected?: number | null;
  editable?: boolean;
  editMode?: boolean;
  cursor?: { column: 0 | 1 | 4 | 5; nibble: 0 | 1 | 2 };
  stepSize?: number;
  octave?: number;
  menuReasons?: (row: number) => Partial<Record<(typeof PLIST_MENU_ACTIONS)[number], string>>;
};

function host(props: Props) {
  return mount(PListCanvas, {
    props: { selected: 2, editable: true, editMode: true, cursor: { column: 4, nibble: 0 }, ...props },
    attachTo: document.body,
  });
}
type Host = ReturnType<typeof host>;
const root = (w: Host) => w.get('[data-testid="ahx-plist-canvas"]');
const canvas = (w: Host) => w.findComponent(PatternCanvas);
const emitted = <T = unknown>(w: Host, name: string): T[] => (w.emitted(name) ?? []).map((args) => args[0] as T);

function press(w: Host, key: string, init: KeyboardEventInit = {}, target?: Element) {
  const event = new KeyboardEvent('keydown', { key, code: init.code ?? (key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key), bubbles: true, cancelable: true, ...init });
  (target ?? root(w).element).dispatchEvent(event);
  return event;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('Edit off: the canvas only selects and navigates', () => {
  it('draws no cursor cell and carries data-edit=false with no cursor', () => {
    const w = host({ instrument: instrumentWith(5), editMode: false });
    expect((canvas(w).props() as unknown as Record<string, unknown>).activeTrack).toBe(-1);
    expect((canvas(w).props() as unknown as Record<string, unknown>).activeColumn).toBe(-1);
    expect(root(w).attributes('data-edit')).toBe('false');
    expect(root(w).attributes('data-cursor-row')).toBe('-1');
    expect(w.find('[data-testid="ahx-plist-edit-hint"]').exists()).toBe(false);
    w.unmount();
  });

  it('every key of the edit table is inert, and a piano key is not stopped', () => {
    const w = host({ instrument: instrumentWith(5), editMode: false });
    const bubbled: string[] = [];
    document.body.addEventListener('keydown', (e) => bubbled.push(e.key));
    for (const key of ['5', 'a', 'F', '+', '-', 'Delete', 'Backspace', 'Insert', 'q', 'ArrowLeft', 'ArrowRight']) {
      const event = press(w, key);
      expect(event.defaultPrevented, key).toBe(false);
    }
    const ctrl = press(w, 'Delete', { ctrlKey: true });
    expect(ctrl.defaultPrevented).toBe(false);
    expect(bubbled).toContain('q');
    expect(w.emitted('edit')).toBeUndefined();
    expect(w.emitted('cursor')).toBeUndefined();
    expect(w.emitted('refuse')).toBeUndefined();
    expect(w.emitted('undo')).toBeUndefined();
    w.unmount();
  });

  it('View mode still moves the selection with the arrow keys (unchanged)', () => {
    const w = host({ instrument: instrumentWith(5), editMode: false, selected: 1 });
    press(w, 'ArrowDown');
    expect(emitted(w, 'select')).toEqual([2]);
    expect(w.emitted('cursor')).toBeUndefined();
    w.unmount();
  });
});

describe('Edit on: what the host shows', () => {
  it('draws the cursor cell through PatternCanvas’s own cursor props, and says so in data-*', () => {
    const w = host({ instrument: instrumentWith(5), cursor: { column: 5, nibble: 1 }, selected: 3 });
    const props = canvas(w).props() as unknown as Record<string, unknown>;
    expect(props.activeTrack).toBe(0);
    expect(props.activeColumn).toBe(5);
    expect(props.activeMacroNibble).toBe(1);
    expect(props.selectedRow).toBe(3);
    expect(root(w).attributes()).toMatchObject({ 'data-edit': 'true', 'data-cursor-row': '3', 'data-cursor-column': '5', 'data-cursor-nibble': '1' });
    w.unmount();
  });

  it('one hint line, and every statement in it is true against the key table and the page', () => {
    const w = host({ instrument: instrumentWith(5) });
    const hint = w.get('[data-testid="ahx-plist-edit-hint"]').text();
    expect(hint).toContain('Typed keys edit the step under the cursor');
    expect(hint).toContain('Keyboard piano keys are off; the on-screen keys and MIDI still play.');
    expect(hint).toContain('Ctrl+Z undoes');
    expect(hint).toContain('Esc leaves');
    w.unmount();
  });
});

describe('Edit on: the key table', () => {
  it('a hex digit writes the nibble under the cursor and moves to the next digit; the run is one step', () => {
    const w = host({ instrument: instrumentWith(5), cursor: { column: 4, nibble: 0 } });
    const event = press(w, '5');
    expect(event.defaultPrevented).toBe(true);
    expect(emitted(w, 'edit')[0]).toEqual({
      intent: { kind: 'nibble', row: 2, slot: 0, nibble: 0, digit: 5 },
      cursorAfter: { row: 2, column: 4, nibble: 1 },
      continues: true,
    });
    w.unmount();
  });

  it('after the last digit the cursor is asked to go to the first digit of the row an edit step down', () => {
    const w = host({ instrument: instrumentWith(5), cursor: { column: 5, nibble: 2 }, stepSize: 2 });
    press(w, 'C');
    expect(emitted(w, 'edit')[0]).toMatchObject({ cursorAfter: { row: 4, column: 5, nibble: 0 }, continues: false });
    w.unmount();
  });

  it('maps cursor position to the field written, for the Note, Tone and command cells', () => {
    const cases: { cursor: { column: 0 | 1 | 4 | 5; nibble: 0 | 1 | 2 }; key: string; init?: KeyboardEventInit; intent: unknown }[] = [
      { cursor: { column: 0, nibble: 0 }, key: '+', intent: { kind: 'nudge', row: 2, target: { field: 'note' }, delta: 1 } },
      { cursor: { column: 0, nibble: 0 }, key: 'f', intent: { kind: 'fixed', row: 2 } },
      { cursor: { column: 0, nibble: 0 }, key: 'Delete', intent: { kind: 'clear-cell', row: 2, target: 'note' } },
      { cursor: { column: 1, nibble: 0 }, key: 's', intent: { kind: 'tone', row: 2, value: 2 } },
      { cursor: { column: 1, nibble: 0 }, key: '3', intent: { kind: 'tone', row: 2, value: 3 } },
      { cursor: { column: 4, nibble: 1 }, key: 'e', intent: { kind: 'nibble', row: 2, slot: 0, nibble: 1, digit: 14 } },
      { cursor: { column: 5, nibble: 2 }, key: '7', intent: { kind: 'nibble', row: 2, slot: 1, nibble: 2, digit: 7 } },
      { cursor: { column: 4, nibble: 0 }, key: '-', intent: { kind: 'nudge', row: 2, target: { field: 'nibble', slot: 0, nibble: 0 }, delta: -1 } },
      { cursor: { column: 5, nibble: 1 }, key: 'Backspace', intent: { kind: 'clear-cell', row: 2, target: { command: 1 } } },
    ];
    for (const c of cases) {
      const w = host({ instrument: instrumentWith(5), cursor: c.cursor });
      press(w, c.key, c.init);
      expect(emitted<{ intent: unknown }>(w, 'edit')[0]?.intent, `${c.key} at ${JSON.stringify(c.cursor)}`).toEqual(c.intent);
      w.unmount();
    }
  });

  it('a piano key enters a pitch on a fixed row at the page’s octave; on a relative row it is refused', () => {
    const w = host({ instrument: instrumentWith(5), cursor: { column: 0, nibble: 0 }, selected: 2, octave: 5 });
    press(w, 'q'); // row 2 is fixed (i % 2 === 0)
    expect(emitted<{ intent: unknown }>(w, 'edit')[0]?.intent).toEqual({ kind: 'note', row: 2, value: 49 });
    w.unmount();
    const rel = host({ instrument: instrumentWith(5), cursor: { column: 0, nibble: 0 }, selected: 1 });
    press(rel, 'q');
    expect(rel.emitted('edit')).toBeUndefined();
    expect(emitted<string>(rel, 'refuse')[0]).toContain('A relative note is stepped');
    rel.unmount();
  });

  it('the cursor: rows and stops, the volume columns skipped, no wrap; each move is emitted for the page to apply', () => {
    const w = host({ instrument: instrumentWith(5), cursor: { column: 1, nibble: 0 }, selected: 0 });
    press(w, 'ArrowRight');
    press(w, 'ArrowUp');
    press(w, 'End');
    expect(emitted(w, 'cursor')).toEqual([
      { row: 0, column: 4, nibble: 0 }, // Tone -> Command 1's digit: the volume columns are not stops
      { row: 0, column: 1, nibble: 0 }, // no row above
      { row: 4, column: 1, nibble: 0 },
    ]);
    w.unmount();
    const edge = host({ instrument: instrumentWith(5), cursor: { column: 0, nibble: 0 } });
    press(edge, 'ArrowLeft');
    expect(emitted(edge, 'cursor')[0]).toEqual({ row: 2, column: 0, nibble: 0 });
    edge.unmount();
  });

  it('Insert and Ctrl+Delete are row edits, and Ctrl+Z / Ctrl+Shift+Z are the song’s undo and redo', () => {
    const w = host({ instrument: instrumentWith(5) });
    press(w, 'Insert');
    press(w, 'Delete', { ctrlKey: true });
    press(w, 'z', { ctrlKey: true });
    press(w, 'Z', { ctrlKey: true, shiftKey: true });
    expect(emitted<{ intent: unknown }>(w, 'edit').map((e) => e.intent)).toEqual([
      { kind: 'insert-above', row: 2 },
      { kind: 'delete', row: 2 },
    ]);
    expect(w.emitted('undo')).toHaveLength(1);
    expect(w.emitted('redo')).toHaveLength(1);
    w.unmount();
  });

  it('a key the canvas takes and cannot do says why and writes nothing', () => {
    const w = host({ instrument: instrumentWith(5), cursor: { column: 4, nibble: 1 } });
    const event = press(w, 'x');
    expect(event.defaultPrevented).toBe(true);
    expect(w.emitted('edit')).toBeUndefined();
    expect(emitted<string>(w, 'refuse')).toEqual(['X is not a hex digit (0 to 9, A to F).']);
    w.unmount();
  });

  it('Ctrl, Alt and Meta combinations that are not in the table pass through untouched', () => {
    const w = host({ instrument: instrumentWith(5) });
    for (const init of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
      for (const key of ['c', '5', 'a', 'ArrowDown', 'Insert', 'q']) {
        expect(press(w, key, init).defaultPrevented, `${JSON.stringify(init)} ${key}`).toBe(false);
      }
    }
    for (const key of ['Escape', 'F2', 'Tab', 'F5']) expect(press(w, key).defaultPrevented, key).toBe(false);
    expect(w.emitted('edit')).toBeUndefined();
    w.unmount();
  });

  it('keys typed into a table field or into the row menu are not the canvas’s', async () => {
    const w = host({ instrument: instrumentWith(5) });
    const input = document.createElement('input');
    input.type = 'number';
    root(w).element.appendChild(input);
    const select = document.createElement('select');
    root(w).element.appendChild(select);
    for (const target of [input, select]) {
      for (const key of ['5', 'ArrowDown', 'Delete']) expect(press(w, key, {}, target).defaultPrevented).toBe(false);
    }
    // The menu, open on a row, keeps its own keys.
    const stage = w.get('.plist-canvas__stage').element;
    const cv = document.createElement('canvas');
    stage.appendChild(cv);
    cv.getBoundingClientRect = () => ({ top: 0, left: 0, right: 100, bottom: 100, width: 100, height: 100, x: 0, y: 0, toJSON: () => ({}) });
    cv.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: rowPitchPx * 1 + 4 }));
    await nextTick();
    const item = w.get('[data-testid="ahx-plist-canvas-menu-clear"]').element;
    expect(press(w, 'ArrowDown', {}, item).defaultPrevented).toBe(false);
    expect(press(w, '5', {}, item).defaultPrevented).toBe(false);
    expect(w.emitted('edit')).toBeUndefined();
    expect(w.emitted('cursor')).toBeUndefined();
    w.unmount();
  });

  it('with no rows there is no canvas to type into', () => {
    const w = host({ instrument: instrumentWith(0) });
    expect(w.find('[data-testid="ahx-plist-canvas-empty"]').exists()).toBe(true);
    expect(root(w).attributes('tabindex')).toBeUndefined();
    w.unmount();
  });
});

describe('the mouse', () => {
  it('a click on a cell in Edit mode puts the cursor there, snapped to a legal stop; the row is selected', () => {
    const w = host({ instrument: instrumentWith(6), cursor: { column: 0, nibble: 0 } });
    canvas(w).vm.$emit('cellSelected', { row: 4, column: 4, trackIndex: 0, macroNibble: 2 });
    canvas(w).vm.$emit('cellSelected', { row: 1, column: 2, trackIndex: 0 });
    canvas(w).vm.$emit('cellSelected', { row: 3, column: 3, trackIndex: 0 });
    canvas(w).vm.$emit('cellSelected', { row: 0, column: 5, trackIndex: 0, macroNibble: 1 });
    expect(emitted(w, 'cursor')).toEqual([
      { row: 4, column: 4, nibble: 2 },
      { row: 1, column: 1, nibble: 0 },
      { row: 3, column: 4, nibble: 0 },
      { row: 0, column: 5, nibble: 1 },
    ]);
    expect(emitted(w, 'select')).toEqual([4, 1, 3, 0]);
    w.unmount();
  });

  it('a click in View mode only selects the row', () => {
    const w = host({ instrument: instrumentWith(6), editMode: false });
    canvas(w).vm.$emit('cellSelected', { row: 4, column: 4, trackIndex: 0, macroNibble: 2 });
    expect(emitted(w, 'select')).toEqual([4]);
    expect(w.emitted('cursor')).toBeUndefined();
    w.unmount();
  });

  it('double-click hands the cell off to its table field, in either mode', () => {
    const cases: [{ row: number; column: number; macroNibble?: number }, string][] = [
      [{ row: 3, column: 0 }, 'ahx-plist-3-note'],
      [{ row: 3, column: 1 }, 'ahx-plist-3-waveform'],
      [{ row: 3, column: 2 }, 'ahx-plist-3-waveform'], // volume column: snapped to Tone
      [{ row: 3, column: 3 }, 'ahx-plist-3-fx0'], // volume column: snapped to Command 1
      [{ row: 3, column: 4, macroNibble: 0 }, 'ahx-plist-3-fx0'],
      [{ row: 3, column: 4, macroNibble: 1 }, 'ahx-plist-3-param0'],
      [{ row: 3, column: 4, macroNibble: 2 }, 'ahx-plist-3-param0'],
      [{ row: 3, column: 5, macroNibble: 0 }, 'ahx-plist-3-fx1'],
      [{ row: 3, column: 5, macroNibble: 2 }, 'ahx-plist-3-param1'],
    ];
    for (const editMode of [false, true]) {
      for (const [cell, testid] of cases) {
        const w = host({ instrument: instrumentWith(6), editMode });
        canvas(w).vm.$emit('cellSelected', { ...cell, trackIndex: 0 });
        w.get('.plist-canvas__stage').element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        expect(emitted(w, 'focus-field'), `${JSON.stringify(cell)} edit=${String(editMode)}`).toEqual([testid]);
        w.unmount();
      }
    }
  });

  it('a double-click on the gutter, or before any click, hands nothing off', () => {
    const w = host({ instrument: instrumentWith(6) });
    w.get('.plist-canvas__stage').element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    canvas(w).vm.$emit('cellSelected', { row: 1, column: 1, trackIndex: 0 });
    canvas(w).vm.$emit('rowSelected', 2);
    w.get('.plist-canvas__stage').element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(w.emitted('focus-field')).toBeUndefined();
    w.unmount();
  });
});

describe('the row menu', () => {
  const openMenu = async (w: Host, row: number, init: MouseEventInit = {}) => {
    const stage = w.get('.plist-canvas__stage').element;
    const cv = document.createElement('canvas');
    stage.appendChild(cv);
    cv.getBoundingClientRect = () => ({ top: 100, left: 0, right: 300, bottom: 500, width: 300, height: 400, x: 0, y: 100, toJSON: () => ({}) });
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 100 + row * rowPitchPx + 6, ...init });
    cv.dispatchEvent(event);
    await nextTick();
    return event;
  };
  const menu = (w: Host) => w.find('[data-testid="ahx-plist-canvas-menu"]');

  it('right-click opens it at the pointer on the row under the pointer, and selects that row', async () => {
    const w = host({ instrument: instrumentWith(6), editMode: false });
    const event = await openMenu(w, 3);
    expect(event.defaultPrevented).toBe(true);
    expect(menu(w).exists()).toBe(true);
    expect(menu(w).attributes('data-row')).toBe('3');
    expect(menu(w).attributes('role')).toBe('menu');
    expect((menu(w).element as HTMLElement).style.left).toBe('60px');
    expect(emitted(w, 'select')).toEqual([3]);
    const items = w.findAll('[role="menuitem"]');
    expect(items.map((i) => i.attributes('data-testid'))).toEqual(PLIST_MENU_ACTIONS.map((a) => `ahx-plist-canvas-menu-${a}`));
    expect(items.map((i) => i.text())).toEqual(['Insert row above', 'Insert row below', 'Duplicate row', 'Delete row', 'Clear row', 'Toggle Fixed']);
    w.unmount();
  });

  it('a point in the gap between two rows, or below the last one, opens nothing', async () => {
    const w = host({ instrument: instrumentWith(3), editMode: false });
    const gap = await openMenu(w, 1, { clientY: 100 + 1 * rowPitchPx + rowHeightPx + 2 });
    expect(gap.defaultPrevented).toBe(false);
    const below = await openMenu(w, 5);
    expect(below.defaultPrevented).toBe(false);
    expect(menu(w).exists()).toBe(false);
    w.unmount();
  });

  it('each item asks for the same edit a key would, and the menu closes', async () => {
    const expected: Record<(typeof PLIST_MENU_ACTIONS)[number], { intent: unknown; row: number }> = {
      'insert-above': { intent: { kind: 'insert-above', row: 2 }, row: 2 },
      'insert-below': { intent: { kind: 'insert-below', row: 2 }, row: 3 },
      duplicate: { intent: { kind: 'duplicate', row: 2 }, row: 3 },
      delete: { intent: { kind: 'delete', row: 2 }, row: 2 },
      clear: { intent: { kind: 'clear', row: 2 }, row: 2 },
      fixed: { intent: { kind: 'fixed', row: 2 }, row: 2 },
    };
    for (const action of PLIST_MENU_ACTIONS) {
      const w = host({ instrument: instrumentWith(6), editMode: false, cursor: { column: 4, nibble: 1 } });
      await openMenu(w, 2);
      await w.get(`[data-testid="ahx-plist-canvas-menu-${action}"]`).trigger('click');
      expect(emitted(w, 'edit')).toEqual([{ intent: expected[action].intent, cursorAfter: { row: expected[action].row, column: 4, nibble: 1 }, continues: false }]);
      expect(menu(w).exists()).toBe(false);
      w.unmount();
    }
  });

  it('deleting the last row asks the cursor to land on the new last row', async () => {
    const w = host({ instrument: instrumentWith(4), editMode: false });
    await openMenu(w, 3);
    await w.get('[data-testid="ahx-plist-canvas-menu-delete"]').trigger('click');
    expect(emitted<{ cursorAfter: { row: number } }>(w, 'edit')[0]?.cursorAfter.row).toBe(2);
    w.unmount();
  });

  it('an item that cannot be done is disabled and its tooltip is the reason', async () => {
    const reasons = { 'insert-above': 'A PList has at most 255 rows.', duplicate: 'Song is 65,535 of 65,535 bytes; a PList row needs 4.' };
    const w = host({ instrument: instrumentWith(6), editMode: false, menuReasons: () => reasons });
    await openMenu(w, 1);
    const above = w.get('[data-testid="ahx-plist-canvas-menu-insert-above"]');
    expect(above.attributes('disabled')).toBeDefined();
    expect(above.attributes('title')).toBe(reasons['insert-above']);
    expect(w.get('[data-testid="ahx-plist-canvas-menu-duplicate"]').attributes('title')).toBe(reasons.duplicate);
    const clear = w.get('[data-testid="ahx-plist-canvas-menu-clear"]');
    expect(clear.attributes('disabled')).toBeUndefined();
    expect(clear.attributes('title')).toContain('Empties this row');
    await above.trigger('click');
    expect(w.emitted('edit')).toBeUndefined();
    w.unmount();
  });

  it('Escape closes it (and only it: the page’s Escape does not run), a click outside closes it', async () => {
    const w = host({ instrument: instrumentWith(6), editMode: false });
    const pageEscape = vi.fn();
    window.addEventListener('keydown', pageEscape);
    await openMenu(w, 1);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await nextTick();
    expect(menu(w).exists()).toBe(false);
    expect(pageEscape).not.toHaveBeenCalled();
    await openMenu(w, 1);
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await nextTick();
    expect(menu(w).exists()).toBe(false);
    // With no menu open, Escape reaches the page.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(pageEscape).toHaveBeenCalledTimes(1);
    window.removeEventListener('keydown', pageEscape);
    w.unmount();
  });

  it('a click inside the menu does not count as outside', async () => {
    const w = host({ instrument: instrumentWith(6), editMode: false });
    await openMenu(w, 1);
    w.get('[data-testid="ahx-plist-canvas-menu-clear"]').element.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await nextTick();
    expect(menu(w).exists()).toBe(true);
    w.unmount();
  });

  it('on a song that cannot be edited here there is no menu: the browser’s own stays', async () => {
    const w = host({ instrument: instrumentWith(6), editMode: false, editable: false });
    const event = await openMenu(w, 1);
    expect(event.defaultPrevented).toBe(false);
    expect(menu(w).exists()).toBe(false);
    expect(w.find('[data-testid="ahx-plist-canvas-caption-menu"]').exists()).toBe(false);
    w.unmount();
  });

  it('the menu closes when the list it was about changes', async () => {
    const w = host({ instrument: instrumentWith(6), editMode: false });
    await openMenu(w, 1);
    await w.setProps({ instrument: instrumentWith(5) });
    expect(menu(w).exists()).toBe(false);
    w.unmount();
  });
});

describe('native elements only', () => {
  it('no Quasar component in the canvas host or its menu (the source and the rendered tree)', () => {
    for (const file of ['PListCanvas.vue', 'PListCanvasMenu.vue']) {
      const source = readFileSync(resolve(__dirname, '../components/ahx', file), 'utf8');
      expect(source, file).not.toMatch(/<q-|<Q[A-Z]|from 'quasar'/);
    }
    const w = host({ instrument: instrumentWith(3) });
    expect(w.html()).not.toMatch(/class="q-/);
    w.unmount();
    expect(PListCanvasMenu).toBeDefined();
  });
});
