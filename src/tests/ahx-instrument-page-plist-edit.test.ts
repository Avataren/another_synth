import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { AhxInstrument } from '@another-synth/tracker-playback';

const playback = vi.hoisted(() => ({ noteOn: vi.fn(async () => true), noteOff: vi.fn() }));
vi.mock('src/stores/tracker-playback-store', () => ({
  useTrackerPlaybackStore: () => ({ previewAhxNoteOn: playback.noteOn, previewAhxNoteOff: playback.noteOff, setAhxPreviewScopeEnabled: () => undefined, getAhxPreviewWaveform: () => null }),
}));
vi.mock('src/components/tracker/pattern-canvas/PatternCanvas.vue', async () => ({
  default: (await import('./helpers/pattern-canvas-stub')).PatternCanvasStub,
}));

import AhxInstrumentPage from 'pages/AhxInstrumentPage.vue';
import PatternCanvas from 'src/components/tracker/pattern-canvas/PatternCanvas.vue';
import { useTrackerStore } from 'src/stores/tracker-store';
import { importAhxToTrackerSong } from 'src/audio/tracker/ahx-import';
import { setCurrentAhxSource } from 'src/audio/tracker/ahx-source';
import { ahxEditNotice, clearAhxEditNotice } from 'src/audio/tracker/ahx-edit-notice';
import { rowPitchPx } from 'src/components/tracker/pattern-canvas/pattern-layout';
import { emptyPListEntry } from 'src/audio/tracker/ahx-instrument-edit';
import { nearFullSong, corpusBytes } from './helpers/ahx-near-full';

/**
 * T13: the PList canvas's Edit mode at the page (batch B6): the toggle and F2,
 * the keyboard piano suspended exactly while it is on, Escape leaving the mode
 * before the page, an edit committed through the store once per keystroke and
 * once per gesture on the undo stack, the size guard's refusal on screen.
 */
const karma = (): ArrayBuffer => {
  const b = readFileSync(resolve(__dirname, '../../public/demos/ahx/karma.ahx'));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

async function mountEditor(slot: number) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/ahx/instrument/:slot', name: 'ahx-instrument-display', component: AhxInstrumentPage },
      { path: '/tracker', component: { template: '<div/>' } },
    ],
  });
  await router.push(`/ahx/instrument/${slot}`);
  await router.isReady();
  const w = mount(AhxInstrumentPage, {
    attachTo: document.body,
    global: { plugins: [router], stubs: { QPage: { template: '<div><slot /></div>' }, QIcon: true, QBtn: true } },
  });
  return { w, router };
}
type Mounted = Awaited<ReturnType<typeof mountEditor>>;
type Wrapper = Mounted['w'];
const el = (w: Wrapper, testid: string) => w.get(`[data-testid="${testid}"]`);
const has = (w: Wrapper, testid: string) => w.find(`[data-testid="${testid}"]`).exists();
const canvasRoot = (w: Wrapper) => el(w, 'ahx-plist-canvas');
const stub = (w: Wrapper) => w.findComponent(PatternCanvas);
const flush = async () => {
  await nextTick();
  await nextTick();
};

/** A key at the window, as the browser delivers it to the page's own listeners. */
function windowKey(type: 'keydown' | 'keyup', key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent(type, { key, code: init.code ?? key, bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(event);
  return event;
}
/** A key at the canvas (where focus is while editing). */
function canvasKey(w: Wrapper, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, code: init.code ?? (key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key), bubbles: true, cancelable: true, ...init });
  canvasRoot(w).element.dispatchEvent(event);
  return event;
}
async function clickCell(w: Wrapper, row: number, column: number, macroNibble?: number) {
  stub(w).vm.$emit('cellSelected', { row, column, trackIndex: 0, ...(macroNibble === undefined ? {} : { macroNibble }) });
  await flush();
}

