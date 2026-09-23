import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { nextTick } from 'vue';

const preview = vi.hoisted(() => ({ on: [] as Array<[number, number]>, off: 0 }));
vi.mock('src/stores/tracker-playback-store', () => ({
  useTrackerPlaybackStore: () => ({
    previewSidNoteOn: async (instrument: number, midi: number) => {
      preview.on.push([instrument, midi]);
      return true;
    },
    previewSidNoteOff: () => {
      preview.off += 1;
    },
    sidPreviewOutput: () => null,
    onSidPreviewOutput: () => () => undefined,
  }),
}));

import SidInstrumentPage from 'pages/SidInstrumentPage.vue';
import AhxSliderField from 'src/components/ahx/AhxSliderField.vue';
import AhxNumberField from 'src/components/ahx/AhxNumberField.vue';
import AhxSegmented from 'src/components/ahx/AhxSegmented.vue';
import AhxPianoStrip from 'src/components/ahx/AhxPianoStrip.vue';
import { useTrackerStore } from 'src/stores/tracker-store';
import { decodeSidFile, encodeSidFile, serializeSidFile, type SidDoc } from 'src/audio/tracker/sid-doc';
import { canEditSlot, resolveInstrumentEditorRoute } from 'src/audio/tracker/instrument-types';
import { ahxSlotRedirect } from 'src/router/ahx-slot-guard';
import { clearAhxEditNotice } from 'src/audio/tracker/ahx-edit-notice';
import { buildSidChainSong } from './helpers/sid-chain-song';

/**
 * plan-sid-tracking.md S4: the SID instrument page, mounted on a real tracker
 * store holding S3's chain song. Every edit is made through the page's own
 * controls and must land in the song's doc (with an undo step), show in the
 * slot list (the doc names the slots), and survive doc -> file -> doc.
 */

async function mountEditor(slot: number) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/sid/instrument/:slot', name: 'sid-instrument-editor', component: SidInstrumentPage },
      { path: '/tracker', component: { template: '<div/>' } },
    ],
  });
  await router.push(`/sid/instrument/${slot}`);
  await router.isReady();
  const w = mount(SidInstrumentPage, {
    global: {
      plugins: [router],
      stubs: {
        QPage: { template: '<div><slot /></div>' },
        QIcon: true,
        QBtn: { inheritAttrs: false, props: ['label', 'disable'], emits: ['click'], template: '<button v-bind="$attrs" :disabled="disable" @click="$emit(\'click\')">{{ label }}</button>' },
        OscilloscopeComponent: true,
        FrequencyAnalyzerComponent: true,
      },
    },
  });
  return { w, router };
}

/** The field component whose `testid` prop is `testid` (its `vm` emits what a user edit emits). */
function field(w: VueWrapper, component: typeof AhxSliderField | typeof AhxNumberField | typeof AhxSegmented, testid: string): VueWrapper {
  const found = (w.findAllComponents(component as never) as VueWrapper[]).find((c) => (c.props() as { testid?: string }).testid === testid);
  if (!found) throw new Error(`no field ${testid}`);
  return found;
}

const sid = () => useTrackerStore().sidDoc as SidDoc;

