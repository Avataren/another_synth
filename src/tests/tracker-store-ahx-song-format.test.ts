import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { setCurrentAhxSource } from 'src/audio/tracker/ahx-source';
import type { AhxDoc } from 'src/audio/tracker/ahx-doc';
import { songTrackColumns, trackColumns } from 'src/components/tracker/track-metrics';
import { useTrackerStore } from 'src/stores/tracker-store';

/**
 * `ahxSongFormat` says whether an AHX song is AHX or HVL with or without a
 * doc. A song played without one (an HVL wider than the engine's 16 channels)
 * still has its bytes' header, and its rows still carry HVL's second effect:
 * the pattern grid must show that column whatever the Dual FX preference.
 */

const header = (magic: string): Uint8Array =>
  new Uint8Array([...magic].map((c) => c.charCodeAt(0)).concat([1, 0, 0, 0, 0]));

beforeEach(() => {
  setActivePinia(createPinia());
  setCurrentAhxSource(null);
});
afterEach(() => setCurrentAhxSource(null));

describe('trackerStore.ahxSongFormat', () => {
  it('is null for a song that is not AHX, whatever bytes are current', () => {
    const store = useTrackerStore();
    setCurrentAhxSource(header('HVL'));
    expect(store.ahxSongFormat).toBeNull();
  });

  it('reads the header of a doc-less song, and the doc over it', () => {
    const store = useTrackerStore();
    store.moduleFormat = 'ahx';
    expect(store.ahxSongFormat).toBeNull();

    setCurrentAhxSource(header('HVL'));
    expect(store.ahxSongFormat).toBe('hvl');
    setCurrentAhxSource(header('THX'));
    expect(store.ahxSongFormat).toBe('ahx');

    store.ahxDoc = { format: 'hvl' } as unknown as AhxDoc;
    expect(store.ahxSongFormat).toBe('hvl');
  });

  it('gives a doc-less HVL song its second effect column with the preference off', () => {
    const store = useTrackerStore();
    store.moduleFormat = 'ahx';
    setCurrentAhxSource(header('HVL'));
    expect(songTrackColumns(store.moduleFormat, store.ahxSongFormat, false)).toBe(trackColumns(false, true));
  });
});
