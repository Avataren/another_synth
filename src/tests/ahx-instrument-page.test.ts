import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';

const preview = vi.hoisted(() => ({ on: [] as Array<[number, number, number]>, off: [] as number[] }));
vi.mock('src/stores/tracker-playback-store', () => ({
  useTrackerPlaybackStore: () => ({
    previewAhxNoteOn: async (slot: number, midi: number, velocity: number) => {
      preview.on.push([slot, midi, velocity]);
      return true;
    },
    previewAhxNoteOff: (midi: number) => preview.off.push(midi),
  }),
}));

import AhxInstrumentPage from 'pages/AhxInstrumentPage.vue';
import { useTrackerStore } from 'src/stores/tracker-store';
import { importAhxToTrackerSong } from 'src/audio/tracker/ahx-import';
import { currentAhxInstrumentEdits, setCurrentAhxSource } from 'src/audio/tracker/ahx-source';
import { clearAhxNotices, reportAhxNotice } from 'src/audio/tracker/ahx-notices';

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
    global: {
      plugins: [router],
      stubs: { QPage: { template: '<div><slot /></div>' }, QIcon: true, QBtn: true },
    },
  });
}

const input = (w: Awaited<ReturnType<typeof mountEditor>>, testid: string) =>
  w.get(`[data-testid="${testid}"]`);

