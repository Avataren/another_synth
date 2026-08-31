import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import {
  useTrackerStore,
  type InstrumentSlot,
} from 'src/stores/tracker-store';
import {
  formatInstrumentId,
  normalizeInstrumentId,
  pickActiveInstrumentId,
} from 'src/audio/tracker/instrument-ids';

/**
 * The jukebox plays its playlist through the one tracker store the editor
 * uses, so it hands the editor's song back on the way out by serialising it on
 * the way in. That contract is only as good as the round trip.
 */
describe('the editor song survives a jukebox visit', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('comes back with its title, patterns and slots after another song', () => {
    const store = useTrackerStore();
    store.initializeIfNeeded();

    store.currentSong.title = 'Work in progress';
    store.currentSong.author = 'Me';
    store.currentSong.bpm = 137;
    const editedPatternId = store.createPattern();
    store.addPatternToSequence(editedPatternId);
    const editorTrackCount = store.patterns[0]?.tracks.length ?? 0;
    const editorPatternCount = store.patterns.length;

    // What the jukebox keeps hold of while it plays.
    const snapshot = store.serializeSong();

    // A playlist entry lands on top of it: a different song entirely.
    store.resetToNewSong();
    store.currentSong.title = 'some demo module';
    expect(store.patterns.length).toBe(1);

    // Leaving the jukebox puts the editor's song back.
    store.loadSongFile(snapshot);

    expect(store.currentSong.title).toBe('Work in progress');
    expect(store.currentSong.author).toBe('Me');
    expect(store.currentSong.bpm).toBe(137);
    expect(store.patterns.length).toBe(editorPatternCount);
    expect(store.patterns[0]?.tracks.length).toBe(editorTrackCount);
    expect(store.sequence).toContain(editedPatternId);
  });

  it('is not disturbed by the snapshot being taken', () => {
    const store = useTrackerStore();
    store.initializeIfNeeded();
    store.currentSong.title = 'Untouched';

    const snapshot = store.serializeSong();
    snapshot.data.currentSong.title = 'Mutated copy';
    snapshot.data.patterns.length = 0;

    expect(store.currentSong.title).toBe('Untouched');
    expect(store.patterns.length).toBeGreaterThan(0);
  });
});

describe('instrument ids', () => {
  it('pads slot numbers to the form pattern data uses', () => {
    expect(formatInstrumentId(1)).toBe('01');
    expect(formatInstrumentId(31)).toBe('31');
    expect(normalizeInstrumentId('7')).toBe('07');
    expect(normalizeInstrumentId('07')).toBe('07');
    expect(normalizeInstrumentId(undefined)).toBeUndefined();
    // A name is not a slot number and is left alone.
    expect(normalizeInstrumentId('bassdrum')).toBe('bassdrum');
  });

  it('keeps the current instrument while it still has a patch', () => {
    const slot = (n: number, patchId?: string): InstrumentSlot => ({
      slot: n,
      bankName: '',
      patchName: '',
      instrumentName: '',
      ...(patchId ? { patchId } : {}),
    });
    const slots = [slot(1), slot(2, 'a'), slot(3, 'b')];

    expect(pickActiveInstrumentId(slots, '03')).toBe('03');
    // The selected slot lost its patch: fall back to the first that has one.
    expect(pickActiveInstrumentId(slots, '01')).toBe('02');
    expect(pickActiveInstrumentId(slots, null)).toBe('02');
    expect(pickActiveInstrumentId([], '02')).toBeNull();
  });
});
