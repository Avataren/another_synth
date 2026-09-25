import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { midiToTrackerNote, sidFreqRegToHz, sidNoteFreqReg } from '@another-synth/tracker-playback';
import { useTrackerStore } from 'src/stores/tracker-store';
import { ahxEditNotice, clearAhxEditNotice } from 'src/audio/tracker/ahx-edit-notice';
import { SID_NOTE_KEY_OFF, SID_NOTE_KEY_ON, decodeSidFile, setSidRow, sidGridLayout } from 'src/audio/tracker/sid-doc';
import { buildSidChainSong } from './helpers/sid-chain-song';
import { sidGridHarness as harness } from './helpers/sid-grid-harness';

/**
 * plan-sid-tracking.md S4: the SID grid writes back to the doc.
 *
 * Every edit here goes through the REAL store and the REAL editing and
 * selection composables, wired exactly as `TrackerPage` wires them (its
 * `ahxEditGate`: active for an editable AHX *or* SID song, the store's
 * `ahxRefusal` answering for the song's format, `flush` writing both
 * formats back). Nothing is written into the doc by the test: the doc only
 * changes through the store's write-back of what the composables did.
 *
 * The song is S3's chain song (`helpers/sid-chain-song.ts`): voice 1 plays
 * P0 (32 rows), voice 2 P1 (32 rows), voice 3 P2 (16 rows, twice, transpose
 * +5). So the grid has two 16-row positions:
 *   position 0: P0 rows 0-15 | P1 rows 0-15 | P2 rows 0-15 (+5)
 *   position 1: P0 rows 16-31 | P1 rows 16-31 | P2 rows 0-15 (+5, the repeat)
 * and voice 3's cells in both positions are the same slice of one pattern.
 */

const noticeText = () => ahxEditNotice.value?.message ?? null;

beforeEach(() => {
  setActivePinia(createPinia());
  clearAhxEditNotice();
});
afterEach(() => {
  clearAhxEditNotice();
});

describe('a SID song with a doc is editable (S4)', () => {
  it('opens editable: its voices and slots are the doc\'s, its patterns and sequence are edited like any song\'s', () => {
    const h = harness();
    expect(h.store.isSidSong).toBe(true);
    expect(h.store.isSidEditable).toBe(true);
    expect(h.store.isReadOnly).toBe(false);
    expect(h.store.hasDocStructure).toBe(true);
    expect(h.store.hasFixedSequence).toBe(false);
    expect(h.store.patterns.map((p) => p.rows)).toEqual([16, 16]);
    expect(h.store.sequence).toEqual(['sid-pos-0', 'sid-pos-1']);
    // Voices are the chip's.
    expect(h.store.addTrack()).toBe(false);
    expect(h.store.removeTrack(0)).toBe(false);
    // Unedited, the doc is the one adopted (it saves byte for byte).
    const before = h.sid();
    expect(before).toBe(h.store.sidDoc);
    // A new pattern: three blank voices, not in the sequence yet (the doc does not change).
    const id = h.store.createPattern();
    expect(h.store.patterns.find((p) => p.id === id)?.tracks).toHaveLength(3);
    expect(h.sid()).toBe(before);
    // Into the sequence: every voice's orderlist gains an entry.
    h.store.addPatternToSequence(id);
    const added = h.sid();
    expect(added).not.toBe(before);
    expect(added.subsongs[0]!.orderlists.map((l) => l.entries.reduce((n, e) => n + e.repeat, 0))).toEqual([2, 2, 3]);
    // Move it first, shorten it: the doc follows.
    h.store.moveSequenceItem(2, 0);
    h.store.setPatternRows(8, id);
    expect(h.store.sequence).toEqual([id, 'sid-pos-0', 'sid-pos-1']);
    const moved = h.sid();
    expect(moved.subsongs[0]!.orderlists.map((l) => moved.patterns[l.entries[0]!.pattern]!.rows.length)).toEqual([8, 8, 8]);
    // Removing it gives the original song's music back.
    h.store.removePatternFromSequence(0);
    const back = h.sid();
    expect(back.subsongs[0]!.orderlists.map((l) => l.entries.map((e) => [back.patterns[e.pattern]!.rows.length, e.transpose, e.repeat]))).toEqual(
      before.subsongs[0]!.orderlists.map((l) => l.entries.map((e) => [before.patterns[e.pattern]!.rows.length, e.transpose, e.repeat])),
    );
    // The last pattern cannot leave the sequence: the song would be empty.
    h.store.removePatternFromSequence(1);
    h.store.removePatternFromSequence(0);
    expect(h.store.sequence).toEqual(['sid-pos-0']);
    expect(noticeText()).toBe('The song needs at least one pattern in its sequence.');
  });

  it('a SID song without a doc stays a display', () => {
    const h = harness();
    const file = h.store.serializeSong();
    delete file.data.sidFile;
    h.store.loadSongFile(file);
    expect(h.store.moduleFormat).toBe('sid');
    expect(h.store.sidDoc).toBeNull();
    expect(h.store.isReadOnly).toBe(true);
    expect(h.store.isSidEditable).toBe(false);
  });
});

