import * as Vue from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { formatInstrumentId } from '@another-synth/tracker-playback';
import { AHX_MAX_INSTRUMENTS, fileInstruments } from 'src/audio/tracker/ahx-doc';
import { setCurrentAhxSource } from 'src/audio/tracker/ahx-source';
import { clearAhxEditNotice } from 'src/audio/tracker/ahx-edit-notice';
import { useTrackerInstruments, type TrackerInstrumentsContext } from 'src/composables/useTrackerInstruments';
import { setMobileLayoutForTest } from 'src/composables/useMobileLayout';
import { useTrackerStore } from 'src/stores/tracker-store';
import { mountInstrumentPanel } from './helpers/instrument-panel';

/**
 * In an AHX or HVL song the instrument list's slots are the song's own
 * instruments, filled in order: a slot takes a preset ("Load preset" on one
 * the song has, "Add from preset" on the next free one) and never a synth
 * patch. The empty slots past those used to show the synth-patch picker
 * ("Select patch"), which `assignPatchToSlot` refuses for such a song, after
 * `onPatchSelect` had already pushed an undo step. Now they show no picker, as
 * a SID song's do, and `onPatchSelect` refuses before any undo step.
 */

type Store = ReturnType<typeof useTrackerStore>;

/** The page's own `canPickAhxPresetAt` and preset bindings (TrackerPage.vue), over the real store. */
function ahxBindings(store: Store) {
  const count = Vue.computed(() => (store.ahxDoc === null ? 0 : fileInstruments(store.ahxDoc, store.instrumentSlots).length));
  return {
    ahxInstrumentCount: count,
    canPickAhxPresetAt: (slotNumber: number) => store.isAhxEditable && slotNumber <= Math.min(count.value + 1, AHX_MAX_INSTRUMENTS),
  };
}

/** Each row's picker, by its placeholder, or null for a row without one. */
function pickersOf(wrapper: ReturnType<typeof mountInstrumentPanel>): (string | null)[] {
  return wrapper.findAll('.instrument-row').map((row) => {
    const picker = row.find('.stub-PatchPicker');
    return picker.exists() ? (picker.attributes('placeholder') ?? '') : null;
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
  setCurrentAhxSource(null);
  clearAhxEditNotice();
  setMobileLayoutForTest(false);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('the instrument panel of an editable AHX/HVL song', () => {
  for (const format of ['ahx', 'hvl'] as const) {
    it(`${format}: the song's instruments load a preset, the next slot adds one, and the rest show no patch picker`, async () => {
      const store = useTrackerStore();
      store.resetToNewAhxSong(format);
      expect(store.addAhxPresetInstrument('bass-saw')).toBe(2);
      const wrapper = mountInstrumentPanel(null, ahxBindings(store));
      await Vue.nextTick();
      const pickers = pickersOf(wrapper);
      expect(pickers.slice(0, 3)).toEqual(['Load preset', 'Load preset', 'Add from preset']);
      expect(pickers.slice(3).length).toBeGreaterThan(0);
      expect(pickers.slice(3).every((p) => p === null)).toBe(true);
      expect(pickers).not.toContain('Select patch');
    });
  }

  it('a native song still offers a synth patch in every slot', async () => {
    const store = useTrackerStore();
    store.resetToNewSong();
    const wrapper = mountInstrumentPanel(null, ahxBindings(store));
    await Vue.nextTick();
    const pickers = pickersOf(wrapper);
    expect(pickers.length).toBeGreaterThan(0);
    expect(pickers.every((p) => p === 'Select patch')).toBe(true);
  });

  it('onPatchSelect in an AHX song changes nothing and leaves no undo step', async () => {
    const store = useTrackerStore();
    store.resetToNewAhxSong('ahx');
    const slotsBefore = JSON.stringify(store.instrumentSlots);
    const { onPatchSelect } = useTrackerInstruments({
      trackerStore: store,
      formatInstrumentId,
      ensureActiveInstrument: vi.fn(),
      setActiveInstrument: vi.fn(),
      syncSongBankFromSlots: vi.fn().mockResolvedValue(undefined),
    } as unknown as TrackerInstrumentsContext);
    // An empty id is the picker's "clear": it used to push history and then have the store refuse the clear.
    await onPatchSelect(3, '');
    await onPatchSelect(3, 'any-patch');
    expect(store.undoStack).toHaveLength(0);
    expect(JSON.stringify(store.instrumentSlots)).toBe(slotsBefore);
    expect(store.moduleFormat).toBe('ahx');
  });
});
