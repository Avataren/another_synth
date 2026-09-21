import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { AhxInstrument } from '@another-synth/tracker-playback';

vi.mock('src/stores/tracker-playback-store', () => ({
  useTrackerPlaybackStore: () => ({ previewAhxNoteOn: async () => true, previewAhxNoteOff: () => undefined }),
}));
vi.mock('src/components/tracker/pattern-canvas/PatternCanvas.vue', async () => ({
  default: (await import('./helpers/pattern-canvas-stub')).PatternCanvasStub,
}));

import AhxInstrumentPage from 'pages/AhxInstrumentPage.vue';
import PatternCanvas from 'src/components/tracker/pattern-canvas/PatternCanvas.vue';
import { useTrackerStore } from 'src/stores/tracker-store';
import { importAhxToTrackerSong } from 'src/audio/tracker/ahx-import';
import { setCurrentAhxSource } from 'src/audio/tracker/ahx-source';
import { clearAhxEditNotice } from 'src/audio/tracker/ahx-edit-notice';
import { emptyPListEntry } from 'src/audio/tracker/ahx-instrument-edit';

/**
 * T12: canvas edit ≡ table edit. For each editable field and each row of the
 * key table (plan §4.2), the same instrument is edited once through the canvas
 * (a click for the cursor, then the key) and once through the equivalent table
 * control; the slot's `ahxData` and the song's bytes must come out the same.
 * The canvas has no writer of its own, so this is the "no parallel mechanism"
 * gate as a test.
 */
const karma = (): ArrayBuffer => {
  const b = readFileSync(resolve(__dirname, '../../public/demos/ahx/karma.ahx'));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

type Row = Partial<AhxInstrument['plist']['entries'][number]>;
const BASE_ROWS: Row[] = [
  { note: 5, waveform: 2, fixed: false, fx: [1, 3], fxParam: [0x10, 0x22] },
  { note: 30, waveform: 0, fixed: true, fx: [5, 0], fxParam: [0x03, 0] },
  { note: 0, waveform: 4, fixed: false, fx: [0, 0], fxParam: [0, 0] },
  { note: 12, waveform: 1, fixed: true, fx: [2, 15], fxParam: [0x40, 0x08] },
  { note: 63, waveform: 3, fixed: false, fx: [0, 0], fxParam: [0, 0] },
  { note: 1, waveform: 0, fixed: false, fx: [3, 0], fxParam: [0x7f, 0] },
];

async function mountEditor() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/ahx/instrument/:slot', name: 'ahx-instrument-display', component: AhxInstrumentPage },
      { path: '/tracker', component: { template: '<div/>' } },
    ],
  });
  await router.push('/ahx/instrument/1');
  await router.isReady();
  return mount(AhxInstrumentPage, {
    attachTo: document.body,
    global: { plugins: [router], stubs: { QPage: { template: '<div><slot /></div>' }, QIcon: true, QBtn: true } },
  });
}
type Wrapper = Awaited<ReturnType<typeof mountEditor>>;
const el = (w: Wrapper, testid: string) => w.get(`[data-testid="${testid}"]`);
const flush = async () => {
  await nextTick();
  await nextTick();
};

interface Case {
  name: string;
  /** Where the cursor goes (canvas column, command digit) and the key(s) typed there. */
  row: number;
  column: number;
  nibble?: number;
  keys: { key: string; init?: KeyboardEventInit }[];
  /** The table's way of making the same edit. */
  table: (w: Wrapper) => Promise<void>;
  /** The edit is a step into the end of a range: nothing is written, on either path. */
  noop?: boolean;
  /** The menu's way, when the key table has none (an op with no table twin is compared with the primitive in T10). */
}

const numpad = (key: '+' | '-'): KeyboardEventInit => ({ code: key === '+' ? 'NumpadAdd' : 'NumpadSubtract', shiftKey: true });
const setField = (testid: string, value: string | boolean) => async (w: Wrapper) => {
  await el(w, testid).setValue(value);
  await flush();
};
const click = (testid: string) => async (w: Wrapper) => {
  await el(w, testid).trigger('click');
  await flush();
};
const seq = (...steps: ((w: Wrapper) => Promise<void>)[]) => async (w: Wrapper) => {
  for (const step of steps) await step(w);
};

