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
    setAhxPreviewScopeEnabled: () => undefined,
    getAhxPreviewWaveform: () => null,
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
import { ahxPListPlayhead, clearAhxPListPlayhead } from 'src/audio/tracker/ahx-plist-playhead';

/**
 * T7 at the page: the engine's PList row for the sounding preview note reaches
 * the canvas's playing-row pill and the table's `data-playing`, for this slot's
 * instrument only, and only for a row the list still has. The canvas is the
 * recording stand-in (pixels are the browser check).
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
const playing = (w: Wrapper): number[] =>
  w
    .findAll('[data-testid^="ahx-plist-row-"]')
    .filter((r) => r.attributes('data-playing') === 'true')
    .map((r) => Number(r.attributes('data-testid')!.replace('ahx-plist-row-', '')));

describe('AhxInstrumentPage: the PList playhead (B4)', () => {
  let store: ReturnType<typeof useTrackerStore>;
  const ins = () => store.instrumentSlots.find((s) => s.slot === 1)!.ahxData!;
  const rows = () => ins().plist.entries.length;
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    setActivePinia(createPinia());
    stubLog.trackChanges = 0;
    scrollIntoView.mockClear();
    Element.prototype.scrollIntoView = scrollIntoView;
    clearAhxPListPlayhead();
    store = useTrackerStore();
    store.loadSongFile(importAhxToTrackerSong(karma()));
    setCurrentAhxSource(new Uint8Array(karma()));
  });
  afterEach(() => {
    clearAhxPListPlayhead();
    setCurrentAhxSource(null);
    document.body.innerHTML = '';
  });

  it('has no playhead until the engine reports one: no pill, no marked row', async () => {
    const w = await mountEditor(1);
    const canvas = el(w, 'ahx-plist-canvas');
    expect(canvas.attributes('data-playhead-row')).toBe('-1');
    expect(canvas.attributes('data-playing')).toBe('false');
    expect(playing(w)).toEqual([]);
    const props = w.findComponent(PatternCanvas).props();
    expect(props.playbackRow).toBe(-1);
    expect(props.isPlaying).toBe(false);
    w.unmount();
  });

  it('a row reported for this slot’s instrument is the canvas’s pill and the table’s playing row, and nothing else', async () => {
    expect(rows()).toBeGreaterThanOrEqual(3);
    const w = await mountEditor(1);
    ahxPListPlayhead.value = { instrument: 1, row: 2 };
    await nextTick();
    const canvas = el(w, 'ahx-plist-canvas');
    expect(canvas.attributes('data-playhead-row')).toBe('2');
    expect(canvas.attributes('data-playing')).toBe('true');
    expect(playing(w)).toEqual([2]);
    expect(el(w, 'ahx-plist-row-2').classes()).toContain('ahx-row--playing');
    expect(el(w, 'ahx-plist-row-1').classes()).not.toContain('ahx-row--playing');
    const props = w.findComponent(PatternCanvas).props();
    expect(props.playbackRow).toBe(2);
    expect(props.isPlaying).toBe(true);
    // The trail is off, the pill follows the row (auto-scroll), and the playhead is not the selection.
    expect(props.showTrail).toBe(false);
    expect(props.autoScroll).toBe(true);
    expect(canvas.attributes('data-selected-row')).toBe('-1');
    expect(el(w, 'ahx-plist-row-2').attributes('data-selected')).toBe('false');
    w.unmount();
  });

  it('follows the engine down the list and back up (a Jump)', async () => {
    const w = await mountEditor(1);
    const seen: string[] = [];
    for (const row of [0, 1, 2, 1, 0]) {
      ahxPListPlayhead.value = { instrument: 1, row };
      await nextTick();
      seen.push(el(w, 'ahx-plist-canvas').attributes('data-playhead-row')!);
      expect(playing(w)).toEqual([row]);
    }
    expect(seen).toEqual(['0', '1', '2', '1', '0']);
    w.unmount();
  });

  it('a row of another instrument is not this list’s playhead (the stamp comes from the engine)', async () => {
    const w = await mountEditor(1);
    ahxPListPlayhead.value = { instrument: 2, row: 1 };
    await nextTick();
    expect(el(w, 'ahx-plist-canvas').attributes('data-playhead-row')).toBe('-1');
    expect(playing(w)).toEqual([]);
    expect(w.findComponent(PatternCanvas).props().isPlaying).toBe(false);
    w.unmount();
  });

  it('a row the list does not have (it was shortened under the note) is no playhead, in the canvas and the table', async () => {
    const w = await mountEditor(1);
    ahxPListPlayhead.value = { instrument: 1, row: rows() };
    await nextTick();
    expect(el(w, 'ahx-plist-canvas').attributes('data-playhead-row')).toBe('-1');
    expect(playing(w)).toEqual([]);
    w.unmount();
  });

  it('removing the row the note is on drops the pill at once, with no row left to mark', async () => {
    const w = await mountEditor(1);
    const last = rows() - 1;
    ahxPListPlayhead.value = { instrument: 1, row: last };
    await nextTick();
    expect(playing(w)).toEqual([last]);
    await el(w, `ahx-plist-remove-${last}`).trigger('click');
    expect(el(w, 'ahx-plist-canvas').attributes('data-playhead-row')).toBe('-1');
    expect(playing(w)).toEqual([]);
    expect(w.findComponent(PatternCanvas).props().isPlaying).toBe(false);
    w.unmount();
  });

  it('clears when the engine says nothing sounds', async () => {
    const w = await mountEditor(1);
    ahxPListPlayhead.value = { instrument: 1, row: 1 };
    await nextTick();
    expect(playing(w)).toEqual([1]);
    clearAhxPListPlayhead();
    await nextTick();
    expect(el(w, 'ahx-plist-canvas').attributes('data-playhead-row')).toBe('-1');
    expect(el(w, 'ahx-plist-canvas').attributes('data-playing')).toBe('false');
    expect(playing(w)).toEqual([]);
    w.unmount();
  });

  it('moving the playhead repaints nothing static, and does not scroll the table or move the selection', async () => {
    const w = await mountEditor(1);
    await nextTick();
    const changes = stubLog.trackChanges;
    for (let row = 0; row < rows(); row += 1) {
      ahxPListPlayhead.value = { instrument: 1, row };
      await nextTick();
    }
    expect(stubLog.trackChanges).toBe(changes);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(el(w, 'ahx-plist-canvas').attributes('data-selected-row')).toBe('-1');
    w.unmount();
  });

  it('a selection made by hand is not moved by the playhead, and both show at once', async () => {
    const w = await mountEditor(1);
    await el(w, 'ahx-plist-row-0').trigger('focusin');
    ahxPListPlayhead.value = { instrument: 1, row: 2 };
    await nextTick();
    expect(el(w, 'ahx-plist-row-0').attributes('data-selected')).toBe('true');
    expect(el(w, 'ahx-plist-row-2').attributes('data-playing')).toBe('true');
    expect(el(w, 'ahx-plist-row-2').attributes('data-selected')).toBe('false');
    w.unmount();
  });

  describe('the caption (only true statements)', () => {
    it('explains the bar when a note can sound here', async () => {
      const w = await mountEditor(1);
      const line = w.find('[data-testid="ahx-plist-canvas-caption-playhead"]');
      expect(line.exists()).toBe(true);
      expect(line.text()).toContain('the bar shows the step its note is on');
      expect(line.text()).toContain('passed over');
      w.unmount();
    });

    it('says nothing of a bar when there is no song to play from (the page already says edits are not audible)', async () => {
      setCurrentAhxSource(null);
      const w = await mountEditor(1);
      expect(w.find('[data-testid="ahx-plist-canvas-caption-playhead"]').exists()).toBe(false);
      // The selection line stays: it is true either way.
      expect(el(w, 'ahx-plist-canvas-caption').text()).toContain('Click a row to select it');
      expect(w.find('[data-testid="ahx-source-missing"]').exists()).toBe(true);
      w.unmount();
    });

    it('never claims looping, seeking or a time', async () => {
      const w = await mountEditor(1);
      const text = el(w, 'ahx-plist-canvas-caption').text().toLowerCase();
      expect(text).not.toMatch(/loop|seek|jump to|\bms\b|milli/);
      w.unmount();
    });
  });
});
