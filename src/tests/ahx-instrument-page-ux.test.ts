import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';

const preview = vi.hoisted(() => ({ log: [] as string[] }));
vi.mock('src/stores/tracker-playback-store', () => ({
  useTrackerPlaybackStore: () => ({
    previewAhxNoteOn: async (slot: number, midi: number) => {
      preview.log.push(`on:${slot}:${midi}`);
      return true;
    },
    previewAhxNoteOff: (midi: number) => preview.log.push(`off:${midi}`),
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

describe('AhxInstrumentPage, EDITOR-UX batch 1', () => {
  let store: ReturnType<typeof useTrackerStore>;
  const ins = () => store.instrumentSlots.find((s) => s.slot === 1)!.ahxData!;

  beforeEach(() => {
    setActivePinia(createPinia());
    preview.log.length = 0;
    store = useTrackerStore();
    store.loadSongFile(importAhxToTrackerSong(karma()));
    setCurrentAhxSource(new Uint8Array(karma()));
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  describe('E3: slider / segmented / stepper controls beside the typed fields', () => {
    it('a slider writes through, and the typed field with the original test id shows the same value', async () => {
      const w = await mountEditor(1);
      await el(w, 'ahx-field-volume-slider').setValue('21'); // input + change: a click on the track
      expect(ins().volume).toBe(21);
      expect((el(w, 'ahx-field-volume').element as HTMLInputElement).value).toBe('21');
      // Typing still works and still clamps.
      await el(w, 'ahx-field-volume').setValue('900');
      expect(ins().volume).toBe(64);
      w.unmount();
    });

    it('a table-cost slider is throttled while it moves and ends on the released value', async () => {
      vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'setTimeout', 'clearTimeout'] });
      const w = await mountEditor(1);
      const slider = el(w, 'ahx-field-vibratoSpeed-slider');
      const writes = vi.spyOn(store, 'updateAhxInstrument');
      for (let v = 1; v <= 40; v++) {
        // What dragging a thumb does: `input` events only; `change` comes on release.
        (slider.element as HTMLInputElement).value = String(v);
        await slider.trigger('input');
      }
      expect(writes.mock.calls.length).toBeLessThanOrEqual(1);
      await slider.trigger('change'); // release
      expect(ins().vibratoSpeed).toBe(40);
      const afterRelease = writes.mock.calls.length;
      vi.advanceTimersByTime(500);
      expect(writes.mock.calls.length).toBe(afterRelease); // nothing extra fires later
      w.unmount();
    });

    it('wave length is a radio group of sample counts, and the typed field agrees', async () => {
      const w = await mountEditor(1);
      const seg = w.get('[role="radiogroup"]');
      expect(seg.text()).toContain('128');
      await el(w, 'ahx-seg-waveLength-3').setValue(true);
      expect(ins().waveLength).toBe(3);
      expect((el(w, 'ahx-field-waveLength').element as HTMLInputElement).value).toBe('3');
      expect((el(w, 'ahx-seg-waveLength-3').element as HTMLInputElement).checked).toBe(true);
      w.unmount();
    });

    it('vibrato depth, hard-cut frames and PList speed are steppers', async () => {
      const w = await mountEditor(1);
      const depth = ins().vibratoDepth;
      await el(w, 'ahx-field-vibratoDepth-inc').trigger('click');
      expect(ins().vibratoDepth).toBe(Math.min(15, depth + 1));
      const speed = ins().plist.speed;
      await el(w, 'ahx-plist-speed-inc').trigger('click');
      expect(ins().plist.speed).toBe(speed + 1);
      w.unmount();
    });
  });

  describe('E1/E2: envelope warnings and editor', () => {
    it('warns, in words, about a zero-frame attack, decay and release', async () => {
      const w = await mountEditor(1);
      await el(w, 'ahx-env-aFrames').setValue('0');
      await el(w, 'ahx-env-dFrames').setValue('4');
      expect(el(w, 'ahx-envelope-warning-no-attack').text()).toMatch(/skips it: the note starts at silence/);
      expect(w.find('[data-testid="ahx-envelope-ideal"]').exists()).toBe(true);
      await el(w, 'ahx-env-aFrames').setValue('3');
      await el(w, 'ahx-env-dFrames').setValue('0');
      await el(w, 'ahx-env-aVolume').setValue('60');
      await el(w, 'ahx-env-dVolume').setValue('20');
      expect(el(w, 'ahx-envelope-warning-no-decay').text()).toMatch(/holds the attack level/);
      await el(w, 'ahx-env-rFrames').setValue('0');
      expect(el(w, 'ahx-envelope-warning-no-release').text()).toMatch(/never releases/);
      await el(w, 'ahx-env-dFrames').setValue('2');
      await el(w, 'ahx-env-rFrames').setValue('4');
      expect(w.findAll('.ahx-warn').filter((p) => p.attributes('data-testid')?.startsWith('ahx-envelope-'))).toHaveLength(0);
      w.unmount();
    });

    it('an arrow key on a node commits to the song, and the typed field follows', async () => {
      const w = await mountEditor(1);
      const before = ins().envelope.aFrames;
      await el(w, 'ahx-env-node-A').trigger('keydown', { key: 'ArrowRight' });
      expect(ins().envelope.aFrames).toBe(before + 1);
      expect((el(w, 'ahx-env-aFrames').element as HTMLInputElement).value).toBe(String(before + 1));
      w.unmount();
    });
  });

  describe('E4: the audition bar', () => {
    it('is a sticky single bar with the three keys, Latch and Re-strike', async () => {
      const w = await mountEditor(1);
      expect(el(w, 'ahx-audition').classes()).toContain('ahx-audition-bar');
      for (const id of ['ahx-audition-48', 'ahx-audition-60', 'ahx-audition-72', 'ahx-audition-latch', 'ahx-audition-restrike']) {
        expect(w.find(`[data-testid="${id}"]`).exists()).toBe(true);
      }
      w.unmount();
    });

    it('with Latch a tap holds the note, a second tap releases it, and another key takes over', async () => {
      const w = await mountEditor(1);
      await el(w, 'ahx-audition-latch').setValue(true);
      const k60 = el(w, 'ahx-audition-60');
      await k60.trigger('pointerdown');
      await k60.trigger('pointerup');
      await k60.trigger('pointerleave');
      expect(preview.log).toEqual(['on:1:60']); // still held after the finger left
      await el(w, 'ahx-audition-72').trigger('pointerdown');
      expect(preview.log).toEqual(['on:1:60', 'off:60', 'on:1:72']);
      await el(w, 'ahx-audition-72').trigger('pointerdown');
      expect(preview.log.at(-1)).toBe('off:72');
      w.unmount();
    });

    it('turning Latch off lets a held note go', async () => {
      const w = await mountEditor(1);
      await el(w, 'ahx-audition-latch').setValue(true);
      await el(w, 'ahx-audition-48').trigger('pointerdown');
      await el(w, 'ahx-audition-latch').setValue(false);
      expect(preview.log).toEqual(['on:1:48', 'off:48']);
      w.unmount();
    });

    it('Re-strike strikes the held note again ~150 ms after an edit, once for a burst of edits', async () => {
      vi.useFakeTimers();
      const w = await mountEditor(1);
      await el(w, 'ahx-audition-latch').setValue(true);
      await el(w, 'ahx-audition-restrike').setValue(true);
      await el(w, 'ahx-audition-60').trigger('pointerdown');
      preview.log.length = 0;
      await el(w, 'ahx-field-volume').setValue('30');
      await el(w, 'ahx-field-volume').setValue('31');
      await el(w, 'ahx-field-volume').setValue('32');
      vi.advanceTimersByTime(100);
      expect(preview.log).toEqual([]);
      vi.advanceTimersByTime(60);
      expect(preview.log).toEqual(['off:60', 'on:1:60']);
      w.unmount();
    });

    it('without Re-strike an edit leaves the held note alone; with nothing held nothing strikes', async () => {
      vi.useFakeTimers();
      const w = await mountEditor(1);
      await el(w, 'ahx-audition-latch').setValue(true);
      await el(w, 'ahx-audition-60').trigger('pointerdown');
      preview.log.length = 0;
      await el(w, 'ahx-field-volume').setValue('30');
      vi.advanceTimersByTime(500);
      expect(preview.log).toEqual([]);
      w.unmount();
    });

    it('a plain tap without Latch is unchanged: down sounds, up releases', async () => {
      const w = await mountEditor(1);
      const k = el(w, 'ahx-audition-60');
      await k.trigger('pointerdown');
      await k.trigger('pointerup');
      await k.trigger('pointerleave');
      expect(preview.log).toEqual(['on:1:60', 'off:60']);
      w.unmount();
    });

    it('leaving the page releases a latched note', async () => {
      const w = await mountEditor(1);
      await el(w, 'ahx-audition-latch').setValue(true);
      await el(w, 'ahx-audition-60').trigger('pointerdown');
      w.unmount();
      expect(preview.log).toEqual(['on:1:60', 'off:60']);
    });
  });

  describe('E14: honesty fixes', () => {
    it('a relative PList note says how many semitones above the played key; a fixed one names the pitch', async () => {
      const w = await mountEditor(1);
      const entry = ins().plist.entries[0]!;
      expect(entry.fixed).toBe(false);
      await el(w, 'ahx-plist-0-note').setValue('13');
      expect(el(w, 'ahx-plist-0-note').attributes('title')).toBe('+12 st above the played key (relative; tick Fixed to play C-2 itself)');
      await el(w, 'ahx-plist-0-fixed').setValue(true);
      expect(el(w, 'ahx-plist-0-note').attributes('title')).toBe('C-2: a fixed pitch, whatever key is played');
      await el(w, 'ahx-plist-0-note').setValue('0');
      expect(el(w, 'ahx-plist-0-note').attributes('title')).toContain('keep the pitch');
      w.unmount();
    });

    it('the filter lower limit takes what the file format holds (0..127), and says when it is past the engine\'s 1-63', async () => {
      const w = await mountEditor(1);
      await el(w, 'ahx-field-filterLowerLimit').setValue('100');
      expect(ins().filterLowerLimit).toBe(100);
      expect(el(w, 'ahx-field-filterLowerLimit-hint').text()).toMatch(/clamps filter positions to 1-63/);
      await el(w, 'ahx-field-filterLowerLimit').setValue('40');
      expect(w.find('[data-testid="ahx-field-filterLowerLimit-hint"]').exists()).toBe(false);
      await el(w, 'ahx-field-filterLowerLimit').setValue('900');
      expect(ins().filterLowerLimit).toBe(127);
      w.unmount();
    });

    it('no dead .ahx-params CSS is left in the page', () => {
      const src = readFileSync(resolve(__dirname, '../pages/AhxInstrumentPage.vue'), 'utf8');
      expect(src).not.toMatch(/\.ahx-params/);
    });
  });
});
