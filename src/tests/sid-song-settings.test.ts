import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  BLANK_SID_ROW,
  DEFAULT_SID_INSTRUMENT,
  SID_MAX_INSTRUMENTS,
  addSidFlatSubsong,
  cloneSidInstrument,
  createNewSidDoc,
  decodeSidFile,
  deleteSidInstrument,
  encodeSidFile,
  exportGtSong,
  flattenSidDoc,
  importGtSong,
  makeSidDoc,
  setSidFlatSpeed,
  setSidFlatTempo,
  sidFlatTempo,
  sidImpliedTempo,
  sidInstrumentUses,
  sidMinTempo,
  type SidDoc,
  type SidFlatEdit,
  type SidFlatSubsong,
  type SidOpResult,
  type SidOrderEntry,
} from 'src/audio/tracker/sid-doc';
import { ahxEditNotice, clearAhxEditNotice } from 'src/audio/tracker/ahx-edit-notice';
import { sidGridHarness as harness } from './helpers/sid-grid-harness';

/**
 * plan-sid-authoring.md phase 2: the song settings and instrument ops.
 * Instrument delete and clone (`instrument-ops.ts`) work on the doc and
 * renumber every row; tempo (D6), multispeed and subsongs work on the flat
 * song (`flat.ts`). Each is checked for what it does, what it refuses (the
 * reason is true), the round trip, and as one undo step through the store.
 */

const must = (r: SidOpResult): SidDoc => {
  if (!r.ok) throw new Error(r.reason);
  return r.doc;
};
const refusal = (r: SidOpResult): string => {
  expect(r.ok).toBe(false);
  return r.ok ? '' : r.reason;
};
const e = (pattern: number, transpose = 0, repeat = 1): SidOrderEntry => ({ pattern, transpose, repeat });

/** The doc after the SID file codec and after a `.sng` write and read: both must equal it. */
function expectRoundTrip(doc: SidDoc): void {
  const decoded = decodeSidFile(encodeSidFile(doc));
  expect(decoded.ok && decoded.doc).toEqual(doc);
  const written = exportGtSong(doc);
  if (!written.ok) throw new Error(written.reason);
  const back = importGtSong(written.bytes, { chipModel: doc.chipModel, speedMultiplier: doc.speedMultiplier });
  expect(back.ok && back.doc).toEqual(doc);
}

/** Three voices over patterns 0-4; voice 1 plays 0, 1, 0 and loops from entry 1. */
function song(): SidDoc {
  const base = createNewSidDoc({ patternRows: 4 });
  const note = (n: number, instrument: number) => ({ ...BLANK_SID_ROW, note: n, instrument });
  const patterns = [
    { rows: [note(25, 1), BLANK_SID_ROW, note(27, 2), BLANK_SID_ROW] },
    { rows: [note(30, 2), BLANK_SID_ROW, BLANK_SID_ROW, note(32, 3)] },
    { rows: [note(13, 3), BLANK_SID_ROW] },
    { rows: [note(40, 1)] },
    { rows: [BLANK_SID_ROW, BLANK_SID_ROW, BLANK_SID_ROW] },
  ];
  return makeSidDoc({
    ...base,
    patterns,
    instruments: [
      { ...base.instruments[0]!, name: 'one' },
      { ...base.instruments[0]!, name: 'two' },
      { ...base.instruments[0]!, name: 'three' },
    ],
    subsongs: [
      {
        orderlists: [
          { entries: [e(0), e(1, 2), e(0, -3, 2)], restart: 1 },
          { entries: [e(2), e(2)], restart: 0 },
          { entries: [e(3)], restart: 0 },
        ],
      },
    ],
  });
}

const flatMust = (r: SidFlatEdit) => {
  if (!r.ok) throw new Error(r.reason);
  return r;
};
const flatRefusal = (r: SidFlatEdit): string => {
  expect(r.ok).toBe(false);
  return r.ok ? '' : r.reason;
};

