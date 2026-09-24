import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';

const preview = vi.hoisted(() => ({ log: [] as string[] }));
vi.mock('src/stores/tracker-playback-store', () => ({
  useTrackerPlaybackStore: () => ({
    previewAhxNoteOn: async (slot: number, midi: number, velocity: number) => {
      preview.log.push(`on:${slot}:${midi}:${velocity}`);
      return true;
    },
    previewAhxNoteOff: (midi: number) => preview.log.push(`off:${midi}`),
    setAhxPreviewScopeEnabled: () => undefined,
    getAhxPreviewWaveform: () => null,
  }),
}));

import AhxInstrumentPage from 'pages/AhxInstrumentPage.vue';
import { useTrackerStore } from 'src/stores/tracker-store';
import { importAhxToTrackerSong } from 'src/audio/tracker/ahx-import';
import { setCurrentAhxSource } from 'src/audio/tracker/ahx-source';

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
  return mount(AhxInstrumentPage, {
    attachTo: document.body,
    global: { plugins: [router], stubs: { QPage: { template: '<div><slot /></div>' }, QIcon: true, QBtn: true } },
  });
}
type Wrapper = Awaited<ReturnType<typeof mountEditor>>;
const el = (w: Wrapper, testid: string) => w.get(`[data-testid="${testid}"]`);
const press = (code: string, target: EventTarget = window) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true, cancelable: true }));
const lift = (code: string) =>
  window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code, bubbles: true }));

describe('AhxInstrumentPage: keyboard, MIDI and on-screen piano', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    preview.log.length = 0;
    localStorage.clear();
    useTrackerStore().loadSongFile(importAhxToTrackerSong(karma()));
    setCurrentAhxSource(new Uint8Array(karma()));
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('computer keys play the edited slot through the preview, and the octave control shifts them', async () => {
    const w = await mountEditor(2);
    press('KeyZ');
    lift('KeyZ');
    expect(preview.log).toEqual(['on:2:48:100', 'off:48']);
    preview.log.length = 0;
    await el(w, 'ahx-octave-up').trigger('click');
    expect(el(w, 'ahx-octave').text()).toBe('Oct 5');
    press('KeyZ');
    lift('KeyZ');
    expect(preview.log).toEqual(['on:2:60:100', 'off:60']);
    w.unmount();
  });

  it('typing in one of the editor fields plays nothing', async () => {
    const w = await mountEditor(1);
    const field = el(w, 'ahx-field-volume').element;
    press('KeyZ', field);
    press('KeyQ', field);
    expect(preview.log).toEqual([]);
    w.unmount();
  });

  it('the on-screen piano strip plays, follows the octave, and lights held keys', async () => {
    const w = await mountEditor(1);
    const c3 = el(w, 'ahx-piano-48');
    await c3.trigger('pointerdown');
    expect(preview.log).toEqual(['on:1:48:100']);
    expect(c3.classes()).toContain('ahx-piano__key--held');
    await c3.trigger('pointerup');
    expect(preview.log).toEqual(['on:1:48:100', 'off:48']);
    expect(c3.classes()).not.toContain('ahx-piano__key--held');
    await el(w, 'ahx-octave-down').trigger('click');
    expect(w.find('[data-testid="ahx-piano-36"]').exists()).toBe(true);
    expect(w.find('[data-testid="ahx-piano-48"]').exists()).toBe(true); // C-3 is still on the second octave
    w.unmount();
  });

  it('a key and the piano share the Latch behaviour', async () => {
    const w = await mountEditor(1);
    await el(w, 'ahx-audition-latch').setValue(true);
    press('KeyZ');
    lift('KeyZ');
    expect(preview.log).toEqual(['on:1:48:100']);
    await el(w, 'ahx-piano-50').trigger('pointerdown');
    expect(preview.log).toEqual(['on:1:48:100', 'off:48', 'on:1:50:100']);
    w.unmount();
  });

  it('with no source bytes the keys, the piano and the octave-shifted keyboard are off and it says so', async () => {
    setCurrentAhxSource(null);
    const w = await mountEditor(1);
    press('KeyZ');
    await el(w, 'ahx-piano-48').trigger('pointerdown');
    expect(preview.log).toEqual([]);
    expect(el(w, 'ahx-audition-off').text()).toMatch(/keyboard, MIDI and keys are off/);
    expect(el(w, 'ahx-piano').classes()).toContain('ahx-piano--disabled');
    w.unmount();
  });

  it('shows a MIDI chip that reflects what the browser gives', async () => {
    const requests: string[] = [];
    Object.defineProperty(navigator, 'requestMIDIAccess', {
      configurable: true,
      value: () => {
        requests.push('asked');
        return Promise.reject(new DOMException('denied', 'SecurityError'));
      },
    });
    try {
      const w = await mountEditor(1);
      expect(el(w, 'ahx-midi-chip').text()).toBe('MIDI: off');
      expect(requests).toEqual([]); // no permission prompt until asked
      await el(w, 'ahx-midi-chip').trigger('click');
      await flushPromises();
      expect(el(w, 'ahx-midi-chip').text()).toBe('MIDI: denied');
      w.unmount();
    } finally {
      delete (navigator as unknown as Record<string, unknown>).requestMIDIAccess;
    }
  });

  it('without Web MIDI the chip says so instead of failing', async () => {
    const w = await mountEditor(1);
    await el(w, 'ahx-midi-chip').trigger('click');
    await flushPromises();
    expect(el(w, 'ahx-midi-chip').text()).toBe('MIDI: not supported');
    w.unmount();
  });
});
