import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import {
  useTrackerStore,
  CURRENT_SONG_FILE_VERSION,
  type TrackerSongFile,
  type InstrumentSlot,
} from 'src/stores/tracker-store';

function makeSlots(overrides: Partial<InstrumentSlot>[] = []): InstrumentSlot[] {
  return overrides.map((o, idx) => ({
    slot: idx + 1,
    bankName: '',
    patchName: '',
    instrumentName: '',
    ...o,
  }));
}

function makeSongFile(
  version: TrackerSongFile['version'],
  data: Partial<TrackerSongFile['data']>,
): TrackerSongFile {
  return {
    version,
    data: {
      currentSong: { title: 'T', author: 'A', bpm: 120 },
      patternRows: 64,
      stepSize: 1,
      patterns: [],
      sequence: [],
      currentPatternId: null,
      instrumentSlots: [],
      activeInstrumentId: null,
      currentInstrumentPage: 0,
      songPatches: {},
      ...data,
    },
  };
}

describe('tracker store moduleFormat', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('defaults a new song to native', () => {
    const store = useTrackerStore();
    expect(store.moduleFormat).toBe('native');
  });

  it('round-trips the tag through serialize/load at the current version', () => {
    const store = useTrackerStore();
    store.moduleFormat = 'xm';

    const file = store.serializeSong();
    expect(file.version).toBe(CURRENT_SONG_FILE_VERSION);
    expect(file.data.moduleFormat).toBe('xm');

    store.resetToNewSong();
    expect(store.moduleFormat).toBe('native');

    store.loadSongFile(file);
    expect(store.moduleFormat).toBe('xm');
  });

  it('infers protracker for a v1 file carrying MOD instruments', () => {
    const store = useTrackerStore();
    store.loadSongFile(
      makeSongFile(1, {
        instrumentSlots: makeSlots([{ instrumentType: 'mod', patchId: 'p1' }]),
      }),
    );
    expect(store.moduleFormat).toBe('protracker');
  });

  it('infers native for a v1 file with no MOD instruments', () => {
    // Legacy hand-authored songs must not inherit ProTracker quirks.
    const store = useTrackerStore();
    store.loadSongFile(
      makeSongFile(1, {
        instrumentSlots: makeSlots([{ instrumentType: 'synth', patchId: 'p1' }]),
      }),
    );
    expect(store.moduleFormat).toBe('native');
  });

  it('restores the tag through undo history', () => {
    const store = useTrackerStore();
    store.moduleFormat = 'protracker';
    store.pushHistory();
    store.moduleFormat = 'xm';
    store.undo();
    expect(store.moduleFormat).toBe('protracker');
  });
});