const CASES: Case[] = [
  // Note
  { name: 'Note + steps a semitone', row: 1, column: 0, keys: [{ key: '+' }], table: setField('ahx-plist-1-note', '31') },
  { name: 'Note − steps a semitone', row: 1, column: 0, keys: [{ key: '-' }], table: setField('ahx-plist-1-note', '29') },
  { name: 'Note Shift+numpad + is an octave', row: 1, column: 0, keys: [{ key: '+', init: numpad('+') }], table: setField('ahx-plist-1-note', '42') },
  { name: 'Note − stops at 0', row: 2, column: 0, keys: [{ key: '-' }], table: setField('ahx-plist-2-note', '0') , noop: true },
  { name: 'Note + stops at 63', row: 4, column: 0, keys: [{ key: '+' }], table: setField('ahx-plist-4-note', '63') , noop: true },
  { name: 'Note Delete clears it', row: 1, column: 0, keys: [{ key: 'Delete' }], table: setField('ahx-plist-1-note', '0') },
  { name: 'Note: a piano key on a fixed row', row: 1, column: 0, keys: [{ key: 'q', init: { code: 'KeyQ' } }], table: setField('ahx-plist-1-note', '37') },
  { name: 'Note: F toggles Fixed off', row: 1, column: 0, keys: [{ key: 'f', init: { code: 'KeyF' } }], table: setField('ahx-plist-1-fixed', false) },
  { name: 'Note: F toggles Fixed on', row: 0, column: 0, keys: [{ key: 'f', init: { code: 'KeyF' } }], table: setField('ahx-plist-0-fixed', true) },
  // Tone
  { name: 'Tone digit 3', row: 0, column: 1, keys: [{ key: '3' }], table: setField('ahx-plist-0-waveform', '3') },
  { name: 'Tone digit 0 keeps the tone', row: 0, column: 1, keys: [{ key: '0' }], table: setField('ahx-plist-0-waveform', '0') },
  { name: 'Tone letter N is noise', row: 0, column: 1, keys: [{ key: 'n', init: { code: 'KeyN' } }], table: setField('ahx-plist-0-waveform', '4') },
  { name: 'Tone letter T is triangle', row: 0, column: 1, keys: [{ key: 't', init: { code: 'KeyT' } }], table: setField('ahx-plist-0-waveform', '1') },
  { name: 'Tone + cycles up', row: 0, column: 1, keys: [{ key: '+' }], table: setField('ahx-plist-0-waveform', '3') },
  { name: 'Tone − cycles down', row: 0, column: 1, keys: [{ key: '-' }], table: setField('ahx-plist-0-waveform', '1') },
  { name: 'Tone + stops at 4', row: 2, column: 1, keys: [{ key: '+' }], table: setField('ahx-plist-2-waveform', '4') , noop: true },
  { name: 'Tone Delete clears it', row: 0, column: 1, keys: [{ key: 'Delete' }], table: setField('ahx-plist-0-waveform', '0') },
  // Command 1 and 2, digit by digit
  { name: 'Command 1 digit', row: 0, column: 4, nibble: 0, keys: [{ key: '3' }], table: setField('ahx-plist-0-fx0', '3') },
  { name: 'Command 2 digit', row: 0, column: 5, nibble: 0, keys: [{ key: '2' }], table: setField('ahx-plist-0-fx1', '2') },
  { name: 'Command digit +', row: 0, column: 4, nibble: 0, keys: [{ key: '+' }], table: setField('ahx-plist-0-fx0', '2') },
  { name: 'Command digit −', row: 0, column: 4, nibble: 0, keys: [{ key: '-' }], table: setField('ahx-plist-0-fx0', '0') },
  { name: 'Parameter high digit', row: 0, column: 4, nibble: 1, keys: [{ key: 'a' }], table: setField('ahx-plist-0-param0', String(0xa0)) },
  { name: 'Parameter low digit', row: 0, column: 4, nibble: 2, keys: [{ key: '7' }], table: setField('ahx-plist-0-param0', String(0x17)) },
  { name: 'Command 2 parameter high digit', row: 0, column: 5, nibble: 1, keys: [{ key: 'F', init: { code: 'KeyF' } }], table: setField('ahx-plist-0-param1', String(0xf2)) },
  { name: 'Command 2 parameter low digit', row: 0, column: 5, nibble: 2, keys: [{ key: 'c', init: { code: 'KeyC' } }], table: setField('ahx-plist-0-param1', String(0x2c)) },
  { name: 'Parameter low digit +', row: 0, column: 4, nibble: 2, keys: [{ key: '+' }], table: setField('ahx-plist-0-param0', String(0x11)) },
  { name: 'Parameter high digit −', row: 0, column: 4, nibble: 1, keys: [{ key: '-' }], table: setField('ahx-plist-0-param0', '0') },
  { name: 'Parameter Shift+numpad + is 16', row: 0, column: 4, nibble: 2, keys: [{ key: '+', init: numpad('+') }], table: setField('ahx-plist-0-param0', String(0x20)) },
  { name: 'Parameter low digit + stops at FF', row: 5, column: 4, nibble: 2, keys: [{ key: '+', init: numpad('+') }, { key: '+', init: numpad('+') }, { key: '+', init: numpad('+') }, { key: '+', init: numpad('+') }, { key: '+', init: numpad('+') }, { key: '+', init: numpad('+') }, { key: '+', init: numpad('+') }, { key: '+', init: numpad('+') }, { key: '+', init: numpad('+') }, { key: '+', init: numpad('+') }, { key: '+', init: numpad('+') }, { key: '+', init: numpad('+') }, { key: '+', init: numpad('+') }, { key: '+', init: numpad('+') }, { key: '+', init: numpad('+') }, { key: '+', init: numpad('+') }], table: setField('ahx-plist-5-param0', '255') },
  { name: 'Command 1 Delete clears digit and parameter', row: 0, column: 4, nibble: 1, keys: [{ key: 'Delete' }], table: seq(setField('ahx-plist-0-fx0', '0'), setField('ahx-plist-0-param0', '0')) },
  { name: 'Command 2 Backspace clears digit and parameter', row: 3, column: 5, nibble: 2, keys: [{ key: 'Backspace' }], table: seq(setField('ahx-plist-3-fx1', '0'), setField('ahx-plist-3-param1', '0')) },
  { name: 'a whole command typed: 5 0 A', row: 2, column: 4, nibble: 0, keys: [{ key: '5' }, { key: '0' }, { key: 'a', init: { code: 'KeyA' } }], table: seq(setField('ahx-plist-2-fx0', '5'), setField('ahx-plist-2-param0', '10')) },
  // Rows
  { name: 'Insert adds a row above (the table’s + on the row before)', row: 2, column: 0, keys: [{ key: 'Insert' }], table: click('ahx-plist-insert-1') },
  { name: 'Ctrl+Delete removes the row (the table’s ×)', row: 2, column: 0, keys: [{ key: 'Delete', init: { ctrlKey: true } }], table: click('ahx-plist-remove-2') },
  { name: 'Ctrl+Backspace removes the last row', row: 5, column: 1, keys: [{ key: 'Backspace', init: { ctrlKey: true } }], table: click('ahx-plist-remove-5') },
];

