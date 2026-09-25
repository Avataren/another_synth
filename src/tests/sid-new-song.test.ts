import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  BLANK_SID_ROW,
  DEFAULT_SID_INSTRUMENT,
  SID_DEFAULT_TEMPO,
  createNewSidDoc,
  exportGtSong,
  importGtSong,
  type SidDoc,
} from 'src/audio/tracker/sid-doc';
import { sngExporter } from 'src/audio/tracker/song-export';
import { clearAhxEditNotice } from 'src/audio/tracker/ahx-edit-notice';
import { useTrackerStore } from 'src/stores/tracker-store';
import { sidGridHarness } from './helpers/sid-grid-harness';

/**
 * plan-sid-authoring.md phase 3: a new SID song from scratch. The doc is
 * GoatTracker's new song (three voices on their own blank pattern, GT's new
 * instrument 1); its tempo follows D6: `doc.tempo` stays GT's 6 and a tempo
 * is an F command on row 0 of voice 1's first pattern, which is how
 * GoatTracker itself sets one and so how a `.sng` carries it.
 */

/** The doc a `.sng` written from `doc` imports as (a `.sng` stores neither chip model nor multispeed: the hints give them back). */
function viaSng(doc: SidDoc): SidDoc {
  const written = exportGtSong(doc);
  if (!written.ok) throw new Error(written.reason);
  const back = importGtSong(written.bytes, { chipModel: doc.chipModel, speedMultiplier: doc.speedMultiplier });
  if (!back.ok) throw new Error(back.reason);
  return back.doc;
}

const row0 = (doc: SidDoc) => doc.patterns[doc.subsongs[0]!.orderlists[0]!.entries[0]!.pattern]!.rows[0]!;

describe('createNewSidDoc (phase 3)', () => {
  it('at 1x and tempo 6 is GoatTracker\'s new song: no tempo command', () => {
    const doc = createNewSidDoc();
    expect(doc.tempo).toBe(SID_DEFAULT_TEMPO);
    expect(doc.patterns.every((p) => p.rows.every((r) => r === BLANK_SID_ROW))).toBe(true);
  });

  it('writes a tempo as an F command on row 0 of voice 1, never into doc.tempo (D6)', () => {
    const doc = createNewSidDoc({ tempo: 8 });
    expect(doc.tempo).toBe(SID_DEFAULT_TEMPO);
    expect(row0(doc)).toEqual({ ...BLANK_SID_ROW, command: 0xf, param: 8 });
    // Only that row: voices 2 and 3 and every other row stay blank.
    const rows = doc.patterns.flatMap((p) => p.rows);
    expect(rows.filter((r) => r !== BLANK_SID_ROW)).toHaveLength(1);
  });

  it('at multispeed starts at GoatTracker\'s tempo (6 per 1x), written as a command so both players agree', () => {
    const doc = createNewSidDoc({ speedMultiplier: 2 });
    expect(doc.speedMultiplier).toBe(2);
    expect(doc.tempo).toBe(SID_DEFAULT_TEMPO);
    expect(row0(doc)).toEqual({ ...BLANK_SID_ROW, command: 0xf, param: 12 });
    expect(doc.instruments[0]).toEqual({ ...DEFAULT_SID_INSTRUMENT, gateTimer: 4, wavePtr: 1, pulsePtr: 1 });
    // A chosen tempo at multispeed is the multispeed frames per row, as GT's F command counts them.
    expect(row0(createNewSidDoc({ speedMultiplier: 4, tempo: 20 }))).toEqual({ ...BLANK_SID_ROW, command: 0xf, param: 20 });
  });

  it('takes the chip model, pattern length and name', () => {
    const doc = createNewSidDoc({ chipModel: '8580', patternRows: 32, songName: 'Tune', author: 'Me' });
    expect(doc.chipModel).toBe('8580');
    expect(doc.patterns.map((p) => p.rows.length)).toEqual([32, 32, 32]);
    expect([doc.songName, doc.author]).toEqual(['Tune', 'Me']);
  });

  it('refuses options GoatTracker cannot hold, saying which', () => {
    expect(() => createNewSidDoc({ tempo: 2 })).toThrow('the tempo is not 3-127 (GoatTracker\'s F command)');
    expect(() => createNewSidDoc({ tempo: 128 })).toThrow('the tempo is not 3-127');
    expect(() => createNewSidDoc({ patternRows: 0 })).toThrow('a pattern has 1-128 rows');
    expect(() => createNewSidDoc({ patternRows: 129 })).toThrow('a pattern has 1-128 rows');
    expect(() => createNewSidDoc({ speedMultiplier: 17 })).toThrow('the speed multiplier is not 1-16');
  });

  it('refuses rows no longer than the instrument\'s gate timer: GoatTracker stops such a song (gplay.c:333)', () => {
    // Gate timer 2 per 1x (GT's new instrument): at 2x it is 4, so rows need 5 frames.
    expect(() => createNewSidDoc({ speedMultiplier: 2, tempo: 4 })).toThrow(
      "Not a new SID song: at 2x the tempo is at least 5: the instrument's gate timer is 4 frames, and GoatTracker stops a song whose rows are not longer than that.",
    );
    expect(createNewSidDoc({ speedMultiplier: 2, tempo: 5 }).speedMultiplier).toBe(2);
    expect(() => createNewSidDoc({ speedMultiplier: 16, tempo: 32 })).toThrow('at 16x the tempo is at least 33');
    expect(createNewSidDoc({ tempo: 3 }).tempo).toBe(SID_DEFAULT_TEMPO);
  });

  it('exports as a .sng that imports as the same doc, at every option', () => {
    for (const speedMultiplier of [1, 2, 3, 8]) {
      for (const tempo of [undefined, 2 * speedMultiplier + 1, 127]) {
        for (const chipModel of ['6581', '8580'] as const) {
          const doc = createNewSidDoc({ speedMultiplier, chipModel, patternRows: 16, ...(tempo === undefined ? {} : { tempo }) });
          expect(viaSng(doc)).toEqual(doc);
        }
      }
    }
  });
});