describe('instrument ops', () => {
  it('deletes an unused instrument and renumbers the rows naming a later one', () => {
    const base = song();
    const doc = must(cloneSidInstrument(base, 1)); // instrument 4, unused
    const moved = makeSidDoc({ ...doc, patterns: doc.patterns.map((p, i) => (i === 3 ? { rows: [{ ...BLANK_SID_ROW, note: 40, instrument: 4 }] } : p)) });
    // Instrument 1 is used on pattern 0; free it first by deleting with clearUses.
    const gone = must(deleteSidInstrument(moved, 1, { clearUses: true }));
    expect(gone.instruments.map((i) => i.name)).toEqual(['two', 'three', 'one']);
    expect(gone.patterns[0]!.rows[0]!.instrument).toBe(0);
    expect(gone.patterns[0]!.rows[2]!.instrument).toBe(1);
    expect(gone.patterns[1]!.rows[3]!.instrument).toBe(2);
    expect(gone.patterns[3]!.rows[0]!.instrument).toBe(3);
    // Untouched patterns are shared.
    expect(gone.patterns[4]).toBe(moved.patterns[4]);
    expectRoundTrip(gone);
  });

  it('refuses to delete a used instrument unless its rows are cleared, and names where it is used', () => {
    const doc = song();
    expect(sidInstrumentUses(doc, 2)).toEqual([
      { pattern: 0, row: 2 },
      { pattern: 1, row: 0 },
    ]);
    expect(refusal(deleteSidInstrument(doc, 2))).toBe('Instrument 2 is named on 2 rows (the first: pattern 0 row 2).');
    expect(refusal(deleteSidInstrument(doc, 4))).toBe('There is no instrument 4.');
  });

  it('clones an instrument with its own copies of its table rows, jumps inside the copy moved with it', () => {
    let doc = song();
    // Instrument 1: wave rows 1-2 (41 00, FF 00); give it a looping wave chain 3-5 and a vibrato row.
    doc = makeSidDoc({
      ...doc,
      tables: {
        ...doc.tables,
        wave: [...doc.tables.wave, { left: 0x41, right: 0 }, { left: 0x21, right: 0x0c }, { left: 0xff, right: 4 }, { left: 0xff, right: 1 }],
        speed: [{ left: 4, right: 20 }],
      },
      instruments: doc.instruments.map((ins, i) => (i === 0 ? { ...ins, wavePtr: 3, speedPtr: 1 } : ins)),
    });
    const cloned = must(cloneSidInstrument(doc, 1));
    const copy = cloned.instruments[3]!;
    expect({ ...copy, wavePtr: 0, pulsePtr: 0, speedPtr: 0 }).toEqual({ ...doc.instruments[0], wavePtr: 0, pulsePtr: 0, speedPtr: 0 });
    // Wave rows 3-5 appended as 7-9; the loop to row 4 now goes to 8.
    expect(copy.wavePtr).toBe(7);
    expect(cloned.tables.wave.slice(6)).toEqual([{ left: 0x41, right: 0 }, { left: 0x21, right: 0x0c }, { left: 0xff, right: 8 }]);
    expect(copy.pulsePtr).toBe(3);
    expect(cloned.tables.pulse.slice(2)).toEqual(doc.tables.pulse);
    expect(copy.speedPtr).toBe(2);
    expect(cloned.tables.speed).toEqual([{ left: 4, right: 20 }, { left: 4, right: 20 }]);
    expectRoundTrip(cloned);
    const full = makeSidDoc({ ...doc, instruments: Array.from({ length: SID_MAX_INSTRUMENTS }, () => DEFAULT_SID_INSTRUMENT) });
    expect(refusal(cloneSidInstrument(full, 1))).toBe("The song has 63 instruments, GoatTracker's most.");
  });
});