describe('T12: a canvas edit and the equivalent table edit give the same song', () => {
  let store: ReturnType<typeof useTrackerStore>;
  let w: Wrapper;
  const slot = () => store.instrumentSlots.find((s) => s.slot === 1)!;
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  let base: AhxInstrument;

  beforeEach(async () => {
    setActivePinia(createPinia());
    Element.prototype.scrollIntoView = vi.fn();
    clearAhxEditNotice();
    store = useTrackerStore();
    store.loadSongFile(importAhxToTrackerSong(karma()));
    setCurrentAhxSource(new Uint8Array(karma()));
    base = clone(slot().ahxData!);
    base.plist.entries = BASE_ROWS.map((row) => ({ ...emptyPListEntry(), ...clone(row) }) as AhxInstrument['plist']['entries'][number]);
    expect(store.updateAhxInstrument(1, base)).not.toBe('rejected');
    w = await mountEditor();
    await flush();
  });
  afterEach(() => {
    w.unmount();
    setCurrentAhxSource(null);
    clearAhxEditNotice();
    document.body.innerHTML = '';
  });

  /** The song as an edit leaves it: the slot's instrument and the bytes built from every slot. */
  const outcome = () => ({ instrument: clone(slot().ahxData), bytes: [...store.currentAhxBytes()!] });
  const reset = async () => {
    expect(store.updateAhxInstrument(1, clone(base))).not.toBe('rejected');
    await flush();
  };

  it.each(CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    // The canvas path.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true }));
    await flush();
    w.findComponent(PatternCanvas).vm.$emit('cellSelected', {
      row: c.row,
      column: c.column,
      trackIndex: 0,
      ...(c.nibble === undefined ? {} : { macroNibble: c.nibble }),
    });
    await flush();
    const update = vi.spyOn(store, 'updateAhxInstrument');
    for (const { key, init } of c.keys) {
      el(w, 'ahx-plist-canvas').element.dispatchEvent(
        new KeyboardEvent('keydown', { key, code: init?.code ?? (key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key), bubbles: true, cancelable: true, ...init }),
      );
      await flush();
    }
    // Every stroke is committed through the store's one write, not around it.
    if (c.noop !== true) expect(update).toHaveBeenCalled();
    else expect(update).not.toHaveBeenCalled();
    update.mockRestore();
    const viaCanvas = outcome();

    // The table path, from the same starting point.
    await reset();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true }));
    await flush();
    expect(el(w, 'ahx-plist-canvas').attributes('data-edit')).toBe('false');
    await c.table(w);
    const viaTable = outcome();

    expect(viaCanvas.instrument).toEqual(viaTable.instrument);
    expect(viaCanvas.bytes).toEqual(viaTable.bytes);
    // And the edit did something: the case is not vacuous.
    if (c.noop === true) expect(viaCanvas.instrument).toEqual(base);
    else expect(viaCanvas.instrument).not.toEqual(base);
  });

  it('the cases cover every field the key table writes (note, fixed, tone, both commands’ three digits, rows)', () => {
    const covered = new Set(CASES.map((c) => `${c.column}.${c.nibble ?? 0}`));
    for (const stop of ['0.0', '1.0', '4.0', '4.1', '4.2', '5.0', '5.1', '5.2']) expect(covered.has(stop), stop).toBe(true);
    expect(CASES.length).toBeGreaterThanOrEqual(35);
  });
});