describe('the edit mapping: a cell is its position\'s own rows of one voice', () => {
  it('a note typed in a transposed cell is stored un-transposed, in that position only', () => {
    const h = harness();
    const before = h.sid();
    // Position 1, voice 3, row 3: the repeat of pattern 2, transpose +5.
    h.at(1, 2, 3);
    h.editing.handleNoteEntry(60); // C-4 (base octave 4): table index 48
    const after = h.sid();
    expect(after).not.toBe(before);
    // Stored un-transposed: index 48 - 5 = 43, row note 44 (index + 1).
    expect(h.flatRow(1, 2, 3)).toEqual({ note: 44, instrument: 1, command: 0, param: 0 });
    // Position 0's cell is its own copy: untouched.
    expect(h.entryAt(0, 2, 3)).toBeUndefined();
    const entry = h.entryAt(1, 2, 3);
    expect(entry?.note).toBe('C-4');
    expect(entry?.instrument).toBe('01');
    expect(entry?.frequency).toBeCloseTo(sidFreqRegToHz(sidNoteFreqReg(48)), 6);
    // Compiled: voice 3 now plays two patterns, both at +5; voices 1 and 2 as before.
    const v3 = after.subsongs[0]!.orderlists[2]!.entries;
    expect(v3.map((e) => e.transpose)).toEqual([5, 5]);
    expect(v3[0]!.pattern).not.toBe(v3[1]!.pattern);
    expect(after.patterns[v3[1]!.pattern]!.rows[3]).toEqual({ note: 44, instrument: 1, command: 0, param: 0 });
    expect(after.patterns[v3[0]!.pattern]!.rows).toEqual(before.patterns[2]!.rows);
    expect(after.instruments).toBe(before.instruments);
    expect(h.store.undoStack).toHaveLength(1);
    expect(noticeText()).toBeNull();
  });

  it('the watcher writes an edit back by itself (no reader asked)', async () => {
    const h = harness();
    const before = h.store.sidDoc;
    h.at(0, 0, 6);
    h.editing.insertNoteOff();
    expect(h.store.sidDoc).toBe(before);
    await nextTick();
    expect(h.store.sidDoc).not.toBe(before);
    expect(h.store.sidDoc!.patterns[0]!.rows[6]!.note).toBe(SID_NOTE_KEY_OFF);
  });

  it('a cell edit writes its own rows of the pattern: position 1 voice 1 is P0 rows 16-31', () => {
    const h = harness();
    h.at(1, 0, 2);
    h.editing.insertNoteOff();
    expect(h.patternRow(0, 18).note).toBe(SID_NOTE_KEY_OFF);
    expect(h.patternRow(0, 2).note).toBe(0);
    expect(h.entryAt(1, 0, 2)?.note).toBe('###');
    // Position 0's cell of the same pattern shows rows 0-15: untouched.
    expect(h.entryAt(0, 0, 2)).toBeUndefined();
  });

  it('a command typed digit by digit is one row with command and parameter', () => {
    const h = harness();
    h.at(0, 1, 5, 4, 0);
    h.editing.handleMacroInput('5');
    h.editing.handleMacroInput('1');
    h.editing.handleMacroInput('2');
    expect(h.patternRow(1, 5)).toEqual({ note: 0, instrument: 0, command: 5, param: 0x12 });
    expect(h.entryAt(0, 1, 5)?.macro).toBe('512');
    // A command-only row gets no instrument: an instrument byte would change the voice's.
    expect(h.entryAt(0, 1, 5)?.instrument).toBeUndefined();
  });

  it('rows the grid does not show survive an edit of their cell (a key on)', () => {
    const on = setSidRow(buildSidChainSong(), 0, 7, { note: SID_NOTE_KEY_ON, instrument: 0, command: 0, param: 0 });
    if (!on.ok) throw new Error(on.reason);
    const h = harness(on.doc);
    expect(h.entryAt(0, 0, 7)).toBeUndefined();
    h.at(0, 0, 3);
    h.editing.handleNoteEntry(62);
    expect(h.patternRow(0, 3).note).toBe(62 - 12 + 1);
    expect(h.patternRow(0, 7).note).toBe(SID_NOTE_KEY_ON);
    expect(h.patternRow(0, 0)).toEqual({ note: 58, instrument: 1, command: 0, param: 0 });
  });

  it('clearing a step blanks that pattern row; delete-row shifts the cell\'s slice', () => {
    const h = harness();
    h.at(0, 0, 0);
    h.editing.clearStep();
    expect(h.patternRow(0, 0)).toEqual({ note: 0, instrument: 0, command: 0, param: 0 });
    // Voice 2: C-4 at row 8; deleting row 2 moves it to row 7 (within P1 rows 0-15).
    h.at(0, 1, 2);
    h.editing.deleteRowAndShiftUp();
    expect(h.patternRow(1, 7)).toEqual({ note: 49, instrument: 2, command: 0, param: 0 });
    expect(h.patternRow(1, 8).note).toBe(0);
    // Its key off at P1 row 24 is in position 1's slice: not moved.
    expect(h.patternRow(1, 24).note).toBe(SID_NOTE_KEY_OFF);
  });

  it('transposing a track goes through the doc (shown notes move, stored under the cell\'s transpose), in that position only', () => {
    const h = harness();
    h.at(0, 2, 0);
    h.selection.transposeTrack(2);
    // Voice 3 row 10: E-3 (row note 41) +2 = F#-3, row note 43.
    expect(h.flatRow(0, 2, 10).note).toBe(43);
    // Shown as it sounds (+5): B-3; position 1 still A-3.
    expect(h.entryAt(0, 2, 10)?.note).toBe('B-3');
    expect(h.entryAt(1, 2, 10)?.note).toBe('A-3');
  });
});