describe('SidInstrumentPage', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    clearAhxEditNotice();
    preview.on.length = 0;
    preview.off = 0;
    useTrackerStore().adoptSidDoc(buildSidChainSong());
  });

  it('a SID slot opens it: routing, the legacy patch path redirect', () => {
    const slot = useTrackerStore().instrumentSlots[0]!;
    expect(slot.instrumentFormat).toBe('sid');
    expect(canEditSlot(slot)).toBe(true);
    expect(resolveInstrumentEditorRoute(slot)).toBe('sid-instrument-editor');
    expect(ahxSlotRedirect(1)).toEqual({ name: 'sid-instrument-editor', params: { slot: 1 } });
    // A slot the doc has no instrument for is not a SID slot.
    expect(useTrackerStore().instrumentSlots[9]!.instrumentFormat).toBeUndefined();
  });

  it('shows the instrument, the chip model and every drawing', async () => {
    const { w } = await mountEditor(3);
    expect(w.get('[data-testid="sid-instrument-name"]').text()).toBe('Filt saw');
    expect(w.get('[data-testid="sid-chip-model"]').text()).toBe('MOS 6581');
    for (const id of ['sid-wave-shape', 'sid-envelope-curve', 'sid-pulse-lane', 'sid-filter-response', 'sid-cutoff-lane', 'sid-pitch-lane']) {
      expect(w.get(`[data-testid="${id}"] path`).attributes('d'), id).toMatch(/^M0,/);
    }
    expect((w.get('[data-testid="sid-bit-saw"]').element as HTMLInputElement).checked).toBe(true);
    expect((w.get('[data-testid="sid-filter-enabled"]').element as HTMLInputElement).checked).toBe(true);
    // Filt saw starts on filter table row 1: rows 1-4 (a stop at row 4) are marked as its own.
    expect(w.findAll('[data-testid="sid-table-filter"] .sid-table__mine')).toHaveLength(4);
  });

  it('edits land in the doc with an undo step and show in the slot list', async () => {
    const { w } = await mountEditor(1);
    const store = useTrackerStore();
    const before = sid();
    const name = w.get('[data-testid="sid-field-name"]');
    (name.element as HTMLInputElement).value = 'Lead';
    await name.trigger('change');
    expect(sid().instruments[0]!.name).toBe('Lead');
    expect(store.instrumentSlots[0]!.instrumentName).toBe('Lead');
    expect(store.undoStack).toHaveLength(1);

    field(w, AhxSliderField, 'sid-field-attack').vm.$emit('update:modelValue', 7);
    field(w, AhxSliderField, 'sid-field-cutoff').vm.$emit('update:modelValue', 0x400);
    field(w, AhxNumberField, 'sid-field-pulsePtr').vm.$emit('update:modelValue', 1);
    await w.get('[data-testid="sid-bit-pulse"]').trigger('change');
    await w.get('[data-testid="sid-filter-HP"]').trigger('change');
    await w.get('[data-testid="sid-hard-restart"]').trigger('change');
    const ins = sid().instruments[0]!;
    expect(ins).toMatchObject({ attack: 7, pulsePtr: 1, waveform: 0x50, hardRestart: true });
    expect(ins.filter).toMatchObject({ cutoff: 0x400, mode: 4 });
    // The other instruments are the old doc's, untouched.
    expect(sid().instruments[1]).toBe(before.instruments[1]);
    expect(store.undoStack).toHaveLength(7);
    for (let i = 0; i < 7; i++) store.undo();
    expect(sid()).toBe(before);
  });

  it('the chip model is the song\'s, switched from here', async () => {
    const { w } = await mountEditor(1);
    field(w, AhxSegmented, 'sid-seg-chip').vm.$emit('update:modelValue', 0);
    expect(sid().chipModel).toBe('8580');
    await nextTick();
    expect(w.get('[data-testid="sid-chip-model"]').text()).toBe('MOS 8580');
  });

  it('table bytes and rows are edited as hex; a bad byte is refused and shown back', async () => {
    const { w } = await mountEditor(2);
    const cell = w.get('[data-testid="sid-pulse-2-right"]');
    (cell.element as HTMLInputElement).value = '3a';
    await cell.trigger('change');
    expect(sid().tables.pulse[1]).toEqual({ left: 0x20, right: 0x3a });
    const rows = sid().tables.speed.length;
    await w.get('[data-testid="sid-speed-add"]').trigger('click');
    expect(sid().tables.speed).toHaveLength(rows + 1);
    const before = sid();
    (cell.element as HTMLInputElement).value = 'zz';
    await cell.trigger('change');
    expect(sid()).toBe(before);
    expect((cell.element as HTMLInputElement).value).toBe('3A');
  });

  it('a new instrument is added to the song and opened', async () => {
    const { w, router } = await mountEditor(1);
    await w.get('[data-testid="sid-new-instrument"]').trigger('click');
    await nextTick();
    expect(sid().instruments).toHaveLength(5);
    expect(useTrackerStore().instrumentSlots[4]!.instrumentFormat).toBe('sid');
    await vi.waitFor(() => expect(router.currentRoute.value.params.slot).toBe('5'));
  });

  it('the keys sound this instrument on the preview voice', async () => {
    const { w } = await mountEditor(4);
    const piano = w.findComponent(AhxPianoStrip);
    piano.vm.$emit('down', 57);
    piano.vm.$emit('up', 57);
    expect(preview.on).toEqual([[4, 57]]);
    expect(preview.off).toBe(1);
  });

  it('page edits survive doc -> file -> doc; an unedited song still round-trips byte-exact', async () => {
    const original = buildSidChainSong();
    expect(Array.from(serializeSidFile(sid()))).toEqual(Array.from(serializeSidFile(original)));
    const { w } = await mountEditor(4);
    field(w, AhxNumberField, 'sid-field-gateTimer').vm.$emit('update:modelValue', 5);
    field(w, AhxSliderField, 'sid-field-resonance').vm.$emit('update:modelValue', 9);
    const edited = sid();
    const back = decodeSidFile(encodeSidFile(edited));
    if (!back.ok) throw new Error(back.reason);
    expect(back.doc).toEqual(edited);
    expect(back.doc.instruments[3]).toMatchObject({ gateTimer: 5, filter: { resonance: 9 } });
    // Through the store's own save and load.
    const file = useTrackerStore().serializeSong();
    setActivePinia(createPinia());
    const other = useTrackerStore();
    other.loadSongFile(JSON.parse(JSON.stringify(file)));
    expect(other.sidDoc).toEqual(edited);
    expect(other.instrumentSlots[3]!.instrumentName).toBe('Vib lead');
  });

  it('with no SID song it says so', async () => {
    useTrackerStore().resetToNewSong();
    const { w } = await mountEditor(1);
    expect(w.find('[data-testid="sid-instrument-missing"]').exists()).toBe(true);
  });
});
