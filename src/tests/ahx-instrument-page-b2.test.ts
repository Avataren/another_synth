import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';

vi.mock('src/stores/tracker-playback-store', () => ({
  useTrackerPlaybackStore: () => ({
    previewAhxNoteOn: async () => true,
    previewAhxNoteOff: () => undefined,
  }),
}));

import AhxInstrumentPage from 'pages/AhxInstrumentPage.vue';
import { useTrackerStore } from 'src/stores/tracker-store';
import { importAhxToTrackerSong } from 'src/audio/tracker/ahx-import';
import { ahxSquareDuty } from 'src/audio/tracker/ahx-instrument-visuals';
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
const has = (w: Wrapper, testid: string) => w.find(`[data-testid="${testid}"]`).exists();

describe('AhxInstrumentPage, EDITOR-UX batch 2 "see the sound"', () => {
  let store: ReturnType<typeof useTrackerStore>;
  const ins = (slot = 1) => store.instrumentSlots.find((s) => s.slot === slot)!.ahxData!;

  beforeEach(() => {
    setActivePinia(createPinia());
    store = useTrackerStore();
    store.loadSongFile(importAhxToTrackerSong(karma()));
    setCurrentAhxSource(new Uint8Array(karma()));
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  describe('E5: the waveform picker and the shape preview', () => {
    it('draws 4 << waveLength bars and redraws when the wave length changes', async () => {
      const w = await mountEditor(1);
      for (const wl of [0, 1, 2, 3, 4, 5]) {
        await el(w, `ahx-seg-waveLength-${wl}`).setValue(true);
        expect(ins().waveLength).toBe(wl);
        expect(el(w, 'ahx-wave-shape').attributes('data-samples')).toBe(String(4 << wl));
        expect(w.findAll('.ahx-wave-bar')).toHaveLength(4 << wl);
      }
    });

    it('the glyph picker sets the first row\'s waveform and the preview follows it', async () => {
      const w = await mountEditor(1);
      await el(w, 'ahx-seg-startWaveform-2').setValue(true);
      expect(ins().plist.entries[0]!.waveform).toBe(2);
      expect(el(w, 'ahx-wave-shape').attributes('data-kind')).toBe('sawtooth');
      await el(w, 'ahx-seg-startWaveform-3').setValue(true);
      expect(el(w, 'ahx-wave-shape').attributes('data-kind')).toBe('square');
      expect(has(w, 'ahx-wave-shape-duty')).toBe(true);
      await el(w, 'ahx-seg-startWaveform-4').setValue(true);
      expect(el(w, 'ahx-wave-shape').attributes('data-kind')).toBe('noise');
      expect(w.findAll('.ahx-wave-bar')).toHaveLength(0); // noise is a glyph, not bars
      expect(el(w, 'ahx-wave-shape-caption').text()).toMatch(/random burst/);
      // the select stays as the exact-value fallback and agrees
      expect((el(w, 'ahx-start-waveform').element as HTMLSelectElement).value).toBe('4');
    });

    it('the exact-value select still edits it', async () => {
      const w = await mountEditor(1);
      await el(w, 'ahx-start-waveform').setValue('1');
      expect(ins().plist.entries[0]!.waveform).toBe(1);
      expect(el(w, 'ahx-wave-shape').attributes('data-kind')).toBe('triangle');
    });

    it('shows "before filtering" only when a filter is in play', async () => {
      const filtered = await mountEditor(2); // a filter toggle (4/11) in its PList
      expect(has(filtered, 'ahx-wave-prefilter')).toBe(true);
      filtered.unmount();
      const plain = await mountEditor(6); // no filter command at all
      expect(has(plain, 'ahx-wave-prefilter')).toBe(false);
    });
  });

  describe('E9: the vibrato lane', () => {
    it('draws a curve for a vibrato and "off" for depth 0', async () => {
      const w = await mountEditor(1); // vibrato 17 / 8 / 2
      expect(el(w, 'ahx-vibrato-trace').attributes('points')!.split(' ').length).toBeGreaterThan(40);
      expect(el(w, 'ahx-vibrato-caption').text()).toMatch(/steady for 17 ticks/);
      expect(el(w, 'ahx-vibrato-caption').text()).toMatch(/period units/);
      await el(w, 'ahx-field-vibratoDepth').setValue('0');
      expect(ins().vibratoDepth).toBe(0);
      expect(el(w, 'ahx-vibrato-caption').text()).toMatch(/off/);
    });
  });

  describe('the B2 review fixes', () => {
    it('the vibrato trace stays inside the box and the labels are the real swing (depth 1: +1 / -2)', async () => {
      const w = await mountEditor(1);
      await el(w, 'ahx-field-vibratoDepth').setValue('1');
      const ys = el(w, 'ahx-vibrato-trace').attributes('points')!.split(' ').map((p) => Number(p.split(',')[1]));
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...ys)).toBeLessThanOrEqual(110);
      expect(el(w, 'ahx-vibrato-caption').text()).toMatch(/between \+1 and −2/);
      await el(w, 'ahx-field-vibratoSpeed').setValue('32');
      expect(el(w, 'ahx-vibrato-caption').text()).toMatch(/nothing wobbles/);
      await el(w, 'ahx-field-vibratoSpeed').setValue('40');
      expect(el(w, 'ahx-vibrato-caption').text()).toMatch(/backwards/);
    });

    it('a square preview with no pulse-width command starts where the engine does, position 0', async () => {
      const w = await mountEditor(6);
      expect(ins(6).plist.entries.some((e) => e.fx.includes(3))).toBe(false);
      await el(w, 'ahx-seg-startWaveform-3').setValue(true);
      const wl = ins(6).waveLength;
      expect(el(w, 'ahx-wave-shape-duty').text()).toContain(`${Math.round(ahxSquareDuty(0, wl) * 100)}%`);
    });

    it('the hard-cut frames field stays enabled with the box unticked, and says the cut is abrupt', async () => {
      const w = await mountEditor(1);
      await el(w, 'ahx-field-hardCutRelease').setValue(true);
      await el(w, 'ahx-field-hardCutReleaseFrames').setValue('2');
      expect(has(w, 'ahx-hardcut-abrupt')).toBe(false);
      await el(w, 'ahx-field-hardCutRelease').setValue(false);
      expect(ins().hardCutReleaseFrames).toBe(2);
      expect((el(w, 'ahx-field-hardCutReleaseFrames').element as HTMLInputElement).disabled).toBe(false);
      expect(el(w, 'ahx-hardcut-abrupt').text()).toMatch(/muted abruptly 2 ticks before the next note/);
      await el(w, 'ahx-field-hardCutReleaseFrames').setValue('0');
      expect(has(w, 'ahx-hardcut-abrupt')).toBe(false);
    });

    it('the command select options use the plain names of the strip chips', async () => {
      const w = await mountEditor(1);
      const labels = el(w, 'ahx-plist-0-fx0').findAll('option').map((o) => o.text());
      expect(labels).toContain('3 Set pulse width');
      expect(labels).toContain('4 Sweep on/off');
      expect(labels).toContain('0 Set brightness');
      expect(labels.join(' ')).not.toMatch(/Square\/filter|Ring modulate|Square position/);
    });
  });

  describe('E8: the sweep lanes', () => {
    it('a sweep the PList switches on draws its band and a trace', async () => {
      const w = await mountEditor(2); // 4/11: both sweeps toggled
      expect(el(w, 'ahx-sweep-lane-filter').attributes('data-state')).toBe('on');
      expect(has(w, 'ahx-sweep-band-filter')).toBe(true);
      expect(has(w, 'ahx-sweep-trace-filter')).toBe(true);
      expect(has(w, 'ahx-sweep-off-filter')).toBe(false);
      expect(el(w, 'ahx-sweep-band-filter').attributes('height')).toBeTruthy();
    });

    it('an instrument with no sweep command shows the off state, its reason, and a working "Turn on at row 0"', async () => {
      const w = await mountEditor(6);
      expect(ins(6).plist.entries.some((e) => e.fx.includes(4))).toBe(false);
      for (const kind of ['filter', 'square']) {
        expect(el(w, `ahx-sweep-lane-${kind}`).attributes('data-state')).toBe('no-toggle');
        expect(has(w, `ahx-sweep-off-${kind}`)).toBe(true);
        expect(has(w, `ahx-sweep-trace-${kind}`)).toBe(false);
        expect(has(w, `ahx-sweep-band-${kind}`)).toBe(true); // the band still shows the limits
        expect(el(w, `ahx-sweep-why-${kind}`).text()).toMatch(/Inactive/);
      }
      await el(w, 'ahx-sweep-enable-filter').trigger('click');
      expect(ins(6).plist.entries[0]!.fx).toContain(4);
      expect(ins(6).plist.entries[0]!.fxParam[ins(6).plist.entries[0]!.fx.indexOf(4)]).toBe(0x10);
      expect(el(w, 'ahx-sweep-lane-filter').attributes('data-state')).toBe('on');
      expect(has(w, 'ahx-sweep-trace-filter')).toBe(true);
      // the square sweep needs the square wave too: the button turns both on
      await el(w, 'ahx-sweep-enable-square').trigger('click');
      expect(ins(6).plist.entries[0]!.waveform).toBe(3);
      expect(el(w, 'ahx-sweep-lane-square').attributes('data-state')).toBe('on');
    });

    it('the square lane also draws the two pulse shapes at its limits', async () => {
      const w = await mountEditor(2);
      expect(has(w, 'ahx-sweep-pulse-lower')).toBe(true);
      expect(has(w, 'ahx-sweep-pulse-upper')).toBe(true);
      expect(el(w, 'ahx-sweep-caption-square').text()).toMatch(/thin and nasal/);
      expect(el(w, 'ahx-sweep-caption-square').text()).toMatch(/bigger number is slower/);
    });

    it('the lanes redraw as the limits move', async () => {
      const w = await mountEditor(2);
      const before = el(w, 'ahx-sweep-band-filter').attributes('height');
      await el(w, 'ahx-field-filterUpperLimit').setValue('60');
      expect(ins(2).filterUpperLimit).toBe(60);
      expect(el(w, 'ahx-sweep-band-filter').attributes('height')).not.toBe(before);
    });
  });

  describe('E6: the PList strip', () => {
    it('renders one named chip per entry, with the raw code as secondary text', async () => {
      const w = await mountEditor(2);
      const entries = ins(2).plist.entries;
      const chips = w.findAll('[data-testid^="ahx-strip-chip-"]');
      expect(chips).toHaveLength(entries.length);
      // karma #2: row 0 carries 4/11, "Pulse + brightness sweeps on/off"
      expect(el(w, 'ahx-strip-chip-0').text()).toContain('Pulse + brightness sweeps on/off');
      expect(el(w, 'ahx-strip-chip-0').text()).toContain('411');
      expect(el(w, 'ahx-strip-fx-0-0').classes()).toContain('ahx-chip__fx--pulse'); // 3/xx sets the pulse width
      expect(el(w, 'ahx-strip-fx-0-1').classes()).toContain('ahx-chip__fx--sweep');
      expect(el(w, 'ahx-plist-strip-caption').text()).toMatch(/little score/);
    });

    it('clicking a chip selects it and highlights the same row of the table', async () => {
      const w = await mountEditor(2);
      expect(el(w, 'ahx-strip-chip-1').attributes('data-selected')).toBe('false');
      await el(w, 'ahx-strip-chip-1').trigger('click');
      expect(el(w, 'ahx-strip-chip-1').attributes('data-selected')).toBe('true');
      expect(el(w, 'ahx-strip-chip-1').attributes('aria-selected')).toBe('true');
      expect(el(w, 'ahx-plist-row-1').attributes('data-selected')).toBe('true');
      expect(el(w, 'ahx-plist-row-1').classes()).toContain('ahx-row--selected');
      expect(el(w, 'ahx-plist-row-0').attributes('data-selected')).toBe('false');
      await el(w, 'ahx-strip-chip-0').trigger('click');
      expect(el(w, 'ahx-plist-row-1').attributes('data-selected')).toBe('false');
      expect(el(w, 'ahx-plist-row-0').attributes('data-selected')).toBe('true');
    });

    it('the arrow keys move the selection along the strip', async () => {
      const w = await mountEditor(2);
      await el(w, 'ahx-strip-chip-0').trigger('click');
      await el(w, 'ahx-strip-chip-0').trigger('keydown', { key: 'ArrowRight' });
      expect(el(w, 'ahx-strip-chip-1').attributes('data-selected')).toBe('true');
      await el(w, 'ahx-strip-chip-1').trigger('keydown', { key: 'End' });
      expect(el(w, 'ahx-strip-chip-2').attributes('data-selected')).toBe('true');
      await el(w, 'ahx-strip-chip-2').trigger('keydown', { key: 'ArrowRight' });
      expect(el(w, 'ahx-strip-chip-2').attributes('data-selected')).toBe('true'); // stops at the end
      await el(w, 'ahx-strip-chip-2').trigger('keydown', { key: 'Home' });
      expect(el(w, 'ahx-strip-chip-0').attributes('data-selected')).toBe('true');
    });

    it('the strip follows an edit made in the table, and a removed selected row is deselected', async () => {
      const w = await mountEditor(2);
      await el(w, 'ahx-plist-0-waveform').setValue('4');
      expect(el(w, 'ahx-strip-chip-0').text()).toContain('Noise');
      await el(w, 'ahx-strip-chip-2').trigger('click');
      await el(w, 'ahx-plist-remove-2').trigger('click');
      expect(w.findAll('[data-testid^="ahx-strip-chip-"]')).toHaveLength(2);
      expect(w.findAll('[data-selected="true"]')).toHaveLength(0);
    });
  });

  describe('E15: plain-language tooltips', () => {
    const titled = (node: Element): string => node.closest('[title]')?.getAttribute('title') || node.getAttribute('aria-label') || '';

    it('the square, filter, vibrato, hard-cut, volume and speed fields all say what they do to the sound', async () => {
      const w = await mountEditor(2);
      const expectations: Record<string, RegExp> = {
        'ahx-field-squareLowerLimit': /thinnest.*square wave/i,
        'ahx-field-squareUpperLimit': /fattest/i,
        'ahx-field-squareSpeed': /slowly.*square wave/i,
        'ahx-field-filterLowerLimit': /softest.*muffled/i,
        'ahx-field-filterUpperLimit': /brightest/i,
        'ahx-field-filterSpeed': /slowly.*brightness/i,
        'ahx-field-vibratoDelay': /steady before the pitch/i,
        'ahx-field-vibratoSpeed': /wobbles/i,
        'ahx-field-vibratoDepth': /wobbles/i,
        'ahx-field-hardCutRelease': /fade out/i,
        'ahx-field-hardCutReleaseFrames': /before the next note/i,
        'ahx-field-volume': /how loud/i,
        'ahx-plist-speed': /tick/i,
        'ahx-plist-0-fixed': /fixed pitch/i,
        'ahx-plist-0-waveform': /triangle is soft/i,
        'ahx-env-aFrames': /rise from silence/i,
      };
      for (const [testid, pattern] of Object.entries(expectations)) {
        const node = el(w, testid).element;
        expect(titled(node), testid).toMatch(pattern);
      }
      // row 0 of #6 has a free slot, so its brightness position is settable and says what it is
      const free = await mountEditor(6);
      expect(titled(el(free, 'ahx-start-filter').element)).toMatch(/brightness sits/i);
      // the slider's own track carries it too, not only the typed field
      expect(titled(el(w, 'ahx-field-squareSpeed-slider').element)).toMatch(/slowly/i);
    });

    it('EVERY control on the page has a tooltip or an accessible name', async () => {
      const w = await mountEditor(2);
      const controls = [...document.body.querySelectorAll('.ahx-body input, .ahx-body select, .ahx-body button')].filter(
        // the audition bar (its own titles are pinned by the KBD-MIDI tests) and the piano keys
        (node) => !node.closest('[data-testid="ahx-audition"]'),
      );
      expect(controls.length).toBeGreaterThan(60);
      const bare = controls.filter((node) => titled(node) === '').map((n) => n.getAttribute('data-testid') ?? n.outerHTML.slice(0, 80));
      expect(bare).toEqual([]);
      w.unmount();
    });

    it('every PList command select carries a plain-language tooltip that follows its value', async () => {
      const w = await mountEditor(2);
      expect(el(w, 'ahx-plist-0-fx0').attributes('title')).toMatch(/Set pulse width/);
      expect(el(w, 'ahx-plist-0-fx1').attributes('title')).toMatch(/Pulse \+ brightness sweeps on\/off/);
      await el(w, 'ahx-plist-0-fx0').setValue('15');
      expect(el(w, 'ahx-plist-0-fx0').attributes('title')).toMatch(/Set step speed/);
      expect(el(w, 'ahx-plist-0-param0').attributes('title')).toMatch(/ticks/);
      expect(el(w, 'ahx-plist-0-param1').attributes('title')).toMatch(/Which sweeps/);
    });
  });
});