describe('tempo and multispeed on the flat song (D6)', () => {
  const row0 = (edit: { subsongs: readonly SidFlatSubsong[] }, s = 0) => {
    const flat = edit.subsongs[s]!;
    return flat.patterns[flat.sequence[0]!]!.cells[0]!.rows[0]!;
  };

  it('reads the start tempo from the F on the first row of voice 1, else GoatTracker\'s 6 per 1x', () => {
    const tempo = (doc: SidDoc) => sidFlatTempo(doc, flattenSidDoc(doc)[0]!);
    expect(tempo(createNewSidDoc())).toBe(6);
    expect(tempo(createNewSidDoc({ tempo: 9 }))).toBe(9);
    expect(tempo(createNewSidDoc({ speedMultiplier: 3 }))).toBe(18);
    const base = createNewSidDoc();
    const funk = makeSidDoc({ ...base, patterns: [{ rows: [{ ...BLANK_SID_ROW, command: 0xf, param: 0 }] }, ...base.patterns.slice(1)] });
    expect(tempo(funk)).toBeNull();
  });

  it('takes GoatTracker\'s hidden start tempo from instrument 63 with no wave table', () => {
    const doc = createNewSidDoc();
    const many = makeSidDoc({ ...doc, instruments: Array.from({ length: 63 }, (_, i) => (i === 62 ? { ...DEFAULT_SID_INSTRUMENT, attack: 0, decay: 8 } : doc.instruments[0]!)) });
    expect(sidImpliedTempo(many)).toBe(8);
  });

  it('writes, updates and removes the F command; doc.tempo stays 6', () => {
    const doc = song();
    const flats = flattenSidDoc(doc);
    const set = flatMust(setSidFlatTempo(doc, flats, 0, 9));
    expect(set.doc).toBe(doc);
    expect(row0(set)).toEqual({ ...doc.patterns[0]!.rows[0], command: 0xf, param: 9 });
    expect(sidFlatTempo(doc, set.subsongs[0]!)).toBe(9);
    const back = flatMust(setSidFlatTempo(doc, set.subsongs, 0, 6));
    expect(row0(back)).toEqual(doc.patterns[0]!.rows[0]);
    expect(flatMust(setSidFlatTempo(doc, flats, 0, 6)).subsongs).toBe(flats);
    // At multispeed the command stays even at GT's own start.
    const fast = flatMust(setSidFlatSpeed(doc, flats, 2));
    expect(row0(flatMust(setSidFlatTempo(fast.doc, fast.subsongs, 0, 12)))).toMatchObject({ command: 0xf, param: 12 });
  });

  it('refuses a tempo at or below a gate timer (GoatTracker stops the song), and a first row with another command', () => {
    const doc = song();
    expect(sidMinTempo(doc)).toBe(3);
    const slow = makeSidDoc({ ...doc, instruments: doc.instruments.map((ins, i) => (i === 1 ? { ...ins, gateTimer: 7 } : ins)) });
    expect(sidMinTempo(slow)).toBe(8);
    expect(flatRefusal(setSidFlatTempo(slow, flattenSidDoc(slow), 0, 7))).toBe(
      "Tempo 7 is too low: instrument 2's gate timer is 7 frames, and GoatTracker stops the song when voice 1 plays an instrument whose gate timer is not shorter than a row. The lowest tempo is 8.",
    );
    expect(setSidFlatTempo(slow, flattenSidDoc(slow), 0, 8).ok).toBe(true);
    expect(flatRefusal(setSidFlatTempo(doc, flattenSidDoc(doc), 0, 2))).toBe("A tempo is 3-127 frames per row (GoatTracker's F command).");
    const busy = makeSidDoc({ ...doc, patterns: [{ rows: [{ ...doc.patterns[0]!.rows[0]!, command: 3, param: 0x20 }, ...doc.patterns[0]!.rows.slice(1)] }, ...doc.patterns.slice(1)] });
    expect(flatRefusal(setSidFlatTempo(busy, flattenSidDoc(busy), 0, 9))).toBe(
      'The start tempo is an F command on the first row of voice 1, and that row already has command 320.',
    );
    expect(flatRefusal(setSidFlatSpeed(busy, flattenSidDoc(busy), 2))).toBe(
      'At 2x the song needs its start tempo as an F command on the first row of voice 1, and that row already has command 320.',
    );
  });

  it('multispeed writes GT\'s implied start as an F where there is none, and keeps an F that is there', () => {
    const doc = song();
    const fast = flatMust(setSidFlatSpeed(doc, flattenSidDoc(doc), 4));
    expect(fast.doc.speedMultiplier).toBe(4);
    expect(row0(fast)).toMatchObject({ command: 0xf, param: 24 });
    const set = flatMust(setSidFlatTempo(doc, flattenSidDoc(doc), 0, 9));
    expect(row0(flatMust(setSidFlatSpeed(doc, set.subsongs, 2)))).toMatchObject({ command: 0xf, param: 9 });
    expect(flatRefusal(setSidFlatSpeed(doc, flattenSidDoc(doc), 17))).toBe('The speed is 1-16x.');
  });

  it('a new subsong is one blank position as long as subsong 0\'s first, at subsong 0\'s tempo', () => {
    const doc = song();
    const set = flatMust(setSidFlatTempo(doc, flattenSidDoc(doc), 0, 9));
    const added = flatMust(addSidFlatSubsong(doc, set.subsongs, 'new'));
    expect(added.subsongs).toHaveLength(2);
    const flat = added.subsongs[1]!;
    expect(flat.sequence).toEqual(['new']);
    // Subsong 0's first position is 1 row: voice 3 plays a 1-row pattern.
    expect(flat.patterns.new!.rows).toBe(1);
    expect(sidFlatTempo(doc, flat)).toBe(9);
    // At GT's own 6 at 1x no command is written.
    const plain = flatMust(addSidFlatSubsong(doc, flattenSidDoc(doc), 'new')).subsongs[1]!;
    expect(plain.patterns.new!.cells.every((c) => c.rows.every((r) => r === BLANK_SID_ROW))).toBe(true);
  });
});

