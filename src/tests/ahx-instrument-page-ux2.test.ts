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

import AhxInstrumentPage from 'pages/AhxInstrumentPage.vue';
import AhxAuditionBar from 'src/components/ahx/AhxAuditionBar.vue';
import { useTrackerStore } from 'src/stores/tracker-store';
import { importAhxToTrackerSong } from 'src/audio/tracker/ahx-import';
import { setCurrentAhxSource } from 'src/audio/tracker/ahx-source';
import { ahxPreviewOutputNode } from 'src/audio/tracker/ahx-preview-output';

/**
 * UX pass 2 (`.ai/plan-ahx-ux2.md`): the sticky sound band (U1), the tone card
 * first (U2), the On/Off pills that agree with the lanes (U3), the labelled
 * note-ending sub-group (U4), the envelope's typed values behind a toggle (U5)
 * and the PList explainer (U6). Real song, real importer, real store; only the
 * playback store's two preview calls are stubbed, as in every page suite.
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
  return mount(AhxInstrumentPage, {
    attachTo: document.body,
    global: { plugins: [router], stubs: { QPage: { template: '<div><slot /></div>' }, QIcon: true, QBtn: true } },
  });
}
type Wrapper = Awaited<ReturnType<typeof mountEditor>>;
const el = (w: Wrapper, testid: string) => w.get(`[data-testid="${testid}"]`);
const has = (w: Wrapper, testid: string) => w.find(`[data-testid="${testid}"]`).exists();

/** A stand-in AudioNode with enough surface for both analyzer components to attach without throwing. */
function fakeAudioNode(): AudioNode {
  const analyser = {
    fftSize: 0,
    smoothingTimeConstant: 0,
    frequencyBinCount: 128,
    connect: () => undefined,
    disconnect: () => undefined,
    getByteTimeDomainData: () => undefined,
    getByteFrequencyData: () => undefined,
  };
  const splitter = { connect: () => undefined, disconnect: () => undefined };
  return {
    context: { createAnalyser: () => ({ ...analyser }), createChannelSplitter: () => ({ ...splitter }) },
    connect: () => undefined,
    disconnect: () => undefined,
    numberOfOutputs: 1,
  } as unknown as AudioNode;
}

