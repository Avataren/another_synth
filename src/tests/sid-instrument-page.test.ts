import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { nextTick } from 'vue';

const preview = vi.hoisted(() => ({ on: [] as Array<[number, number]>, off: 0, offKeys: [] as Array<number | undefined>, prepared: 0 }));
vi.mock('src/stores/tracker-playback-store', () => ({
  useTrackerPlaybackStore: () => ({
    previewSidNoteOn: async (instrument: number, midi: number) => {
      preview.on.push([instrument, midi]);
      return true;
    },
    previewSidNoteOff: (midi?: number) => {
      preview.off += 1;
      preview.offKeys.push(midi);
    },
    prepareSidPreview: async () => {
      preview.prepared += 1;
    },
    getSidPreviewFullScale: () => 0.17,
    sidPreviewOutput: () => null,
    onSidPreviewOutput: () => () => undefined,
  }),
}));

import SidInstrumentPage from 'pages/SidInstrumentPage.vue';
import AhxSliderField from 'src/components/ahx/AhxSliderField.vue';
import AhxNumberField from 'src/components/ahx/AhxNumberField.vue';
import AhxSegmented from 'src/components/ahx/AhxSegmented.vue';
import AhxPianoStrip from 'src/components/ahx/AhxPianoStrip.vue';
import AhxAuditionBar from 'src/components/ahx/AhxAuditionBar.vue';
import TrackWaveform from 'src/components/tracker/TrackWaveform.vue';
import { useTrackerStore } from 'src/stores/tracker-store';
import { decodeSidFile, encodeSidFile, serializeSidFile, setSidInstrument, type SidDoc } from 'src/audio/tracker/sid-doc';
import { canEditSlot, resolveInstrumentEditorRoute } from 'src/audio/tracker/instrument-types';
import { ahxSlotRedirect } from 'src/router/ahx-slot-guard';
import { clearAhxEditNotice } from 'src/audio/tracker/ahx-edit-notice';
import { buildSidChainSong } from './helpers/sid-chain-song';
import PatchPicker from 'src/components/PatchPicker.vue';
import { SID_PRESETS } from 'src/audio/tracker/sid-presets';

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

/** Types `text` into the input with `testid` and commits it, as leaving the field does. */
async function typeInto(w: VueWrapper, testid: string, text: string): Promise<HTMLInputElement> {
  const input = w.get(`[data-testid="${testid}"]`);
  (input.element as HTMLInputElement).value = text;
  await input.trigger('change');
  return input.element as HTMLInputElement;
}

/** Moves the page's frame cursor. */
async function setFrame(w: VueWrapper, frame: number): Promise<void> {
  const range = w.get('[data-testid="sid-frame-cursor"]');
  (range.element as HTMLInputElement).value = String(frame);
  await range.trigger('input');
}

const checked = (w: VueWrapper, testid: string): boolean => (w.get(`[data-testid="${testid}"]`).element as HTMLInputElement).checked;

/** The chain song with instrument 2 on GoatTracker's usual first frame, $09 (test and gate); its wave table sets the rest. */
function gtStyleChainSong(): SidDoc {
  const doc = buildSidChainSong();
  const result = setSidInstrument(doc, 2, { ...doc.instruments[1]!, firstWave: 0x09 });
  if (!result.ok) throw new Error(result.reason);
  return result.doc;
}

// Each page listens on `window` for the computer keyboard: one left mounted would play too.
enableAutoUnmount(afterEach);