describe('AhxInstrumentPage: editing the PList from the canvas (B6)', () => {
  let store: ReturnType<typeof useTrackerStore>;
  const ins = (): AhxInstrument => store.instrumentSlots.find((s) => s.slot === 1)!.ahxData!;
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    setActivePinia(createPinia());
    Element.prototype.scrollIntoView = scrollIntoView;
    playback.noteOn.mockClear();
    playback.noteOff.mockClear();
    clearAhxEditNotice();
    store = useTrackerStore();
    store.loadSongFile(importAhxToTrackerSong(karma()));
    setCurrentAhxSource(new Uint8Array(karma()));
    expect(store.isAhxEditable).toBe(true);
    expect(ins().plist.entries.length).toBeGreaterThanOrEqual(3);
  });
  afterEach(() => {
    setCurrentAhxSource(null);
    clearAhxEditNotice();
    document.body.innerHTML = '';
  });

  describe('the toggle and F2', () => {
    it('is off on load: the toggle says how to turn it on, no cursor, no hint', async () => {
      const { w } = await mountEditor(1);
      const toggle = el(w, 'ahx-plist-edit-toggle');
      expect(toggle.text()).toBe('Edit steps (F2)');
      expect(toggle.attributes('aria-pressed')).toBe('false');
      expect(canvasRoot(w).attributes('data-edit')).toBe('false');
      expect(has(w, 'ahx-plist-edit-hint')).toBe(false);
      expect((stub(w).props() as unknown as { activeTrack: number }).activeTrack).toBe(-1);
      w.unmount();
    });

    it('the toggle and F2 flip the mode; the label says the piano is off; the canvas takes the keyboard and row 0 is selected', async () => {
      const { w } = await mountEditor(1);
      await el(w, 'ahx-plist-edit-toggle').trigger('click');
      await flush();
      expect(canvasRoot(w).attributes('data-edit')).toBe('true');
      expect(el(w, 'ahx-plist-edit-toggle').attributes('aria-pressed')).toBe('true');
      expect(el(w, 'ahx-plist-edit-toggle').text()).toBe('Edit steps: on (keyboard piano off)');
      expect(has(w, 'ahx-plist-edit-hint')).toBe(true);
      expect(document.activeElement).toBe(canvasRoot(w).element);
      expect(canvasRoot(w).attributes('data-cursor-row')).toBe('0');
      expect(el(w, 'ahx-plist-row-0').attributes('data-selected')).toBe('true');

      expect(windowKey('keydown', 'F2').defaultPrevented).toBe(true);
      await flush();
      expect(canvasRoot(w).attributes('data-edit')).toBe('false');
      windowKey('keydown', 'F2');
      await flush();
      expect(canvasRoot(w).attributes('data-edit')).toBe('true');
      w.unmount();
    });

    it('F2 is not taken while a table field is being typed in, or with a modifier', async () => {
      const { w } = await mountEditor(1);
      const field = el(w, 'ahx-plist-0-note').element as HTMLInputElement;
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true }));
      windowKey('keydown', 'F2', { ctrlKey: true });
      windowKey('keydown', 'F2', { shiftKey: true });
      await flush();
      expect(canvasRoot(w).attributes('data-edit')).toBe('false');
      w.unmount();
    });

    it('is off again after a slot change, and on a fresh mount', async () => {
      const { w, router } = await mountEditor(1);
      windowKey('keydown', 'F2');
      await flush();
      expect(canvasRoot(w).attributes('data-edit')).toBe('true');
      await router.push('/ahx/instrument/2');
      await flush();
      expect(canvasRoot(w).attributes('data-edit')).toBe('false');
      expect(has(w, 'ahx-plist-edit-hint')).toBe(false);
      w.unmount();
      const again = await mountEditor(1);
      expect(canvasRoot(again.w).attributes('data-edit')).toBe('false');
      again.w.unmount();
    });

    it('is off when the last row goes', async () => {
      const { w } = await mountEditor(1);
      windowKey('keydown', 'F2');
      await flush();
      while (ins().plist.entries.length > 0) await el(w, 'ahx-plist-remove-0').trigger('click');
      await flush();
      expect(el(w, 'ahx-plist-edit-toggle').attributes('aria-pressed')).toBe('false');
      expect(el(w, 'ahx-plist-edit-toggle').attributes('disabled')).toBeDefined();
      w.unmount();
    });
  });

  describe('the keyboard piano: suspended exactly while Edit is on', () => {
    it('KeyQ sounds with Edit off, not with it on, and again after it is turned off (E-10 as a unit test)', async () => {
      const { w } = await mountEditor(1);
      windowKey('keydown', 'q', { code: 'KeyQ' });
      windowKey('keyup', 'q', { code: 'KeyQ' });
      expect(playback.noteOn).toHaveBeenCalledTimes(1);
      playback.noteOn.mockClear();

      windowKey('keydown', 'F2');
      await flush();
      const q = windowKey('keydown', 'q', { code: 'KeyQ' });
      windowKey('keyup', 'q', { code: 'KeyQ' });
      expect(playback.noteOn).not.toHaveBeenCalled();
      expect(q.defaultPrevented).toBe(false);

      windowKey('keydown', 'F2');
      await flush();
      windowKey('keydown', 'q', { code: 'KeyQ' });
      expect(playback.noteOn).toHaveBeenCalledTimes(1);
      windowKey('keyup', 'q', { code: 'KeyQ' });
      w.unmount();
    });

    it('the on-screen keys still sound while Edit is on', async () => {
      const { w } = await mountEditor(1);
      windowKey('keydown', 'F2');
      await flush();
      await el(w, 'ahx-audition-60').trigger('pointerdown');
      expect(playback.noteOn).toHaveBeenCalledTimes(1);
      expect(playback.noteOn).toHaveBeenCalledWith(1, 60, expect.any(Number));
      await el(w, 'ahx-audition-60').trigger('pointerup');
      expect(playback.noteOff).toHaveBeenCalledWith(60);
      w.unmount();
    });

    it('a note the keyboard holds when Edit begins is let go of, and the key-up that follows is harmless', async () => {
      const { w } = await mountEditor(1);
      windowKey('keydown', 'q', { code: 'KeyQ' });
      expect(playback.noteOn).toHaveBeenCalledTimes(1);
      windowKey('keydown', 'F2');
      await flush();
      expect(playback.noteOff).toHaveBeenCalledWith(60);
      playback.noteOff.mockClear();
      windowKey('keyup', 'q', { code: 'KeyQ' });
      expect(playback.noteOff).not.toHaveBeenCalled();
      w.unmount();
    });
  });

  describe('Escape', () => {
    it('leaves the mode first; only the second Escape leaves the page (E-13 as a unit test)', async () => {
      const { w, router } = await mountEditor(1);
      windowKey('keydown', 'F2');
      await flush();
      windowKey('keydown', 'Escape');
      await flush();
      expect(canvasRoot(w).attributes('data-edit')).toBe('false');
      expect(router.currentRoute.value.path).toBe('/ahx/instrument/1');
      windowKey('keydown', 'Escape');
      await flush();
      await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/tracker'));
      w.unmount();
    });

    it('with the row menu open it closes the menu, not the mode, not the page', async () => {
      const { w, router } = await mountEditor(1);
      windowKey('keydown', 'F2');
      await flush();
      const stage = w.get('.plist-canvas__stage').element;
      const cv = document.createElement('canvas');
      stage.appendChild(cv);
      cv.getBoundingClientRect = () => ({ top: 0, left: 0, right: 300, bottom: 400, width: 300, height: 400, x: 0, y: 0, toJSON: () => ({}) });
      cv.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: rowPitchPx + 4 }));
      await flush();
      expect(has(w, 'ahx-plist-canvas-menu')).toBe(true);
      windowKey('keydown', 'Escape');
      await flush();
      expect(has(w, 'ahx-plist-canvas-menu')).toBe(false);
      expect(canvasRoot(w).attributes('data-edit')).toBe('true');
      expect(router.currentRoute.value.path).toBe('/ahx/instrument/1');
      w.unmount();
    });
  });

  describe('a typed edit', () => {
    it('writes through the store once per keystroke, is one undo step for the run, and the cursor goes on', async () => {
      const { w } = await mountEditor(1);
      const update = vi.spyOn(store, 'updateAhxInstrument');
      windowKey('keydown', 'F2');
      await flush();
      await clickCell(w, 0, 4, 0);
      expect(canvasRoot(w).attributes('data-cursor-column')).toBe('4');
      const steps = store.undoStack.length;

      for (const digit of ['5', '0', 'a']) {
        canvasKey(w, digit);
        await flush();
      }
      expect(update).toHaveBeenCalledTimes(3);
      expect(ins().plist.entries[0]!.fx[0]).toBe(5);
      expect(ins().plist.entries[0]!.fxParam[0]).toBe(0x0a);
      expect(store.undoStack.length).toBe(steps + 1);
      // The run is done: the cursor is on the first digit of the next row.
      expect(canvasRoot(w).attributes('data-cursor-row')).toBe('1');
      expect(canvasRoot(w).attributes('data-cursor-nibble')).toBe('0');
      // The table and the canvas are the same data.
      expect((el(w, 'ahx-plist-0-fx0').element as HTMLSelectElement).value).toBe('5');
      expect((el(w, 'ahx-plist-0-param0').element as HTMLInputElement).value).toBe('10');
      // The next stroke is a new step.
      canvasKey(w, '3');
      await flush();
      expect(store.undoStack.length).toBe(steps + 2);
      w.unmount();
    });

    it('a moved cursor ends the step: typing, moving away, typing back is two steps', async () => {
      const { w } = await mountEditor(1);
      windowKey('keydown', 'F2');
      await flush();
      await clickCell(w, 0, 4, 1);
      const steps = store.undoStack.length;
      canvasKey(w, '2');
      await flush();
      canvasKey(w, 'ArrowDown');
      await flush();
      canvasKey(w, 'ArrowUp');
      await flush();
      canvasKey(w, '3');
      await flush();
      expect(store.undoStack.length).toBe(steps + 2);
      w.unmount();
    });

    it('a refused key changes nothing, leaves no step, moves no cursor, and says why', async () => {
      const { w } = await mountEditor(1);
      windowKey('keydown', 'F2');
      await flush();
      await clickCell(w, 0, 4, 0);
      const before = JSON.stringify(ins());
      const steps = store.undoStack.length;
      canvasKey(w, '9'); // command 9 is not an AHX command
      await flush();
      expect(JSON.stringify(ins())).toBe(before);
      expect(store.undoStack.length).toBe(steps);
      expect(canvasRoot(w).attributes('data-cursor-nibble')).toBe('0');
      expect(el(w, 'ahx-edit-notice').text()).toBe('Command 9 is not available in an AHX PList.');
      // The next good edit clears the words.
      canvasKey(w, ins().plist.entries[0]!.fx[0] === 1 ? '2' : '1');
      await flush();
      expect(has(w, 'ahx-edit-notice')).toBe(false);
      w.unmount();
    });

    it('Ctrl+Z at the canvas is the song’s undo', async () => {
      const { w } = await mountEditor(1);
      windowKey('keydown', 'F2');
      await flush();
      await clickCell(w, 0, 4, 0);
      const original = JSON.stringify(ins());
      canvasKey(w, ins().plist.entries[0]!.fx[0] === 1 ? '2' : '1');
      await flush();
      expect(JSON.stringify(ins())).not.toBe(original);
      canvasKey(w, 'z', { ctrlKey: true });
      await flush();
      expect(JSON.stringify(ins())).toBe(original);
      w.unmount();
    });

    it('inserting or removing a row under a Jump says so, and a row the list has is what the cursor lands on', async () => {
      const { w } = await mountEditor(1);
      const withJump = JSON.parse(JSON.stringify(ins())) as AhxInstrument;
      withJump.plist.entries = [emptyPListEntry(), emptyPListEntry(), { ...emptyPListEntry(), fx: [5, 0], fxParam: [2, 0] }, emptyPListEntry()];
      store.updateAhxInstrument(1, withJump);
      await flush();
      windowKey('keydown', 'F2');
      await flush();
      await clickCell(w, 0, 0);
      canvasKey(w, 'Insert');
      await flush();
      expect(ins().plist.entries).toHaveLength(5);
      expect(el(w, 'ahx-edit-notice').text()).toBe('Rows after 00 moved; 1 Jump command (5xx) still points at its old row number.');
      w.unmount();
    });
  });

  describe('the size guard', () => {
    it('a refused insert shows the words on the page, leaves ahxData and the undo stack alone, and the export is unharmed (E-14 as a unit test)', async () => {
      const { doc, slots } = nearFullSong('karma.ahx', 0);
      slots.forEach((slot, i) => {
        const target = store.instrumentSlots[i];
        if (target?.ahxData !== undefined) target.ahxData = JSON.parse(JSON.stringify(slot.ahxData)) as AhxInstrument;
      });
      store.ahxDoc = doc;
      const { w } = await mountEditor(1);
      windowKey('keydown', 'F2');
      await flush();
      await clickCell(w, 0, 0);
      const before = JSON.stringify(ins());
      const steps = store.undoStack.length;
      canvasKey(w, 'Insert');
      await flush();
      expect(JSON.stringify(ins())).toBe(before);
      expect(store.undoStack.length).toBe(steps);
      expect(el(w, 'ahx-edit-notice').text()).toMatch(/^Song is [\d,]+ of 65,535 bytes; a PList row needs 4\.$/);
      // The table's Add row is refused the same way.
      const message = el(w, 'ahx-edit-notice').text();
      clearAhxEditNotice();
      await flush();
      await el(w, 'ahx-plist-add').trigger('click');
      await flush();
      expect(JSON.stringify(ins())).toBe(before);
      expect(el(w, 'ahx-edit-notice').text()).toBe(message);
      // The menu says it before it is picked.
      const stage = w.get('.plist-canvas__stage').element;
      const cv = document.createElement('canvas');
      stage.appendChild(cv);
      cv.getBoundingClientRect = () => ({ top: 0, left: 0, right: 300, bottom: 400, width: 300, height: 400, x: 0, y: 0, toJSON: () => ({}) });
      cv.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 4 }));
      await flush();
      const above = el(w, 'ahx-plist-canvas-menu-insert-above');
      expect(above.attributes('disabled')).toBeDefined();
      expect(above.attributes('title')).toBe(message);
      expect(el(w, 'ahx-plist-canvas-menu-clear').attributes('disabled')).toBeUndefined();
      expect(store.currentAhxBytes()).not.toBeNull();
      w.unmount();
      expect(corpusBytes('karma.ahx').length).toBeGreaterThan(0);
    });
  });

  describe('the table’s + and × are the same ops', () => {
    it('each click is its own undo step and writes through the store', async () => {
      const { w } = await mountEditor(1);
      const rows = ins().plist.entries.length;
      const steps = store.undoStack.length;
      await el(w, 'ahx-plist-insert-0').trigger('click');
      expect(ins().plist.entries).toHaveLength(rows + 1);
      expect(ins().plist.entries[1]).toEqual(emptyPListEntry());
      expect(store.undoStack.length).toBe(steps + 1);
      await el(w, 'ahx-plist-remove-1').trigger('click');
      expect(ins().plist.entries).toHaveLength(rows);
      expect(store.undoStack.length).toBe(steps + 2);
      await el(w, 'ahx-plist-add').trigger('click');
      expect(ins().plist.entries).toHaveLength(rows + 1);
      expect(ins().plist.entries.at(-1)).toEqual(emptyPListEntry());
      expect(store.undoStack.length).toBe(steps + 3);
      w.unmount();
    });

    it('a removed row that leaves Jumps behind gets the same notice as the canvas’s', async () => {
      const { w } = await mountEditor(1);
      const withJump = JSON.parse(JSON.stringify(ins())) as AhxInstrument;
      withJump.plist.entries = [emptyPListEntry(), { ...emptyPListEntry(), fx: [5, 0], fxParam: [2, 0] }, emptyPListEntry(), emptyPListEntry()];
      store.updateAhxInstrument(1, withJump);
      await flush();
      await el(w, 'ahx-plist-remove-0').trigger('click');
      expect(el(w, 'ahx-edit-notice').text()).toBe('Rows after 00 moved; 1 Jump command (5xx) still points at its old row number.');
      w.unmount();
    });
  });

  describe('the mouse at the page', () => {
    it('a double-click on a command cell focuses its table field (E-15 as a unit test)', async () => {
      const { w } = await mountEditor(1);
      await clickCell(w, 2, 4, 1);
      w.get('.plist-canvas__stage').element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await flush();
      expect((document.activeElement as HTMLElement | null)?.getAttribute('data-testid')).toBe('ahx-plist-2-param0');
      // A select has no text to select: the tone and a command's digit are focused all the same.
      await clickCell(w, 1, 1);
      w.get('.plist-canvas__stage').element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await flush();
      expect((document.activeElement as HTMLElement | null)?.getAttribute('data-testid')).toBe('ahx-plist-1-waveform');
      w.unmount();
    });
  });

  describe('a song that cannot be edited from here', () => {
    it('offers no Edit toggle and says where editing is, F2 does nothing, no row menu', async () => {
      store.ahxDoc = null;
      expect(store.isAhxEditable).toBe(false);
      const { w } = await mountEditor(1);
      expect(has(w, 'ahx-plist-edit-toggle')).toBe(false);
      expect(el(w, 'ahx-plist-edit-unavailable').text()).toContain('Canvas editing needs an editable AHX song');
      windowKey('keydown', 'F2');
      await flush();
      expect(canvasRoot(w).attributes('data-edit')).toBe('false');
      // The keyboard piano is untouched.
      windowKey('keydown', 'q', { code: 'KeyQ' });
      expect(playback.noteOn).toHaveBeenCalledTimes(1);
      windowKey('keyup', 'q', { code: 'KeyQ' });
      w.unmount();
    });

    it('the table still edits (it did before), with no undo step to record', async () => {
      store.ahxDoc = null;
      const { w } = await mountEditor(1);
      const rows = ins().plist.entries.length;
      const steps = store.undoStack.length;
      await el(w, 'ahx-plist-insert-0').trigger('click');
      expect(ins().plist.entries).toHaveLength(rows + 1);
      expect(store.undoStack.length).toBe(steps);
      w.unmount();
    });
  });

  it('after an edit the notice shown is the shared one, on the page, and it clears itself', async () => {
    const { w } = await mountEditor(1);
    windowKey('keydown', 'F2');
    await flush();
    await clickCell(w, 0, 4, 0);
    canvasKey(w, 'q'); // not a hex digit
    await flush();
    expect(ahxEditNotice.value?.message).toBe('Q is not a hex digit (0 to 9, A to F).');
    expect(el(w, 'ahx-edit-notice').attributes('role')).toBe('status');
    clearAhxEditNotice();
    await flush();
    expect(has(w, 'ahx-edit-notice')).toBe(false);
    w.unmount();
  });
});