describe('through the store: each setting is one undo step', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    clearAhxEditNotice();
  });

  it('tempo, speed and subsongs change the doc, refuse with the reason, and undo byte for byte', () => {
    const h = harness(song());
    const before = encodeSidFile(h.sid());
    expect(h.store.sidTempo()).toBe(6);
    expect(h.store.setSidTempo(9)).toBe(true);
    expect(h.store.sidTempo()).toBe(9);
    expect(h.entryAt(0, 0, 0)?.macro).toBe('F09');
    expect(h.store.setSidTempo(2)).toBe(false);
    expect(ahxEditNotice.value?.message).toBe("A tempo is 3-127 frames per row (GoatTracker's F command).");
    expect(h.store.setSidSpeed(2)).toBe(true);
    expect(h.sid().speedMultiplier).toBe(2);
    expect(h.store.addSidSubsong()).toBe(true);
    expect(h.store.sidSubsong).toBe(1);
    expect(h.sid().subsongs).toHaveLength(2);
    expect(h.store.cloneSidSubsong()).toBe(true);
    expect(h.store.sidSubsong).toBe(2);
    expect(h.store.deleteSidSubsong()).toBe(true);
    expect(h.store.sidSubsong).toBe(1);
    expect(h.sid().subsongs).toHaveLength(2);
    expect(h.store.undoStack).toHaveLength(5);
    // The saved file is the doc, and a .sng of it imports back as it.
    const decoded = decodeSidFile(h.store.serializeSong().data.sidFile as string);
    expect(decoded.ok && decoded.doc).toEqual(h.sid());
    expectRoundTrip(h.sid());
    for (let i = 0; i < 5; i++) h.store.undo();
    expect(encodeSidFile(h.sid())).toBe(before);
    expect(h.store.sidSubsong).toBe(0);
    h.store.deleteSidSubsong();
    expect(ahxEditNotice.value?.message).toBe('A song needs at least one subsong.');
  });

  it('an instrument delete through the store renumbers the grid\'s rows too', () => {
    const h = harness(song());
    expect(h.store.editSidDoc(deleteSidInstrument(h.sid(), 1, { clearUses: true }))).toBe(true);
    expect(h.sid().instruments.map((i) => i.name)).toEqual(['two', 'three']);
    // Voice 1's pattern: row 0 named instrument 1 (now none), row 2 instrument 2 (now 1); the grid shows it.
    expect(h.sid().patterns[0]!.rows[0]!.instrument).toBe(0);
    expect(h.sid().patterns[0]!.rows[2]!.instrument).toBe(1);
    expect(h.entryAt(0, 0, 0)?.instrument).toBeUndefined();
    // Voice 1 plays P0 three times (row 2) and P1 once (row 0): four rows now name instrument 1.
    expect(h.store.patterns.flatMap((p) => p.tracks[0]!.entries).filter((e) => e.instrument === '01')).toHaveLength(4);
    h.store.undo();
    expect(h.sid().instruments).toHaveLength(3);
  });
});