describe('SidInstrumentPage', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    clearAhxEditNotice();
    preview.on.length = 0;
    preview.off = 0;
    preview.offKeys.length = 0;
    preview.prepared = 0;
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
    // Its filter table's mode row (90 C4): low-pass, resonance 12, voice 3 filtered.
    expect(checked(w, 'sid-filter-LP')).toBe(true);
    expect(checked(w, 'sid-filter-voice-3')).toBe(true);
    expect(checked(w, 'sid-filter-voice-1')).toBe(false);
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
    // Tri lead has no filter table: the cutoff adds one of its own (mode,
    // cutoff, stop), low-pass with every voice filtered, and points at it.
    field(w, AhxSliderField, 'sid-field-cutoff').vm.$emit('update:modelValue', 0x60);
    await typeInto(w, 'sid-field-pulsePtr', '01');
    // No wave table: the boxes edit the first-frame byte ($11 -> $51).
    await w.get('[data-testid="sid-bit-pulse"]').trigger('change');
    await w.get('[data-testid="sid-filter-HP"]').trigger('change');
    await w.get('[data-testid="sid-hard-restart"]').trigger('change');
    const ins = sid().instruments[0]!;
    expect(ins).toMatchObject({ attack: 7, pulsePtr: 1, firstWave: 0x51, hardRestart: true, filterPtr: 5 });
    expect(sid().tables.filter.slice(4)).toEqual([
      { left: 0xd0, right: 0x07 },
      { left: 0x00, right: 0x60 },
      { left: 0xff, right: 0x00 },
    ]);
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

  it('Copy adds a copy with its own table rows and opens it', async () => {
    const { w, router } = await mountEditor(2);
    const before = sid();
    await w.get('[data-testid="sid-clone-instrument"]').trigger('click');
    await nextTick();
    const after = sid();
    expect(after.instruments).toHaveLength(5);
    const copy = after.instruments[4]!;
    expect(copy.name).toBe(before.instruments[1]!.name);
    // Its wave table starts on rows of its own, appended.
    expect(copy.wavePtr).toBeGreaterThan(before.tables.wave.length);
    await vi.waitFor(() => expect(router.currentRoute.value.params.slot).toBe('5'));
  });

  it('Delete asks first when rows name the instrument, then clears them and renumbers the rest', async () => {
    const { w } = await mountEditor(2);
    const before = sid();
    const named = (doc: typeof before, n: number) => doc.patterns.flatMap((p) => p.rows).filter((r) => r.instrument === n).length;
    expect(named(before, 2)).toBeGreaterThan(0);
    await w.get('[data-testid="sid-delete-instrument"]').trigger('click');
    await nextTick();
    // Nothing changed yet: the page asks.
    expect(sid()).toBe(before);
    expect(w.get('[data-testid="sid-delete-confirm"]').text()).toMatch(new RegExp(`Instrument 02 is named on ${named(before, 2)} row`));
    await w.get('[data-testid="sid-delete-confirm-yes"]').trigger('click');
    await nextTick();
    const after = sid();
    expect(after.instruments).toHaveLength(3);
    expect(after.instruments[1]).toEqual(before.instruments[2]);
    // The rows that named 3 name 2 now; none names 4.
    expect(named(after, 2)).toBe(named(before, 3));
    expect(named(after, 4)).toBe(0);
    expect(w.find('[data-testid="sid-delete-confirm"]').exists()).toBe(false);
  });

  it('the keys sound this instrument on the preview voice', async () => {
    const { w } = await mountEditor(4);
    const piano = w.findComponent(AhxPianoStrip);
    piano.vm.$emit('down', 57);
    piano.vm.$emit('up', 57);
    expect(preview.on).toEqual([[4, 57]]);
    expect(preview.off).toBe(1);
  });

  it('the computer keyboard plays it too, as in the tracker (Q is C-4 at octave 4)', async () => {
    await mountEditor(2);
    expect(preview.prepared).toBe(1);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyQ', key: 'q' }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyQ', key: 'q' }));
    expect(preview.on).toEqual([[2, 60]]);
    expect(preview.offKeys).toEqual([60]);
    // Shift+PageUp is the octave up, as on the AHX page and in the tracker.
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'PageUp', key: 'PageUp', shiftKey: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyQ', key: 'q' }));
    expect(preview.on.at(-1)).toEqual([2, 72]);
  });

  it('the scope is the tracker\'s SID scope, on the preview voice at its full scale', async () => {
    const { w } = await mountEditor(1);
    const scope = w.findComponent(TrackWaveform);
    expect(scope.exists()).toBe(true);
    expect(scope.props('audioNode')).toBeNull();
    expect((scope.props('analyserFullScale') as () => number)()).toBe(0.17);
    expect(w.find('[data-testid="sid-analyzer-idle"]').exists()).toBe(true);
  });

  it('re-strike on edit strikes the held note again after an edit, with the edited instrument', async () => {
    vi.useFakeTimers();
    try {
      const { w } = await mountEditor(1);
      w.findComponent(AhxAuditionBar).vm.$emit('update:restrike', true);
      await nextTick();
      w.findComponent(AhxPianoStrip).vm.$emit('down', 60);
      field(w, AhxSliderField, 'sid-field-attack').vm.$emit('update:modelValue', 5);
      await nextTick();
      vi.advanceTimersByTime(200);
      expect(preview.on).toEqual([[1, 60], [1, 60]]);
      expect(preview.offKeys).toEqual([60]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releasing an earlier key names it, so the voice keeps the newer note', async () => {
    const { w } = await mountEditor(1);
    const piano = w.findComponent(AhxPianoStrip);
    piano.vm.$emit('down', 57);
    piano.vm.$emit('down', 60);
    piano.vm.$emit('up', 57);
    expect(preview.on).toEqual([[1, 57], [1, 60]]);
    // The transport ignores a note-off for a key that is not the one sounding.
    expect(preview.offKeys).toEqual([57]);
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
    expect(back.doc.instruments[3]).toMatchObject({ gateTimer: 5, filterPtr: 5 });
    expect(back.doc.tables.filter[4]).toEqual({ left: 0x90, right: 0x97 });
    // Through the store's own save and load.
    const file = useTrackerStore().serializeSong();
    setActivePinia(createPinia());
    const other = useTrackerStore();
    other.loadSongFile(JSON.parse(JSON.stringify(file)));
    expect(other.sidDoc).toEqual(edited);
    expect(other.instrumentSlots[3]!.instrumentName).toBe('Vib lead');
  });

  it('the active waveform: a GoatTracker instrument shows what its wave table plays, not an empty set of boxes', async () => {
    useTrackerStore().adoptSidDoc(gtStyleChainSong());
    const { w } = await mountEditor(2);
    // Frame 1 (the default): wave table row 01, pulse with the gate on.
    expect(w.get('[data-testid="sid-now-wave"]').text()).toContain('Pulse');
    expect(w.get('[data-testid="sid-now-wave"]').text()).toContain('wave table row 01');
    expect(checked(w, 'sid-bit-pulse')).toBe(true);
    expect(checked(w, 'sid-bit-gate')).toBe(true);
    expect(w.get('[data-testid="sid-wave-status"]').text()).toContain('Editing wave table row 01');
    expect(w.get('[data-testid="sid-wave-shape"] path').attributes('d')).toMatch(/^M0,/);
    // Frame 0 is the first-frame byte: test and gate, no waveform.
    await setFrame(w, 0);
    expect(checked(w, 'sid-bit-test')).toBe(true);
    expect(checked(w, 'sid-bit-pulse')).toBe(false);
    expect(w.get('[data-testid="sid-now-wave"]').text()).toContain('first-frame byte');
    // Frame 2 is row 02 (the +4 step of the arpeggio): a box ticked there edits that row, and is what plays.
    await setFrame(w, 2);
    await w.get('[data-testid="sid-bit-saw"]').trigger('change');
    expect(sid().tables.wave[1]).toEqual({ left: 0x61, right: 0x04 });
    expect(sid().instruments[1]!.firstWave).toBe(0x09);
    expect(w.get('[data-testid="sid-now-wave"]').text()).toContain('Saw+Pulse');
    // The wave lane draws every frame, coloured by waveform.
    expect(w.findAll('[data-testid="sid-wave-lane"] rect.sid-wave--mixed').length).toBeGreaterThan(0);
  });

  it('an instrument with no wave table plays its first-frame byte all through, and the boxes edit that byte', async () => {
    const { w } = await mountEditor(1);
    expect(w.get('[data-testid="sid-wave-status"]').text()).toContain('first-frame byte 11');
    expect(checked(w, 'sid-bit-triangle')).toBe(true);
    expect(checked(w, 'sid-bit-gate')).toBe(true);
    await w.get('[data-testid="sid-bit-saw"]').trigger('change');
    expect(sid().instruments[0]!.firstWave).toBe(0x31);
  });

  it('the start width edits the pulse table\'s first row, or adds one for an instrument with none', async () => {
    // Arp pulse starts on pulse row 1, 84 00 (width 400).
    const { w } = await mountEditor(2);
    expect((field(w, AhxSliderField, 'sid-field-pulseWidth').props() as { modelValue: number }).modelValue).toBe(0x400);
    field(w, AhxSliderField, 'sid-field-pulseWidth').vm.$emit('update:modelValue', 0x6a0);
    expect(sid().tables.pulse[0]).toEqual({ left: 0x86, right: 0xa0 });
    expect(sid().tables.pulse).toHaveLength(4);
    // Tri lead has no pulse table: a width row and a stop of its own.
    await w.vm.$router.push({ name: 'sid-instrument-editor', params: { slot: '1' } });
    await nextTick();
    field(w, AhxSliderField, 'sid-field-pulseWidth').vm.$emit('update:modelValue', 0x800);
    expect(sid().instruments[0]!.pulsePtr).toBe(5);
    expect(sid().tables.pulse.slice(4)).toEqual([{ left: 0x88, right: 0x00 }, { left: 0xff, right: 0x00 }]);
  });

  it('a pulse table that starts with a sweep is edited in the table, not by the start width', async () => {
    const { w } = await mountEditor(2);
    await typeInto(w, 'sid-field-pulsePtr', '02');
    await nextTick();
    expect((field(w, AhxSliderField, 'sid-field-pulseWidth').props() as { disabled?: boolean }).disabled).toBe(true);
    expect(w.get('[data-testid="sid-field-pulseWidth-hint"]').text()).toContain('sweep or a jump');
  });

  it('the filter voices are the mode row\'s routing bits', async () => {
    const { w } = await mountEditor(3);
    await w.get('[data-testid="sid-filter-voice-1"]').trigger('change');
    // 90 C4 -> 90 C5: voice 1 filtered too, resonance and mode kept.
    expect(sid().tables.filter[0]).toEqual({ left: 0x90, right: 0xc5 });
  });

  it('pointers are hex rows like the tables\', with none, bounds and a readout', async () => {
    const { w } = await mountEditor(1);
    expect(w.get('[data-testid="sid-field-wavePtr-state"]').text()).toContain('none');
    let input = await typeInto(w, 'sid-field-wavePtr', '3');
    expect(sid().instruments[0]!.wavePtr).toBe(3);
    expect(input.value).toBe('03');
    await nextTick();
    expect(w.get('[data-testid="sid-field-wavePtr-state"]').text()).toBe('row 03 of 06');
    // Past the table, or not hex: refused, the kept value shown again.
    input = await typeInto(w, 'sid-field-wavePtr', '07');
    expect(sid().instruments[0]!.wavePtr).toBe(3);
    expect(input.value).toBe('03');
    await typeInto(w, 'sid-field-wavePtr', 'g');
    expect(sid().instruments[0]!.wavePtr).toBe(3);
    await w.get('[data-testid="sid-field-wavePtr-none"]').trigger('click');
    expect(sid().instruments[0]!.wavePtr).toBe(0);
  });

  it('table rows say what they do, and mark the start row and the frame cursor\'s row', async () => {
    const { w } = await mountEditor(2);
    expect(w.get('[data-testid="sid-pulse-1-desc"]').text()).toContain('Set width 400 (25.0 %)');
    expect(w.get('[data-testid="sid-pulse-2-desc"]').text()).toContain('Sweep +16 a frame for 32 frames');
    expect(w.get('[data-testid="sid-wave-4-desc"]').text()).toContain('Jump to row 01');
    expect(w.get('[data-testid="sid-filter-4-desc"]').text()).toContain('Stop');
    expect(w.get('[data-testid="sid-wave-length"]').text()).toBe('6 of 255 rows');
    expect(w.get('[data-testid="sid-wave-starts"]').text()).toContain('01');
    expect(w.findAll('[data-testid="sid-wave-start-marker"]')).toHaveLength(1);
    // The first-frame byte plays frame 0; the wave table runs from frame 1, so row 03 is frame 3.
    await setFrame(w, 3);
    expect(w.get('[data-testid="sid-wave-row-3"]').classes()).toContain('sid-table__now');
    // Pulse row 02 is swept from frame 1.
    await setFrame(w, 5);
    expect(w.get('[data-testid="sid-pulse-row-2"]').classes()).toContain('sid-table__now');
  });

  it('insert and delete keep every pointer, jump and command on its data', async () => {
    const { w } = await mountEditor(2);
    const before = sid();
    await w.get('[data-testid="sid-wave-row-1"]').trigger('click');
    await w.get('[data-testid="sid-wave-insert"]').trigger('click');
    expect(sid().tables.wave).toHaveLength(7);
    expect(sid().tables.wave[0]).toEqual({ left: 0, right: 0 });
    expect(sid().instruments[1]!.wavePtr).toBe(2);
    expect(sid().tables.wave[4]).toEqual({ left: 0xff, right: 0x02 });
    await w.get('[data-testid="sid-wave-delete"]').trigger('click');
    expect(sid().tables).toEqual(before.tables);
    expect(sid().instruments).toEqual(before.instruments);
    // Keyboard: Insert above the focused row.
    await w.get('[data-testid="sid-speed-1-left"]').trigger('keydown', { key: 'Insert' });
    expect(sid().instruments[3]!.speedPtr).toBe(2);
    // The porta-up command in pattern 0 read speed row 2: now row 3.
    expect(sid().patterns[0]!.rows[28]).toMatchObject({ command: 1, param: 3 });
    await w.get('[data-testid="sid-speed-1-left"]').trigger('keydown', { key: 'Delete', ctrlKey: true });
    expect(sid().tables.speed).toEqual(before.tables.speed);
    expect(sid().patterns[0]!.rows[28]).toMatchObject({ command: 1, param: 2 });
  });

  it('clear and "start here" act on the selected row', async () => {
    const { w } = await mountEditor(1);
    await w.get('[data-testid="sid-pulse-row-3"]').trigger('click');
    await w.get('[data-testid="sid-pulse-point"]').trigger('click');
    expect(sid().instruments[0]!.pulsePtr).toBe(3);
    await w.get('[data-testid="sid-pulse-clear"]').trigger('click');
    expect(sid().tables.pulse[2]).toEqual({ left: 0, right: 0 });
  });

  it('a starter sequence is appended and the instrument pointed at it', async () => {
    const { w } = await mountEditor(1);
    const select = w.get('[data-testid="sid-wave-template"]');
    (select.element as HTMLSelectElement).value = 'major';
    await select.trigger('change');
    expect(sid().instruments[0]!.wavePtr).toBe(7);
    expect(sid().tables.wave.slice(6)).toEqual([
      { left: 0x11, right: 0 },
      { left: 0x11, right: 4 },
      { left: 0x11, right: 7 },
      { left: 0xff, right: 7 },
    ]);
    expect((select.element as HTMLSelectElement).value).toBe('');
  });

  it('the vibrato card edits the instrument\'s speed row, and warns when the delay turns it off', async () => {
    const { w } = await mountEditor(4);
    field(w, AhxSliderField, 'sid-vib-depth').vm.$emit('update:modelValue', 0x30);
    field(w, AhxSliderField, 'sid-vib-speed').vm.$emit('update:modelValue', 6);
    expect(sid().tables.speed[0]).toEqual({ left: 6, right: 0x30 });
    await w.get('[data-testid="sid-vib-fine"]').trigger('change');
    expect(sid().tables.speed[0]!.left).toBe(0x86);
    expect(w.find('[data-testid="sid-field-vibratoDelay-hint"]').exists()).toBe(false);
    field(w, AhxSliderField, 'sid-field-vibratoDelay').vm.$emit('update:modelValue', 0);
    await nextTick();
    expect(w.get('[data-testid="sid-field-vibratoDelay-hint"]').text()).toContain('turns the vibrato off');
  });

  it('the first-frame byte is hex, with presets and what it means', async () => {
    const { w } = await mountEditor(4);
    expect(w.get('[data-testid="sid-first-wave-meaning"]').text()).toContain('09 (no waveform, test, gate on)');
    expect(w.find('[data-testid="sid-first-wave-warning"]').exists()).toBe(false);
    await w.get('[data-testid="sid-first-wave-00"]').trigger('click');
    expect(sid().instruments[3]!.firstWave).toBe(0);
    // sid_decisions.md §2: 00 leaves a fresh voice's gate shut, as GoatTracker's initchannels does.
    expect(w.get('[data-testid="sid-first-wave-warning"]').text()).toMatch(/gate starts shut/);
    await typeInto(w, 'sid-field-firstWave', '41');
    expect(sid().instruments[3]!.firstWave).toBe(0x41);
    expect(w.find('[data-testid="sid-first-wave-warning"]').exists()).toBe(false);
  });

  it('with no SID song it says so', async () => {
    useTrackerStore().resetToNewSong();
    const { w } = await mountEditor(1);
    expect(w.find('[data-testid="sid-instrument-missing"]').exists()).toBe(true);
  });
});

describe('SidInstrumentPage: presets', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    clearAhxEditNotice();
    useTrackerStore().adoptSidDoc(buildSidChainSong());
  });

  it('loads a preset into the instrument shown (one undo step, on the chosen filter voice) and says what it is', async () => {
    const { w } = await mountEditor(2);
    const before = sid();
    await w.get('[data-testid="sid-preset-voice"]').setValue('2');
    const picker = w.getComponent(PatchPicker);
    expect(picker.props('patches')).toHaveLength(SID_PRESETS.length);
    picker.vm.$emit('select', { id: 'bass-acid', name: 'Acid Bass', bankId: 'sid-presets', bankName: 'SID presets' });
    await nextTick();
    const ins = sid().instruments[1]!;
    expect(ins.name).toBe('Acid Bass');
    expect(sid().tables.filter[ins.filterPtr - 1]!.right & 0x07).toBe(0x02);
    expect(sid().instruments[0]).toBe(before.instruments[0]);
    expect(w.get('[data-testid="sid-preset-note"]').text()).toContain('squelch');
    useTrackerStore().undo();
    expect(sid()).toBe(before);
  });
});
