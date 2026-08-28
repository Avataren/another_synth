import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import {
  useTrackerStore,
  CURRENT_SONG_FILE_VERSION,
  DEFAULT_PATTERN_ROWS,
  MAX_PATTERN_ROWS,
  clampPatternRows,
  type TrackerSongFile,
} from 'src/stores/tracker-store';

function makeSongFile(
  version: TrackerSongFile['version'],
  data: Partial<TrackerSongFile['data']>,
): TrackerSongFile {
  return {
    version,
    data: {
      currentSong: { title: 'T', author: 'A', bpm: 120 },
      patternRows: DEFAULT_PATTERN_ROWS,
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

describe('clampPatternRows', () => {
  it('clamps to the FT2 range and rounds', () => {
    expect(clampPatternRows(0)).toBe(1);
    expect(clampPatternRows(-5)).toBe(1);
    expect(clampPatternRows(1000)).toBe(MAX_PATTERN_ROWS);
    expect(clampPatternRows(63.6)).toBe(64);
  });

  it('falls back to the default for non-finite input', () => {
    expect(clampPatternRows(undefined)).toBe(DEFAULT_PATTERN_ROWS);
    expect(clampPatternRows(NaN)).toBe(DEFAULT_PATTERN_ROWS);
  });
});

describe('per-pattern row counts', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('sets rows on only the targeted pattern', () => {
    const store = useTrackerStore();
    const firstId = store.patterns[0]!.id;
    const secondId = store.createPattern();

    store.setPatternRows(16, firstId);

    expect(store.rowsForPattern(firstId)).toBe(16);
    expect(store.rowsForPattern(secondId)).toBe(DEFAULT_PATTERN_ROWS);
  });

  it('defaults to the current pattern and seeds later patterns', () => {
    const store = useTrackerStore();
    const firstId = store.patterns[0]!.id;
    store.setCurrentPatternId(firstId);

    store.setPatternRows(32);
    expect(store.currentPatternRows).toBe(32);

    // A pattern created afterwards inherits the count the user just chose,
    // matching how the old song-level control behaved.
    const nextId = store.createPattern();
    expect(store.rowsForPattern(nextId)).toBe(32);
  });

  it('round-trips differing pattern lengths through save/load', () => {
    const store = useTrackerStore();
    const firstId = store.patterns[0]!.id;
    const secondId = store.createPattern();
    store.setPatternRows(16, firstId);
    store.setPatternRows(128, secondId);

    const file = store.serializeSong();
    expect(file.version).toBe(CURRENT_SONG_FILE_VERSION);

    store.resetToNewSong();
    store.loadSongFile(file);

    expect(store.rowsForPattern(firstId)).toBe(16);
    expect(store.rowsForPattern(secondId)).toBe(128);
  });

  it('backfills rows from the song-level value for pre-v3 files', () => {
    // v1/v2 patterns have no `rows`; every pattern took the song-level count.
    const store = useTrackerStore();
    store.loadSongFile(
      makeSongFile(2, {
        patternRows: 32,
        patterns: [
          { id: 'a', name: 'A', tracks: [] },
          { id: 'b', name: 'B', tracks: [] },
        ] as unknown as TrackerSongFile['data']['patterns'],
        sequence: ['a', 'b'],
        currentPatternId: 'a',
      }),
    );

    expect(store.rowsForPattern('a')).toBe(32);
    expect(store.rowsForPattern('b')).toBe(32);
    expect(store.defaultPatternRows).toBe(32);
  });

  it('restores per-pattern rows through undo', () => {
    const store = useTrackerStore();
    const firstId = store.patterns[0]!.id;
    store.setPatternRows(64, firstId);
    store.pushHistory();
    store.setPatternRows(8, firstId);
    store.undo();
    expect(store.rowsForPattern(firstId)).toBe(64);
  });
});