describe('refusals: nothing a SID row cannot hold reaches the doc', () => {
  it('the pre-guards refuse before history (volume, second column, a missing instrument, an out-of-range note)', () => {
    const h = harness();
    const doc = h.sid();
    h.at(0, 0, 4, 2);
    h.editing.handleVolumeInput('4');
    expect(noticeText()).toMatch(/no volume column/);
    h.at(0, 0, 4, 5);
    h.editing.handleMacroInput('1');
    expect(noticeText()).toMatch(/one command column/);
    h.activeInstrumentId.value = '09';
    h.at(0, 0, 4);
    h.editing.handleNoteEntry(60);
    expect(noticeText()).toMatch(/Instrument 09 does not exist \(this song has 4\)/);
    h.activeInstrumentId.value = '01';
    h.editing.handleNoteEntry(8); // G#-1 at octave 4 offset 0: below C-0
    expect(noticeText()).toMatch(/C-0 to G#7/);
    expect(h.sid()).toBe(doc);
    expect(h.store.undoStack).toHaveLength(0);
  });

  it('the write-back reverts a note the cell\'s transpose pushes past the table, and says why', () => {
    const h = harness();
    const doc = h.sid();
    // Voice 3 plays P2 at +5: C-0 is typable (the pre-guard passes it) but
    // would have to be stored 5 semitones below the table's bottom.
    h.at(0, 2, 5);
    h.editing.handleNoteEntry(12); // C-0 (MIDI 12): in the typable range, not under +5
    expect(h.sid()).toBe(doc);
    expect(noticeText()).toMatch(/transposed \+5, so C-0 would need a note outside C-0 to G#7/);
    // The cell shows the doc again.
    expect(h.entryAt(0, 2, 5)).toBeUndefined();
  });
});

describe('undo and redo carry the doc by reference', () => {
  it('a snapshot keeps the doc, not a copy of the grid; undo and redo put back the very docs', () => {
    const h = harness();
    const original = h.sid();
    const snapshot = h.store.createSnapshot();
    expect(snapshot.sidDoc).toBe(original);
    expect(snapshot.patterns).toEqual([]);

    h.at(1, 2, 3);
    h.editing.handleNoteEntry(60);
    const edited = h.sid();
    h.at(0, 0, 9);
    h.editing.handleNoteEntry(64);
    const twice = h.sid();
    expect(h.store.undoStack).toHaveLength(2);

    h.store.undo();
    expect(h.sid()).toBe(edited);
    h.store.undo();
    expect(h.sid()).toBe(original);
    expect(h.entryAt(0, 2, 3)).toBeUndefined();
    expect(h.store.patterns.map((p) => p.id)).toEqual(['sid-pos-0', 'sid-pos-1']);
    h.store.redo();
    expect(h.sid()).toBe(edited);
    expect(h.entryAt(1, 2, 3)?.note).toBe('C-4');
    h.store.redo();
    expect(h.sid()).toBe(twice);
    // The grid after undo/redo is editable again: an edit on it writes back.
    h.at(0, 1, 1);
    h.editing.insertNoteOff();
    expect(h.patternRow(1, 1).note).toBe(SID_NOTE_KEY_OFF);
    expect(h.store.redoStack).toHaveLength(0);
  });

  it('an edit made off the grid (editSidDoc) is one undo step too', () => {
    const h = harness();
    const original = h.sid();
    const changed = setSidRow(original, 1, 30, { note: 30, instrument: 2, command: 0, param: 0 });
    expect(h.store.editSidDoc(changed)).toBe(true);
    expect(h.sid()).not.toBe(original);
    expect(h.entryAt(1, 1, 14)?.note).toBe(midiToTrackerNote(29 + 12));
    h.store.undo();
    expect(h.sid()).toBe(original);
    // A refused op changes nothing and says why.
    expect(h.store.editSidDoc({ ok: false, reason: 'nope' })).toBe(false);
    expect(noticeText()).toBe('nope');
    expect(h.store.undoStack).toHaveLength(0);
  });
});

describe('round trip: grid edits survive doc -> file -> doc', () => {
  it('the saved file is the edited doc, and loading it gives the same doc and grid', () => {
    const h = harness();
    h.at(1, 2, 3);
    h.editing.handleNoteEntry(60);
    h.at(0, 1, 5, 4, 0);
    for (const c of 'A07') h.editing.handleMacroInput(c);
    const edited = h.sid();
    const file = h.store.serializeSong();
    const decoded = decodeSidFile(file.data.sidFile as string);
    if (!decoded.ok) throw new Error(decoded.reason);
    expect(decoded.doc).toEqual(edited);

    setActivePinia(createPinia());
    const other = useTrackerStore();
    other.loadSongFile(JSON.parse(JSON.stringify(file)));
    expect(other.sidDoc).toEqual(edited);
    expect(other.patterns).toEqual(h.store.patterns);
    expect(other.isReadOnly).toBe(false);
  });

  it('an edit the watcher has not flushed yet is in the save', () => {
    const h = harness();
    // What an edit site does: replace the cell's array (no watcher tick in between).
    const cell = h.store.patterns[0]!.tracks[0]!;
    cell.entries = [...cell.entries, { row: 12, note: 'D-5', instrument: '01' }];
    const file = h.store.serializeSong();
    const decoded = decodeSidFile(file.data.sidFile as string);
    if (!decoded.ok) throw new Error(decoded.reason);
    expect(decoded.doc.patterns[0]!.rows[12]).toEqual({ note: 74 - 12 + 1, instrument: 1, command: 0, param: 0 });
  });

  it('the layout is the projection\'s: every cell of the grid is its layout slice', () => {
    const h = harness();
    const layout = sidGridLayout(h.sid());
    expect(layout.cells.map((cells) => cells.map((c) => [c.pattern, c.offset, c.transpose]))).toEqual([
      [[0, 0, 0], [1, 0, 0], [2, 0, 5]],
      [[0, 16, 0], [1, 16, 0], [2, 0, 5]],
    ]);
    expect(h.store.patterns.map((p) => p.positionTranspose)).toEqual([[0, 0, 5], [0, 0, 5]]);
  });
});
