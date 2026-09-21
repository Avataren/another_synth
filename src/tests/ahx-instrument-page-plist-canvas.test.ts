import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';

vi.mock('src/stores/tracker-playback-store', () => ({
  useTrackerPlaybackStore: () => ({
    previewAhxNoteOn: async () => true,
    previewAhxNoteOff: () => undefined,
  }),
}));
vi.mock('src/components/tracker/pattern-canvas/PatternCanvas.vue', async () => ({
  default: (await import('./helpers/pattern-canvas-stub')).PatternCanvasStub,
}));

import AhxInstrumentPage from 'pages/AhxInstrumentPage.vue';
import PatternCanvas from 'src/components/tracker/pattern-canvas/PatternCanvas.vue';
import { stubLog } from './helpers/pattern-canvas-stub';
import { useTrackerStore } from 'src/stores/tracker-store';
import { importAhxToTrackerSong } from 'src/audio/tracker/ahx-import';
import { setCurrentAhxSource } from 'src/audio/tracker/ahx-source';

/**
 * T6/T7 at the page: the canvas sits above the table, the chip strip is still
 * there, and the selection is one shared thing. The canvas is the recording
 * stand-in (pixels are the browser check).
 */
const karma = (): ArrayBuffer => {
  const b = readFileSync(resolve(__dirname, '../../public/demos/ahx/karma.ahx'));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

async function mountEditor(slot: number) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/ahx/instrument/:slot', name: 'ahx-instrument-display', component: AhxInstrumentPage }, { path: '/tracker', component: { template: '<div/>' } }],
  });
  await router.push(`/ahx/instrument/${slot}`);
  await router.isReady();
  return mount(AhxInstrumentPage, {
    attachTo: document.body,
    global: { plugins: [router], stubs: { QPage: { template: '<div><slot /></div>' }, QIcon: true, QBtn: true } },
  });
}
type Wrapper = Awaited<ReturnType<typeof mountEditor>>;
const el = (w: Wrapper, testid: string) => w.get(`[data-testid="${testid}"]`);

describe('AhxInstrumentPage: the PList canvas (B3)', () => {
  let store: ReturnType<typeof useTrackerStore>;
  const ins = () => store.instrumentSlots.find((s) => s.slot === 1)!.ahxData!;

  beforeEach(() => {
    setActivePinia(createPinia());
    stubLog.trackChanges = 0;
    store = useTrackerStore();
    store.loadSongFile(importAhxToTrackerSong(karma()));
    setCurrentAhxSource(new Uint8Array(karma()));
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('mounts the canvas above the patterns table, and leaves the chip strip where it was', async () => {
    const w = await mountEditor(1);
    const canvas = el(w, 'ahx-plist-canvas').element;
    const table = el(w, 'ahx-plist').element;
    const strip = el(w, 'ahx-plist-strip').element;
    expect(canvas.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(strip.compareDocumentPosition(canvas) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(canvas.getAttribute('data-rows')).toBe(String(ins().plist.entries.length));
    w.unmount();
  });

  it('a canvas click selects the step in the table and the strip', async () => {
    const w = await mountEditor(1);
    w.findComponent(PatternCanvas).vm.$emit('rowSelected', 2);
    await nextTick();
    expect(el(w, 'ahx-plist-row-2').attributes('data-selected')).toBe('true');
    expect(el(w, 'ahx-plist-row-0').attributes('data-selected')).toBe('false');
    expect(el(w, 'ahx-strip-chip-2').attributes('data-selected')).toBe('true');
    expect(el(w, 'ahx-plist-canvas').attributes('data-selected-row')).toBe('2');
    w.unmount();
  });

  it('a strip click and a focus in a table row select the step on the canvas', async () => {
    const w = await mountEditor(1);
    await el(w, 'ahx-strip-chip-1').trigger('click');
    expect(el(w, 'ahx-plist-canvas').attributes('data-selected-row')).toBe('1');
    expect(w.findComponent(PatternCanvas).props('selectionRect')).toEqual({ rowStart: 1, rowEnd: 1, trackStart: 0, trackEnd: 0 });
    await el(w, 'ahx-plist-row-2').trigger('focusin');
    expect(el(w, 'ahx-plist-canvas').attributes('data-selected-row')).toBe('2');
    expect(el(w, 'ahx-plist-row-2').attributes('data-selected')).toBe('true');
    w.unmount();
  });

  it('clears the canvas selection when its row is removed, like the table', async () => {
    const w = await mountEditor(1);
    const last = ins().plist.entries.length - 1;
    w.findComponent(PatternCanvas).vm.$emit('rowSelected', last);
    await nextTick();
    await el(w, `ahx-plist-remove-${last}`).trigger('click');
    expect(el(w, 'ahx-plist-canvas').attributes('data-selected-row')).toBe('-1');
    expect(el(w, 'ahx-plist-canvas').attributes('data-rows')).toBe(String(last));
    w.unmount();
  });

  it('a table edit repaints once; an edit that leaves the PList alone does not repaint at all', async () => {
    const w = await mountEditor(1);
    await nextTick();
    const before = stubLog.trackChanges;
    // Envelope, volume and PList speed: none of them is on the canvas.
    await el(w, 'ahx-env-aFrames').setValue('7');
    await el(w, 'ahx-field-volume').setValue('33');
    await el(w, 'ahx-plist-speed-inc').trigger('click');
    expect(stubLog.trackChanges).toBe(before);
    // A step's note is.
    const beforeNote = ins().plist.entries[0]!.note;
    await el(w, 'ahx-plist-0-note').setValue(String(beforeNote === 9 ? 10 : 9));
    expect(stubLog.trackChanges).toBe(before + 1);
    w.unmount();
  });

  it('shows the empty state for an instrument whose PList has no rows, with the table as before', async () => {
    const w = await mountEditor(1);
    while (ins().plist.entries.length > 0) await el(w, 'ahx-plist-remove-0').trigger('click');
    expect(w.find('[data-testid="ahx-plist-canvas-empty"]').exists()).toBe(true);
    expect(w.findComponent(PatternCanvas).exists()).toBe(false);
    expect(w.text()).toContain('This instrument has no PList. Add a row to give it one.');
    await el(w, 'ahx-plist-add').trigger('click');
    expect(w.findComponent(PatternCanvas).exists()).toBe(true);
    w.unmount();
  });
});