describe('the store\'s new SID song (phase 3)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    clearAhxEditNotice();
  });

  it('is the doc, editable, with the song\'s slots and no history', () => {
    const store = useTrackerStore();
    store.pushHistory();
    store.resetToNewSidSong({ chipModel: '8580', speedMultiplier: 2, tempo: 10, patternRows: 32, songName: 'Tune' });
    expect(store.moduleFormat).toBe('sid');
    expect(store.isSidEditable).toBe(true);
    expect(store.sidDoc).toEqual(createNewSidDoc({ chipModel: '8580', speedMultiplier: 2, tempo: 10, patternRows: 32, songName: 'Tune' }));
    expect(store.currentSong.title).toBe('Tune');
    expect(store.undoStack).toHaveLength(0);
    expect(store.instrumentSlots[0]).toMatchObject({ instrumentFormat: 'sid', instrumentName: DEFAULT_SID_INSTRUMENT.name });
    expect(store.patterns.map((p) => p.rows)).toEqual([32]);
    // The grid shows the tempo command on voice 1's first row.
    expect(store.patterns[0]!.tracks[0]!.entries.find((e) => e.row === 0)?.macro).toBe('F0A');
  });

  it('replaces whatever song was loaded, SID or not', () => {
    const store = useTrackerStore();
    store.resetToNewSidSong({ patternRows: 16 });
    const first = store.sidDoc;
    store.resetToNewSidSong();
    expect(store.sidDoc).not.toBe(first);
    expect(store.patterns.map((p) => p.rows)).toEqual([64]);
    store.resetToNewSong();
    expect(store.moduleFormat).not.toBe('sid');
    expect(store.sidDoc).toBeNull();
  });

  it('gate: type notes into it, export the .sng from the store, and it imports as the store\'s doc', () => {
    const store = useTrackerStore();
    const h = sidGridHarness(undefined, () => store.resetToNewSidSong({ speedMultiplier: 2, patternRows: 16 }));
    // C-4, E-4, G-4 on the three voices at row 0 (voice 1's row keeps its F command), then more.
    [60, 64, 67].forEach((midi, voice) => {
      h.at(0, voice, 0);
      h.editing.handleNoteEntry(midi);
    });
    h.at(0, 0, 4);
    h.editing.handleNoteEntry(62);
    h.at(0, 1, 8);
    h.editing.insertNoteOff();
    const doc = h.sid();
    expect(row0(doc)).toMatchObject({ command: 0xf, param: 12, instrument: 1 });
    expect(doc.patterns.flatMap((p) => p.rows).filter((r) => r.note !== BLANK_SID_ROW.note)).toHaveLength(5);

    const song = store.serializeSong();
    expect(sngExporter.check(song)).toEqual({ ok: true });
    const back = importGtSong(sngExporter.serialize(song), { chipModel: doc.chipModel, speedMultiplier: 2 });
    expect(back.ok && back.doc).toEqual(doc);
  });
});