describe('AhxInstrumentPage, UX pass 2', () => {
  let store: ReturnType<typeof useTrackerStore>;
  const ins = (slot = 1) => store.instrumentSlots.find((s) => s.slot === slot)!.ahxData!;

  beforeEach(() => {
    setActivePinia(createPinia());
    ahxPreviewOutputNode.value = null;
    store = useTrackerStore();
    store.loadSongFile(importAhxToTrackerSong(karma()));
    setCurrentAhxSource(new Uint8Array(karma()));
  });
  afterEach(() => {
    document.body.innerHTML = '';
    ahxPreviewOutputNode.value = null;
  });

  describe('U1: the sound band', () => {
    it('holds the audition bar and the analyzer, above and outside the two-zone grid', async () => {
      const w = await mountEditor(1);
      const band = el(w, 'ahx-sound-band');
      expect(band.findComponent(AhxAuditionBar).exists()).toBe(true);
      expect(band.find('[data-testid="ahx-analyzer-row"]').exists()).toBe(true);
      const body = w.get('.ahx-body').element;
      // Not inside the grid (its sticky box would be held to a grid area), and before it.
      expect(body.contains(band.element)).toBe(false);
      expect(band.element.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(band.classes()).toContain('ahx-sound-band');
      w.unmount();
    });

    it('names the two analyzer boxes, and says to play a note until the preview output exists', async () => {
      const w = await mountEditor(1);
      expect(el(w, 'ahx-analyzer-caption-wave').text()).toBe('Wave');
      expect(el(w, 'ahx-analyzer-caption-spectrum').text()).toBe('Spectrum');
      expect(el(w, 'ahx-analyzer-idle').text()).toBe('Play a note to see it here.');
      ahxPreviewOutputNode.value = fakeAudioNode();
      await nextTick();
      expect(has(w, 'ahx-analyzer-idle')).toBe(false);
      ahxPreviewOutputNode.value = null;
      await nextTick();
      expect(has(w, 'ahx-analyzer-idle')).toBe(true);
      w.unmount();
    });

    it('with no source file the band keeps the bar and says the analyzer is unavailable, with no idle line', async () => {
      setCurrentAhxSource(null);
      const w = await mountEditor(1);
      const band = el(w, 'ahx-sound-band');
      expect(band.find('[data-testid="ahx-analyzer-off"]').exists()).toBe(true);
      expect(has(w, 'ahx-analyzer-idle')).toBe(false);
      w.unmount();
    });
  });

  describe('U2: the tone beside Level & wave', () => {
    it('the right column starts with the tone card, then the envelope, with honest labels', async () => {
      const w = await mountEditor(1);
      const cards = w.get('.ahx-right').findAll(':scope > section');
      expect(cards.map((c) => c.attributes('data-testid'))).toEqual(['ahx-card-tone', 'ahx-card-envelope']);
      expect(el(w, 'ahx-card-tone').get('h3').text()).toBe('Starting tone');
      expect(el(w, 'ahx-card-tone').text()).toContain('Starting brightness');
      expect(w.text()).not.toContain('Filter position');
      // The preview it redraws is in that card.
      expect(el(w, 'ahx-card-tone').find('[data-testid="ahx-wave-shape"]').exists()).toBe(true);
      w.unmount();
    });
  });

  describe('U3: the On/Off pills', () => {
    it('every group has a one-line intro, and the pills sit outside the legends', async () => {
      const w = await mountEditor(1);
      for (const id of ['level', 'vibrato', 'square', 'filter']) expect(has(w, `ahx-group-intro-${id}`)).toBe(true);
      for (const legend of w.findAll('legend')) expect(legend.find('.ahx-status').exists()).toBe(false);
      w.unmount();
    });

    it('agree with the sweep lanes on every instrument of the song', async () => {
      const slots = store.instrumentSlots.filter((s) => s.ahxData).map((s) => s.slot);
      expect(slots.length).toBeGreaterThan(3);
      const seen = new Set<string>();
      for (const slot of slots) {
        const w = await mountEditor(slot);
        for (const kind of ['square', 'filter']) {
          const state = el(w, `ahx-sweep-lane-${kind}`).attributes('data-state');
          seen.add(`${kind}:${state === 'on'}`);
          expect(el(w, `ahx-status-${kind}`).text(), `slot ${slot} ${kind}`).toBe(state === 'on' ? 'On' : 'Off');
        }
        w.unmount();
      }
      // The song exercises both pill states, so the agreement is not vacuous.
      expect(seen.has('filter:true') && seen.has('filter:false')).toBe(true);
    });

    it('vibrato: on for a real vibrato, off at depth 0 and at a speed that does not move', async () => {
      const w = await mountEditor(1); // vibrato 17 / 8 / 2
      expect(el(w, 'ahx-status-vibrato').text()).toBe('On');
      await el(w, 'ahx-field-vibratoSpeed').setValue('32');
      expect(el(w, 'ahx-status-vibrato').text()).toBe('Off');
      await el(w, 'ahx-field-vibratoSpeed').setValue('8');
      expect(el(w, 'ahx-status-vibrato').text()).toBe('On');
      await el(w, 'ahx-field-vibratoDepth').setValue('0');
      expect(ins().vibratoDepth).toBe(0);
      expect(el(w, 'ahx-status-vibrato').text()).toBe('Off');
      expect(el(w, 'ahx-status-vibrato').attributes('title')).toMatch(/depth is 0/);
      w.unmount();
    });

    it('"Turn on at row 0" flips the pill with the lane, and the Off title says where the button is', async () => {
      const w = await mountEditor(6); // no sweep command at all
      for (const kind of ['filter', 'square']) {
        expect(el(w, `ahx-status-${kind}`).text()).toBe('Off');
        expect(el(w, `ahx-status-${kind}`).attributes('title')).toMatch(/do nothing yet.*button below/);
        expect(el(w, `ahx-status-${kind}`).classes()).not.toContain('ahx-status--on');
      }
      await el(w, 'ahx-sweep-enable-filter').trigger('click');
      expect(el(w, 'ahx-status-filter').text()).toBe('On');
      expect(el(w, 'ahx-status-filter').classes()).toContain('ahx-status--on');
      await el(w, 'ahx-sweep-enable-square').trigger('click');
      expect(ins(6).plist.entries[0]!.waveform).toBe(3);
      expect(el(w, 'ahx-status-square').text()).toBe('On');
      w.unmount();
    });
  });

  describe('U4: the note-ending sub-group', () => {
    it('holds exactly the two hard-cut controls, inside the Filter fieldset, after the filter lane', async () => {
      const w = await mountEditor(1);
      const filter = w.findAll('fieldset')[3]!;
      expect(filter.get('legend').text()).toBe('Filter');
      const sub = filter.get('[data-testid="ahx-subgroup-note-ending"]');
      expect(sub.get('h4').text()).toBe('Note ending (hard cut)');
      expect(sub.text()).toContain('Not a filter setting');
      expect(sub.find('[data-testid="ahx-field-hardCutRelease"]').exists()).toBe(true);
      expect(sub.find('[data-testid="ahx-field-hardCutReleaseFrames"]').exists()).toBe(true);
      expect(sub.find('[data-testid^="ahx-field-filter"]').exists()).toBe(false);
      const lane = filter.get('[data-testid="ahx-sweep-lane-filter"]').element;
      expect(lane.compareDocumentPosition(sub.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      w.unmount();
    });
  });

  describe('U5: the envelope typed values behind a toggle', () => {
    it('says how to use the graph, starts with the table hidden, and the toggle reveals it', async () => {
      const w = await mountEditor(1);
      expect(el(w, 'ahx-envelope-howto').text()).toMatch(/Drag a dot.*double-click a dot/);
      const toggle = el(w, 'ahx-envelope-table-toggle');
      const table = el(w, 'ahx-envelope-table').element as HTMLElement;
      expect(toggle.attributes('aria-expanded')).toBe('false');
      expect(toggle.text()).toBe('Type exact values');
      expect(table.style.display).toBe('none');
      await toggle.trigger('click');
      expect(el(w, 'ahx-envelope-table-toggle').attributes('aria-expanded')).toBe('true');
      expect(el(w, 'ahx-envelope-table-toggle').text()).toBe('Hide exact values');
      expect(table.style.display).not.toBe('none');
      w.unmount();
    });

    it('a node double-click opens the table from hidden and focuses the stage field', async () => {
      const w = await mountEditor(1);
      const table = el(w, 'ahx-envelope-table').element as HTMLElement;
      expect(table.style.display).toBe('none');
      await el(w, 'ahx-env-node-D').trigger('dblclick');
      await nextTick();
      await nextTick();
      expect(el(w, 'ahx-envelope-table-toggle').attributes('aria-expanded')).toBe('true');
      expect(table.style.display).not.toBe('none');
      expect((document.activeElement as HTMLElement | null)?.getAttribute('data-testid')).toBe('ahx-env-dFrames');
      w.unmount();
    });

    it('a typed value still commits through the (hidden) table', async () => {
      const w = await mountEditor(1);
      await el(w, 'ahx-env-rFrames').setValue('9');
      expect(ins().envelope.rFrames).toBe(9);
      w.unmount();
    });
  });

  describe('U6: the PList explains itself', () => {
    it('one plain line under the heading; the summary is unchanged', async () => {
      const w = await mountEditor(1);
      expect(el(w, 'ahx-plist-intro').text()).toMatch(/little score.*steps down these rows/);
      expect(el(w, 'ahx-plist-summary').text()).toContain(`${ins().plist.entries.length} rows`);
      w.unmount();
    });
  });
});