describe('AhxInstrumentPage as an editor', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    preview.on.length = 0;
    preview.off.length = 0;
    setCurrentAhxSource(null);
  });

  function load() {
    const store = useTrackerStore();
    const file = importAhxToTrackerSong(karma());
    store.loadSongFile(file);
    setCurrentAhxSource(new Uint8Array(karma())); // as applySongFile does
    return store;
  }

  it('says it edits the song, and is not read-only', async () => {
    load();
    const w = await mountEditor(1);
    expect(w.get('[data-testid="ahx-editable-badge"]').text()).toBe('Edits this session');
    expect(w.text()).not.toMatch(/read-only/i);
    // An editable AHX song saves its instruments inside the .cmod (v5), and the tooltip no longer says it cannot.
    expect(w.get('[data-testid="ahx-editable-badge"]').attributes('title')).toMatch(/\.cmod keeps the edits/);
    expect(w.get('[data-testid="ahx-editable-badge"]').attributes('title')).not.toMatch(/cannot be saved|for this session/i);
    expect(w.find('[data-testid="ahx-source-missing"]').exists()).toBe(false);
    expect((w.get('[data-testid="ahx-audition-60"]').element as HTMLButtonElement).disabled).toBe(false);
  });

  it('with no source bytes it says edits cannot be heard, and the audition keys are off', async () => {
    const store = useTrackerStore();
    store.loadSongFile(importAhxToTrackerSong(karma()));
    setCurrentAhxSource(null); // a song loaded from a saved file
    const w = await mountEditor(1);
    expect(w.get('[data-testid="ahx-editable-badge"]').text()).toBe('Edits not audible');
    expect(w.get('[data-testid="ahx-source-missing"]').text()).toMatch(/nothing can be heard/);
    const key = w.get('[data-testid="ahx-audition-60"]');
    expect((key.element as HTMLButtonElement).disabled).toBe(true);
    preview.on.length = 0;
    await key.trigger('pointerdown');
    expect(preview.on).toEqual([]);
  });

  it('shows what the engine refused, not only the console', async () => {
    load();
    reportAhxNotice('Instrument #3: the song did not accept the edit (x), so it plays as before.');
    const w = await mountEditor(1);
    expect(w.get('[data-testid="ahx-notice"]').text()).toMatch(/Instrument #3/);
    clearAhxNotices();
  });

  it('every control writes through to the slot’s ahxData and to the song’s recorded edits at once', async () => {
    const store = load();
    const w = await mountEditor(1);
    const slot = () => store.instrumentSlots.find((s) => s.slot === 1)!.ahxData!;

    await input(w, 'ahx-field-volume').setValue('33');
    expect(slot().volume).toBe(33);
    await input(w, 'ahx-env-aFrames').setValue('4');
    await input(w, 'ahx-env-dVolume').setValue('20');
    await input(w, 'ahx-env-rFrames').setValue('9');
    expect(slot().envelope).toMatchObject({ aFrames: 4, dVolume: 20, rFrames: 9 });
    await input(w, 'ahx-field-waveLength').setValue('3');
    expect(slot().waveLength).toBe(3);
    await input(w, 'ahx-start-waveform').setValue('4');
    expect(slot().plist.entries[0]!.waveform).toBe(4);
    await input(w, 'ahx-plist-speed').setValue('7');
    expect(slot().plist.speed).toBe(7);
    await input(w, 'ahx-plist-0-note').setValue('30');
    expect(slot().plist.entries[0]!.note).toBe(30);
    await input(w, 'ahx-plist-0-fx1').setValue('15');
    await input(w, 'ahx-plist-0-param1').setValue('5');
    expect(slot().plist.entries[0]!.fx[1]).toBe(15);
    expect(slot().plist.entries[0]!.fxParam[1]).toBe(5);

    // The song's own instrument was replaced, not a copy: the edit is recorded for every worklet.
    const recorded = currentAhxInstrumentEdits().find((e) => e.instrument === 1);
    expect(recorded).toBeDefined();
    expect(recorded!.bytes[0]).toBe(33); // the volume byte of the wire form
  });

  it('clamps what is typed into what the format holds', async () => {
    const store = load();
    const w = await mountEditor(1);
    await input(w, 'ahx-field-volume').setValue('900');
    expect(store.instrumentSlots.find((s) => s.slot === 1)!.ahxData!.volume).toBe(64);
    await input(w, 'ahx-field-waveLength').setValue('9');
    expect(store.instrumentSlots.find((s) => s.slot === 1)!.ahxData!.waveLength).toBe(5);
  });

  it('adds, inserts and removes PList rows', async () => {
    const store = load();
    const w = await mountEditor(1);
    const rows = () => store.instrumentSlots.find((s) => s.slot === 1)!.ahxData!.plist.entries.length;
    const start = rows();
    await w.get('[data-testid="ahx-plist-add"]').trigger('click');
    expect(rows()).toBe(start + 1);
    await w.get('[data-testid="ahx-plist-insert-0"]').trigger('click');
    expect(rows()).toBe(start + 2);
    await w.get('[data-testid="ahx-plist-remove-0"]').trigger('click');
    await w.get('[data-testid="ahx-plist-remove-0"]').trigger('click');
    expect(rows()).toBe(start);
    expect(w.get('[data-testid="ahx-plist-summary"]').text()).toContain(`${start} rows`);
  });

  it('warns about an envelope that never rises', async () => {
    load();
    const w = await mountEditor(1);
    await input(w, 'ahx-env-aFrames').setValue('0');
    await input(w, 'ahx-env-dFrames').setValue('0');
    expect(w.find('[data-testid="ahx-envelope-never-rises"]').exists()).toBe(true);
    await input(w, 'ahx-env-aFrames').setValue('2');
    expect(w.find('[data-testid="ahx-envelope-never-rises"]').exists()).toBe(false);
  });

  it('auditions the slot being edited through the preview voice, and lets go on release', async () => {
    load();
    const w = await mountEditor(3);
    const key = w.get('[data-testid="ahx-audition-60"]');
    await key.trigger('pointerdown');
    expect(preview.on).toEqual([[3, 60, 100]]);
    await key.trigger('pointerup');
    expect(preview.off).toEqual([60]);
    await key.trigger('pointerleave'); // already released: not released twice
    expect(preview.off).toEqual([60]);
  });

  it('shows the empty message for a slot with no AHX instrument', async () => {
    load();
    const w = await mountEditor(60);
    expect(w.find('[data-testid="ahx-instrument-missing"]').exists()).toBe(true);
  });
});
