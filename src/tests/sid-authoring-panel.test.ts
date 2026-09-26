import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useTrackerStore } from 'src/stores/tracker-store';
import { ahxEditNotice, clearAhxEditNotice } from 'src/audio/tracker/ahx-edit-notice';
import { SID_MAX_INSTRUMENTS, createNewSidDoc, decodeSidFile, encodeSidFile } from 'src/audio/tracker/sid-doc';
import { sidGridHarness as harness } from './helpers/sid-grid-harness';

/**
 * Making a SID song from the tracker page (plan-sid-authoring.md): the
 * instrument panel adds instruments and renames them in the doc, and a note
 * typed into the grid is heard on the song's own instrument.
 */

beforeEach(() => {
  setActivePinia(createPinia());
  clearAhxEditNotice();
});
afterEach(() => clearAhxEditNotice());

const newSong = () => {
  const store = useTrackerStore();
  store.resetToNewSidSong({});
  return store;
};

describe('the instrument panel of a SID song', () => {
  it('adds an instrument at the end, with its own wave and pulse rows, as one undo step', () => {
    const store = newSong();
    const before = store.sidDoc!;
    expect(before.instruments).toHaveLength(1);
    expect(store.addSidInstrument()).toBe(2);
    const doc = store.sidDoc!;
    expect(doc.instruments).toHaveLength(2);
    expect(doc.instruments[1]!.wavePtr).toBe(before.tables.wave.length + 1);
    expect(doc.instruments[1]!.pulsePtr).toBe(before.tables.pulse.length + 1);
    expect(store.instrumentSlots[1]!.instrumentFormat).toBe('sid');
    store.undo();
    expect(store.sidDoc).toBe(before);
  });

  it('refuses a 64th instrument, saying why', () => {
    const store = newSong();
    for (let n = 2; n <= SID_MAX_INSTRUMENTS; n++) expect(store.addSidInstrument()).toBe(n);
    const full = store.sidDoc;
    expect(store.addSidInstrument()).toBeNull();
    expect(store.sidDoc).toBe(full);
    expect(ahxEditNotice.value?.message).toBeTruthy();
  });

  it('a rename is the doc instrument\'s name (cut to 16 characters), so the save keeps it', () => {
    const store = newSong();
    store.addSidInstrument();
    store.pushHistory();
    store.setInstrumentName(2, '  Fat bass with a long name ');
    expect(store.sidDoc!.instruments[1]!.name).toBe('Fat bass with a ');
    expect(store.instrumentSlots[1]!.instrumentName).toBe('Fat bass with a ');
    const saved = decodeSidFile(encodeSidFile(store.sidDoc!));
    expect(saved.ok && saved.doc.instruments[1]!.name).toBe('Fat bass with a ');
  });

  it('a name the doc cannot hold is refused and the slot keeps its old one', () => {
    const store = newSong();
    const doc = store.sidDoc;
    store.setInstrumentName(1, 'Bass ♫');
    expect(store.sidDoc).toBe(doc);
    expect(store.instrumentSlots[0]!.instrumentName).toBe('');
    expect(ahxEditNotice.value?.message).toMatch(/latin-1/);
  });
});

describe('a note typed into a SID song', () => {
  it('is written and sounds on the song\'s instrument through the preview hook', () => {
    const preview = vi.fn(() => true);
    const h = harness(createNewSidDoc({}), undefined, { previewSongInstrumentNote: preview });
    h.at(0, 0, 0);
    h.editing.handleNoteEntry(60);
    expect(h.flatRow(0, 0, 0).note).not.toBe(0);
    expect(preview).toHaveBeenCalledWith('01', 60, expect.any(Number));
  });
});
