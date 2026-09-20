import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { parseAhx } from '@another-synth/tracker-playback';
import { useTrackerStore } from 'src/stores/tracker-store';
import { importAhxToTrackerSong } from 'src/audio/tracker/ahx-import';
import { ahxSourceInfoOf, setCurrentAhxSource, snapshotEditorSong } from 'src/audio/tracker/ahx-source';
import { ahxExporter } from 'src/audio/tracker/song-export';
import {
  useTrackerInstruments,
  type TrackerInstrumentsContext,
} from 'src/composables/useTrackerInstruments';

const bytes = new Uint8Array(
  readFileSync(resolve(__dirname, '../../public/demos/ahx/64k_is_all_you_need.ahx'))
);

describe('committing an instrument rename from the slot list', () => {
  let store: ReturnType<typeof useTrackerStore>;
  let instruments: ReturnType<typeof useTrackerInstruments>;

  beforeEach(() => {
    setActivePinia(createPinia());
    store = useTrackerStore();
    store.loadSongFile(importAhxToTrackerSong(bytes.slice().buffer));
    setCurrentAhxSource(bytes.slice(), ahxSourceInfoOf(bytes));
    instruments = useTrackerInstruments({ trackerStore: store } as unknown as TrackerInstrumentsContext);
  });

  const exportNow = () => ahxExporter.serialize(snapshotEditorSong(store));

  it('an unchanged draft (Enter or blur without typing) is a no-op: no history entry, exported bytes unchanged', () => {
    const slot = store.instrumentSlots[3]!;
    expect(parseAhx(bytes).instruments[4]!.name).toBe('');
    expect(instruments.getInstrumentDisplayName(slot)).toBe('Instrument 04');
    const pushHistory = vi.spyOn(store, 'pushHistory');

    instruments.beginInstrumentRename(slot);
    expect(instruments.instrumentNameDraft.value).toBe('Instrument 04');
    instruments.commitInstrumentRename(slot.slot);

    expect(instruments.instrumentNameEditSlot.value).toBeNull();
    expect(pushHistory).not.toHaveBeenCalled();
    expect(exportNow()).toEqual(bytes);
  });

  it('a changed draft is a rename: it reaches the exported file', () => {
    const slot = store.instrumentSlots[3]!;
    const pushHistory = vi.spyOn(store, 'pushHistory');
    instruments.beginInstrumentRename(slot);
    instruments.instrumentNameDraft.value = 'Bass';
    instruments.commitInstrumentRename(slot.slot);

    expect(pushHistory).toHaveBeenCalledTimes(1);
    expect(parseAhx(exportNow()).instruments[4]!.name).toBe('Bass');
  });
});
