import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, isReactive, nextTick, ref, toRef } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { parseAhx, parseTrackerNoteSymbol, type AhxSong } from '@another-synth/tracker-playback';
import { useTrackerStore, type TrackerSongFile } from 'src/stores/tracker-store';
import { useTrackerEditing, type TrackerEditingContext } from 'src/composables/useTrackerEditing';
import { useTrackerSelection, type TrackerSelectionContext } from 'src/composables/useTrackerSelection';
import { importAhxToTrackerSong } from 'src/audio/tracker/ahx-import';
import {
  currentAhxPreviewSource,
  currentAhxSource,
  setCurrentAhxSource,
} from 'src/audio/tracker/ahx-source';
import { ahxEditNotice, clearAhxEditNotice, reportAhxEditNotice } from 'src/audio/tracker/ahx-edit-notice';
import {
  buildAhxFile,
  createNewAhxDoc,
  insertPosition,
  setStep,
  type AhxDoc,
  type AhxDocStep,
  type AhxEditGate,
} from 'src/audio/tracker/ahx-doc';
import { defaultAhxInstrument } from 'src/audio/tracker/ahx-instrument-edit';
import { formatInstrumentId, normalizeInstrumentId, midiToTrackerNote } from '@another-synth/tracker-playback';
import { pickActiveInstrumentId } from 'src/audio/tracker/instrument-ids';
import type { TrackerSongBank } from 'src/audio/tracker/song-bank';
import type { TrackerEntryData } from 'src/components/tracker/tracker-types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const step = (note: number, instrument = 0, fx = 0, fxParam = 0): AhxDocStep => ({ note, instrument, fx, fxParam, fxb: 0, fxbParam: 0 });
const toBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

const ROWS = 16;

/**
 * A small song with known content, built with the B1 ops and the writer: 3
 * positions of 16 rows; positions 0 and 1 share track 1 on channel 1 (notes at
 * rows 0, 4 and 8); every other cell is the blank track 0.
 */
function fixtureDoc(): AhxDoc {
  const first = createNewAhxDoc({ trackLength: ROWS });
  const duplicated = insertPosition(first, 1, { kind: 'duplicate', of: 0 });
  if (!duplicated.ok) throw new Error(duplicated.reason);
  const blank = insertPosition(duplicated.doc, 2, { kind: 'blank' });
  if (!blank.ok) throw new Error(blank.reason);
  let doc = blank.doc;
  const put = (track: number, row: number, s: AhxDocStep) => {
    const r = setStep(doc, track, row, s);
    if (!r.ok) throw new Error(r.reason);
    doc = r.doc;
  };
  put(1, 0, step(25, 1));
  put(1, 4, step(27, 1, 0xc, 0x20));
  put(1, 8, step(30, 2));
  return doc;
}

function fixtureBytes(doc: AhxDoc = fixtureDoc()): Uint8Array {
  const slots = [1, 2, 3].map((n) => ({ ahxData: { ...defaultAhxInstrument(), name: `Ins ${n}` } }));
  return buildAhxFile({ doc, slots, title: 'Fixture' }).bytes;
}

function loadBytes(bytes: Uint8Array): { file: TrackerSongFile; store: ReturnType<typeof useTrackerStore> } {
  const store = useTrackerStore();
  const file = importAhxToTrackerSong(toBuffer(bytes));
  store.loadSongFile(file);
  setCurrentAhxSource(bytes);
  return { file, store };
}

/** The real store and the real editing and selection composables, wired the way `TrackerPage` wires them. */
function harness(bytes: Uint8Array = fixtureBytes()) {
  const { store } = loadBytes(bytes);
  const activeRow = ref(0);
  const activeTrack = ref(0);
  const activeColumn = ref(0);
  const activeMacroNibble = ref(0);
  const isEditMode = ref(true);
  const stepSize = ref(1);
  const currentPattern = computed(() => store.patterns.find((p) => p.id === store.currentPatternId));
  const rowsCount = computed(() => store.currentPatternRows);
  const gate: AhxEditGate = {
    active: () => store.isAhxEditable,
    refuse: (check) => {
      const reason = store.ahxRefusal(check);
      if (reason === null) return false;
      reportAhxEditNotice(reason);
      return true;
    },
  };
  const activeInstrumentId = ref<string | null>('01');
  const editingContext: TrackerEditingContext = {
    activeRow,
    activeTrack,
    activeColumn,
    activeMacroNibble,
    isEditMode,
    stepSize,
    baseOctave: ref(4),
    defaultBaseOctave: 4,
    activeInstrumentId,
    rowsCount,
    currentPattern,
    instrumentSlots: toRef(store, 'instrumentSlots'),
    songBank: {} as TrackerSongBank,
    toggleInterpolationRange: vi.fn(),
    clearInterpolationRangeAt: vi.fn(),
    pushHistory: () => store.pushHistory(),
    moveRow: (delta) => {
      activeRow.value = Math.max(0, Math.min(rowsCount.value - 1, activeRow.value + delta));
    },
    formatInstrumentId,
    normalizeInstrumentId,
    normalizeVolumeChars: (vol) => {
      const clean = (vol ?? '').toUpperCase();
      const chars: [string, string] = ['.', '.'];
      if (/^[0-9A-F]$/.test(clean[0] ?? '')) chars[0] = clean[0] as string;
      if (/^[0-9A-F]$/.test(clean[1] ?? '')) chars[1] = clean[1] as string;
      return chars;
    },
    normalizeMacroChars: (macro) => {
      const clean = (macro ?? '').toUpperCase();
      const chars: [string, string, string] = ['.', '.', '.'];
      if (/^[0-9A-Z]$/.test(clean[0] ?? '')) chars[0] = clean[0] as string;
      if (/^[0-9A-F]$/.test(clean[1] ?? '')) chars[1] = clean[1] as string;
      if (/^[0-9A-F]$/.test(clean[2] ?? '')) chars[2] = clean[2] as string;
      return chars;
    },
    midiToTrackerNote,
    ahx: gate,
  };
  const selectionContext: TrackerSelectionContext = {
    activeRow,
    activeTrack,
    isEditMode,
    isReadOnly: computed(() => store.isReadOnly),
    rowsCount,
    currentPattern,
    pushHistory: () => store.pushHistory(),
    parseTrackerNoteSymbol,
    midiToTrackerNote,
    ahx: gate,
  };
  const editing = useTrackerEditing(editingContext);
  const selection = useTrackerSelection(selectionContext);
  const cursor = () => ({ row: activeRow.value, track: activeTrack.value, column: activeColumn.value, nibble: activeMacroNibble.value });
  /** The doc's step for a grid cell. */
  const docStep = (position: number, channel: number, row: number): AhxDocStep => {
    const doc = store.ahxDoc as AhxDoc;
    return (doc.tracks[(doc.positions[position] as AhxDoc['positions'][number]).track[channel] as number] as readonly AhxDocStep[])[row] as AhxDocStep;
  };
  const trackOf = (position: number, channel: number): number => (store.ahxDoc as AhxDoc).positions[position]!.track[channel] as number;
  const cell = (position: number, channel: number) => store.patterns[position]!.tracks[channel]!;
  const entryAt = (position: number, channel: number, row: number) => cell(position, channel).entries.find((e) => e.row === row);
  const at = (row: number, track: number, column = 0, nibble = 0) => {
    activeRow.value = row;
    activeTrack.value = track;
    activeColumn.value = column;
    activeMacroNibble.value = nibble;
  };
  return { store, editing, selection, activeRow, activeTrack, activeColumn, activeMacroNibble, activeInstrumentId, isEditMode, cursor, docStep, trackOf, cell, entryAt, at };
}
type Harness = ReturnType<typeof harness>;

const revision = (h: Harness) => h.store.ahxRevision;
const noticeText = () => ahxEditNotice.value?.message ?? null;

beforeEach(() => {
  setActivePinia(createPinia());
  clearAhxEditNotice();
});
afterEach(() => {
  setCurrentAhxSource(null);
  clearAhxEditNotice();
});

// ---------------------------------------------------------------------------
// Every write site
// ---------------------------------------------------------------------------

describe('write-back: every write site reaches the doc', () => {
  it('lists the write sites: a new `.entries =` in an edit composable needs a test here', () => {
    const count = (file: string) =>
      (fs.readFileSync(path.resolve(__dirname, '../composables', file), 'utf8').match(/\.entries = /g) ?? []).length;
    // useTrackerEditing: updateEntryAt (AHX branch + general), clearStep, deleteRowAndShiftUp,
    // insertRowAndShiftDown, clearInstrumentField, clearVolumeField, clearMacroField.
    expect(count('useTrackerEditing.ts')).toBe(8);
    // useTrackerSelection: transposeSelection, pasteFromClipboard, cutTrack, pasteTrack, transposeTrack,
    // cutPattern, pastePattern, transposePattern.
    expect(count('useTrackerSelection.ts')).toBe(8);
  });

  it('handleNoteEntry writes the note and its instrument (updateEntryAt)', () => {
    const h = harness();
    h.at(2, 0);
    h.editing.handleNoteEntry(50);
    h.store.syncAhxWriteBack();
    expect(h.docStep(0, 0, 2)).toMatchObject({ note: 27, instrument: 1 });
    // Overwriting a step replaces its note and keeps the rest.
    h.at(4, 0);
    h.editing.handleNoteEntry(52);
    h.store.syncAhxWriteBack();
    expect(h.docStep(0, 0, 4)).toMatchObject({ note: 29, instrument: 1, fx: 0xc, fxParam: 0x20 });
  });

  it('handleMacroInput writes the three nibbles of an effect; clearMacroNibble and clearMacroField take them out', () => {
    const h = harness();
    h.at(6, 0, 4, 0);
    h.editing.handleMacroInput('F');
    h.editing.handleMacroInput('0');
    h.editing.handleMacroInput('3');
    h.store.syncAhxWriteBack();
    expect(h.docStep(0, 0, 6)).toMatchObject({ note: 0, instrument: 0, fx: 0xf, fxParam: 3 });

    h.at(6, 0, 4, 2);
    h.editing.clearMacroNibble();
    h.store.syncAhxWriteBack();
    expect(h.docStep(0, 0, 6)).toMatchObject({ fx: 0xf, fxParam: 0 });

    h.at(6, 0, 4, 0);
    h.editing.clearMacroField();
    h.store.syncAhxWriteBack();
    expect(h.docStep(0, 0, 6)).toMatchObject({ fx: 0, fxParam: 0 });
  });

  it('clearStep, clearInstrumentField, deleteRowAndShiftUp and insertRowAndShiftDown', () => {
    const h = harness();
    h.at(4, 0);
    h.editing.clearStep();
    h.store.syncAhxWriteBack();
    expect(h.docStep(0, 0, 4)).toMatchObject({ note: 0, instrument: 0, fx: 0 });

    h.at(0, 0, 1);
    h.editing.clearInstrumentField();
    h.store.syncAhxWriteBack();
    expect(h.docStep(0, 0, 0)).toMatchObject({ note: 25, instrument: 0 });

    // Row 8 (note 30) shifts up onto row 7, then back down onto row 8.
    h.at(5, 0);
    h.editing.deleteRowAndShiftUp();
    h.store.syncAhxWriteBack();
    expect(h.docStep(0, 0, 7)).toMatchObject({ note: 30, instrument: 2 });
    expect(h.docStep(0, 0, 8)).toMatchObject({ note: 0 });
    h.at(5, 0);
    h.editing.insertRowAndShiftDown();
    h.store.syncAhxWriteBack();
    expect(h.docStep(0, 0, 8)).toMatchObject({ note: 30, instrument: 2 });
  });

  it('paste (selection), pasteTrack, cutTrack, pastePattern, cutPattern', () => {
    const h = harness();
    // Selection copy of rows 0..4 of channel 1, pasted on channel 2 at row 2.
    h.selection.onPatternStartSelection({ row: 0, trackIndex: 0 });
    h.selection.onPatternHoverSelection({ row: 4, trackIndex: 0 });
    h.selection.copySelectionToClipboard();
    h.at(2, 1);
    h.selection.pasteFromClipboard();
    h.store.syncAhxWriteBack();
    expect(h.docStep(0, 1, 2)).toMatchObject({ note: 25, instrument: 1 });
    expect(h.docStep(0, 1, 6)).toMatchObject({ note: 27, fx: 0xc, fxParam: 0x20 });

    // Track copy of channel 1, pasted on channel 3.
    h.at(0, 0);
    h.selection.copyTrack();
    h.at(0, 2);
    h.selection.pasteTrack();
    h.store.syncAhxWriteBack();
    expect(h.docStep(0, 2, 8)).toMatchObject({ note: 30, instrument: 2 });

    // Cut track: channel 3 is blank again.
    h.selection.cutTrack();
    h.store.syncAhxWriteBack();
    expect(h.docStep(0, 2, 8)).toMatchObject({ note: 0 });

    // Pattern copy of position 0, pasted over position 2, then cut.
    h.store.setCurrentPatternId('ahx-pos-0');
    h.selection.copyPattern();
    h.store.setCurrentPatternId('ahx-pos-2');
    h.selection.pastePattern();
    h.store.syncAhxWriteBack();
    expect(h.docStep(2, 0, 4)).toMatchObject({ note: 27, fx: 0xc });
    expect(h.docStep(2, 1, 6)).toMatchObject({ note: 27 });
    h.selection.cutPattern();
    h.store.syncAhxWriteBack();
    for (let c = 0; c < 4; c++) expect(h.docStep(2, c, 4)).toMatchObject({ note: 0 });
  });

  it('transposeSelection, transposeTrack and transposePattern move the notes and nothing else', () => {
    const h = harness();
    h.selection.onPatternStartSelection({ row: 0, trackIndex: 0 });
    h.selection.onPatternHoverSelection({ row: 0, trackIndex: 0 });
    h.selection.transposeSelection(2);
    h.store.syncAhxWriteBack();
    expect(h.docStep(0, 0, 0)).toMatchObject({ note: 27, instrument: 1 });
    expect(h.docStep(0, 0, 4)).toMatchObject({ note: 27, fx: 0xc });

    h.at(0, 0);
    h.selection.transposeTrack(-3);
    h.store.syncAhxWriteBack();
    expect(h.docStep(0, 0, 0)).toMatchObject({ note: 24 });
    expect(h.docStep(0, 0, 4)).toMatchObject({ note: 24, fx: 0xc, fxParam: 0x20 });

    h.selection.transposePattern(1);
    h.store.syncAhxWriteBack();
    expect(h.docStep(0, 0, 0)).toMatchObject({ note: 25 });
    expect(h.docStep(0, 0, 8)).toMatchObject({ note: 28 });
  });

  it('the watcher does the same without a synchronous call', async () => {
    const h = harness();
    h.at(2, 0);
    h.editing.handleNoteEntry(50);
    await nextTick();
    expect(h.docStep(0, 0, 2)).toMatchObject({ note: 27 });
  });
});

// ---------------------------------------------------------------------------
// Shared tracks, copy-on-write, exactness
// ---------------------------------------------------------------------------

describe('write-back: shared tracks, track 0, untouched cells', () => {
  it('a shared track is edited in place and every cell that shows it is re-projected', () => {
    const h = harness();
    expect(h.trackOf(0, 0)).toBe(h.trackOf(1, 0));
    h.at(2, 0);
    h.editing.handleNoteEntry(50);
    h.store.syncAhxWriteBack();
    expect(h.entryAt(1, 0, 2)).toMatchObject({ note: 'D-3' });
    expect(h.docStep(1, 0, 2)).toMatchObject({ note: 27 });
    // Both cells still point at the same track.
    expect(h.trackOf(0, 0)).toBe(h.trackOf(1, 0));
  });

  it('an effect-only edit does not add an instrument to the step (updateEntryAt)', () => {
    const h = harness();
    // Row 4 has an effect and an instrument; a fresh row has neither.
    h.at(10, 0, 4, 0);
    h.editing.handleMacroInput('C');
    h.editing.handleMacroInput('4');
    h.editing.handleMacroInput('0');
    h.store.syncAhxWriteBack();
    expect(h.docStep(0, 0, 10)).toMatchObject({ note: 0, instrument: 0, fx: 0xc, fxParam: 0x40 });
    // A step that has a note but no instrument keeps having none.
    h.store.patterns[0]!.tracks[0]!.entries = [...h.cell(0, 0).entries, { row: 12, note: 'C-3' }];
    h.store.syncAhxWriteBack();
    expect(h.docStep(0, 0, 12)).toMatchObject({ note: 25, instrument: 0 });
    h.at(12, 0, 4, 0);
    h.editing.handleMacroInput('F');
    h.store.syncAhxWriteBack();
    expect(h.docStep(0, 0, 12)).toMatchObject({ note: 25, instrument: 0, fx: 0xf });
  });

  it('typing into a blank cell gives it a track of its own: track 0 and the other blank cells stay blank', () => {
    const h = harness();
    expect(h.trackOf(0, 1)).toBe(0);
    expect(h.trackOf(0, 2)).toBe(0);
    h.at(3, 1);
    h.editing.handleNoteEntry(48);
    h.store.syncAhxWriteBack();
    const doc = h.store.ahxDoc as AhxDoc;
    expect(h.trackOf(0, 1)).not.toBe(0);
    expect(doc.tracks[0]!.every((s) => s.note === 0 && s.instrument === 0 && s.fx === 0)).toBe(true);
    expect(h.trackOf(0, 2)).toBe(0);
    expect(h.trackOf(1, 1)).toBe(0);
    expect(h.cell(0, 2).entries).toEqual([]);
    expect(h.cell(1, 1).entries).toEqual([]);
    expect(h.docStep(0, 1, 3)).toMatchObject({ note: 25, instrument: 1 });
  });

  it('notes 61, 62 and 63 survive an edit of their own effect and of their neighbours (clampNotes: false)', () => {
    let doc = fixtureDoc();
    for (const [row, note] of [[12, 61], [13, 62], [14, 63]] as const) {
      const r = setStep(doc, 1, row, step(note, 1));
      if (!r.ok) throw new Error(r.reason);
      doc = r.doc;
    }
    const h = harness(fixtureBytes(doc));
    expect(h.entryAt(0, 0, 12)!.note).toBe('C-6');
    // Their own effect...
    for (const row of [12, 13, 14]) {
      h.at(row, 0, 4, 0);
      h.editing.handleMacroInput('A');
    }
    // ... and a neighbour's note.
    h.at(11, 0);
    h.editing.handleNoteEntry(48);
    h.store.syncAhxWriteBack();
    expect([12, 13, 14].map((row) => h.docStep(0, 0, row).note)).toEqual([61, 62, 63]);
    expect(h.docStep(0, 0, 12).fx).toBe(0xa);
  });

  it('an edited cell keeps the text the user typed while the doc holds the normalized value', () => {
    const h = harness();
    h.at(10, 0, 4, 0);
    h.editing.handleMacroInput('F');
    h.store.syncAhxWriteBack();
    expect(h.entryAt(0, 0, 10)!.macro).toBe('F..');
    expect(h.docStep(0, 0, 10)).toMatchObject({ fx: 0xf, fxParam: 0 });
    // Converged: nothing more to write, and the text was not re-projected to F00.
    expect(h.store.syncAhxWriteBack()).toBe(false);
    expect(h.entryAt(0, 0, 10)!.macro).toBe('F..');
  });

  it('replacing an array with an equal one commits nothing (convergence by compare in doc space)', async () => {
    const h = harness();
    const before = h.store.ahxDoc;
    const revisionBefore = revision(h);
    // Same content, new identity: a blank cell on track 0, and a cell on a shared track.
    h.store.patterns[0]!.tracks[1]!.entries = [];
    h.store.patterns[0]!.tracks[0]!.entries = h.cell(0, 0).entries.map((e) => ({ ...e }));
    await nextTick();
    expect(h.store.ahxDoc).toBe(before);
    expect(revision(h)).toBe(revisionBefore);
    expect(h.trackOf(0, 1)).toBe(0);
  });

  it('what the format cannot hold is reverted from the doc, with a notice (the safety net)', () => {
    const h = harness();
    const before = h.store.ahxDoc;
    h.store.patterns[0]!.tracks[0]!.entries = [{ row: 0, note: 'C-3', volume: '40' }];
    expect(h.store.syncAhxWriteBack()).toBe(false);
    expect(h.store.ahxDoc).toBe(before);
    expect(h.entryAt(0, 0, 0)).toMatchObject({ note: 'C-3', instrument: '01' });
    expect(h.entryAt(0, 0, 0)!.volume).toBeUndefined();
    expect(noticeText()).toMatch(/no volume column/);
  });
});

// ---------------------------------------------------------------------------
// Refusals happen before the history step and the cursor
// ---------------------------------------------------------------------------

describe('pre-guards: a refusal leaves no history, no cursor move, no change', () => {
  type Case = [name: string, run: (h: Harness) => void, message: RegExp];
  const cases: Case[] = [
    ['### (insertNoteOff)', (h) => { h.at(2, 0); h.editing.insertNoteOff(); }, /no note-off/],
    ['volume nibble (handleVolumeInput)', (h) => { h.at(2, 0, 2); h.editing.handleVolumeInput('4'); }, /no volume column/],
    ['clearing a volume nibble', (h) => { h.at(2, 0, 3); h.editing.clearVolumeNibble(); }, /no volume column/],
    ['clearing the volume field', (h) => { h.at(2, 0, 3); h.editing.clearVolumeField(); }, /no volume column/],
    ['second effect column (macro2)', (h) => { h.at(2, 0, 5, 0); h.editing.handleMacroInput('1'); }, /one effect column/],
    ['clearing a macro2 nibble', (h) => { h.at(2, 0, 5, 0); h.editing.clearMacroNibble(); }, /one effect column/],
    ['a macro letter beyond F', (h) => { h.at(2, 0, 4, 0); h.editing.handleMacroInput('G'); }, /"G" is not an AHX effect/],
    ['instrument 64', (h) => { h.activeInstrumentId.value = '64'; h.at(2, 0); h.editing.handleNoteEntry(48); }, /up to 63/],
    ['a note above B-5', (h) => { h.at(2, 0); h.editing.handleNoteEntry(84); }, /C-1 to B-5/],
    ['a note below C-1', (h) => { h.at(2, 0); h.editing.handleNoteEntry(23); }, /C-1 to B-5/],
    ['an interpolation range', (h) => { h.at(2, 0, 4); h.editing.toggleInterpolationRange(); }, /no interpolation/],
  ];

  it.each(cases)('%s', (_name, run, message) => {
    const h = harness();
    const doc = h.store.ahxDoc;
    const grid = JSON.stringify(h.store.patterns);
    const history = h.store.undoStack.length;
    // The cursor is where `run` put it; a refusal must not advance it (a note
    // would step one row, a volume digit would move to the next column).
    run(h);
    const cursorAfter = h.cursor();
    h.at(cursorAfter.row, cursorAfter.track, cursorAfter.column, cursorAfter.nibble);
    expect(h.store.undoStack.length).toBe(history);
    expect(noticeText()).toMatch(message);
    expect(h.store.ahxDoc).toBe(doc);
    expect(JSON.stringify(h.store.patterns)).toBe(grid);
    expect(cursorAfter).toEqual({ row: 2, track: 0, column: cursorAfter.column, nibble: cursorAfter.nibble });
    // ... and the write-back finds nothing to do.
    expect(h.store.syncAhxWriteBack()).toBe(false);
  });

  it('the cursor does not move on a refused volume digit or note-off', () => {
    const h = harness();
    h.at(2, 0, 2);
    h.editing.handleVolumeInput('4');
    expect(h.cursor()).toEqual({ row: 2, track: 0, column: 2, nibble: 0 });
    h.at(2, 0, 0);
    h.editing.insertNoteOff();
    expect(h.cursor()).toEqual({ row: 2, track: 0, column: 0, nibble: 0 });
  });

  it('undo after a refusal undoes the previous real edit', () => {
    const h = harness();
    h.at(2, 0);
    h.editing.handleNoteEntry(50);
    h.at(3, 0, 2);
    h.editing.handleVolumeInput('4');
    expect(h.store.undoStack.length).toBe(1);
    h.store.undo();
    expect(h.docStep(0, 0, 2)).toMatchObject({ note: 0 });
    expect(h.entryAt(0, 0, 2)).toBeUndefined();
  });

  it('the same refusal twice is two notices (a repeat shows again); it clears itself and on a successful edit', () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.at(2, 0);
      h.editing.insertNoteOff();
      const first = ahxEditNotice.value!;
      h.editing.insertNoteOff();
      const second = ahxEditNotice.value!;
      expect(second.message).toBe(first.message);
      expect(second.id).toBeGreaterThan(first.id);
      vi.advanceTimersByTime(4100);
      expect(ahxEditNotice.value).toBeNull();

      h.editing.insertNoteOff();
      expect(ahxEditNotice.value).not.toBeNull();
      h.editing.handleNoteEntry(50);
      h.store.syncAhxWriteBack();
      expect(ahxEditNotice.value).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Bulk edits are all-or-nothing
// ---------------------------------------------------------------------------

describe('bulk edits: all or nothing', () => {
  function unchanged(h: Harness, run: () => void, message: RegExp) {
    const doc = h.store.ahxDoc;
    const grid = JSON.stringify(h.store.patterns);
    const history = h.store.undoStack.length;
    const mode = h.isEditMode.value;
    run();
    expect(h.store.undoStack.length).toBe(history);
    expect(h.store.ahxDoc).toBe(doc);
    expect(JSON.stringify(h.store.patterns)).toBe(grid);
    expect(h.isEditMode.value).toBe(mode);
    expect(noticeText()).toMatch(message);
  }

  it('a transpose that pushes one note out of C-1..B-5 changes nothing (selection, track, pattern)', () => {
    const h = harness();
    // Row 0 is note 25 (C-3), row 8 note 30: +36 leaves the range for both, +31 only for row 8.
    h.selection.onPatternStartSelection({ row: 0, trackIndex: 0 });
    h.selection.onPatternHoverSelection({ row: 8, trackIndex: 0 });
    unchanged(h, () => h.selection.transposeSelection(31), /C-1 to B-5/);
    h.at(0, 0);
    unchanged(h, () => h.selection.transposeTrack(31), /C-1 to B-5/);
    unchanged(h, () => h.selection.transposePattern(-25), /C-1 to B-5/);
    // In range, the same call works.
    h.selection.transposePattern(2);
    h.store.syncAhxWriteBack();
    expect(h.docStep(0, 0, 0).note).toBe(27);
    expect(h.store.undoStack.length).toBe(1);
  });

  it('a paste with one volume cell among valid ones pastes nothing', () => {
    const h = harness();
    h.selection.clipboard.value = {
      width: 1,
      height: 3,
      data: [[{ row: 0, note: 'C-3', instrument: '01' }], [{ row: 1, note: 'D-3', volume: '40' }], [{ row: 2, note: 'E-3' }]],
    };
    h.at(9, 1);
    unchanged(h, () => h.selection.pasteFromClipboard(), /no volume column/);
  });

  it('a paste taller than the remaining rows is refused whole, naming the rows', () => {
    const h = harness();
    h.selection.clipboard.value = {
      width: 1,
      height: 6,
      data: Array.from({ length: 6 }, (_, i) => [{ row: i, note: 'C-3' } as TrackerEntryData]),
    };
    h.at(ROWS - 3, 1);
    unchanged(h, () => h.selection.pasteFromClipboard(), /needs 19 rows; this song's tracks have 16/);
    // A paste that fits works.
    h.at(ROWS - 6, 1);
    h.selection.pasteFromClipboard();
    h.store.syncAhxWriteBack();
    expect(h.docStep(0, 1, ROWS - 1)).toMatchObject({ note: 25 });
  });

  it('a paste past the last channel is refused whole', () => {
    const h = harness();
    h.selection.clipboard.value = {
      width: 3,
      height: 1,
      data: [[{ row: 0, note: 'C-3' }, { row: 0, note: 'D-3' }, { row: 0, note: 'E-3' }]],
    };
    h.at(0, 2);
    unchanged(h, () => h.selection.pasteFromClipboard(), /exactly 4 channels/);
  });

  it('pasteTrack with a row past the end, a second effect or a frequency is refused whole', () => {
    const h = harness();
    h.selection.trackClipboard.value = { type: 'track', entries: [{ row: 0, note: 'C-3' }, { row: 20, note: 'D-3' }] };
    h.at(0, 1);
    unchanged(h, () => h.selection.pasteTrack(), /needs 21 rows/);
    h.selection.trackClipboard.value = { type: 'track', entries: [{ row: 0, note: 'C-3', macro2: 'F01' }] };
    unchanged(h, () => h.selection.pasteTrack(), /one effect column/);
    h.selection.trackClipboard.value = { type: 'track', entries: [{ row: 0, note: 'C-3', frequency: 440 }] };
    unchanged(h, () => h.selection.pasteTrack(), /exact frequency/);
    h.selection.trackClipboard.value = { type: 'track', entries: [{ row: 0, note: 'C-3', volumeCommand: '60' }] };
    unchanged(h, () => h.selection.pasteTrack(), /no volume column/);
  });

  it('pastePattern refuses a wider clipboard and does not grow the pattern', () => {
    const h = harness();
    h.selection.patternClipboard.value = {
      type: 'pattern',
      tracks: Array.from({ length: 5 }, (_, i) => ({ id: `T${i}`, name: 'x', entries: [{ row: 0, note: 'C-3' }] })),
    } as never;
    unchanged(h, () => h.selection.pastePattern(), /exactly 4 channels/);
    expect(h.store.patterns[0]!.tracks).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// One edit, one commit
// ---------------------------------------------------------------------------

describe('convergence: no applying flag, nothing commits twice', () => {
  it('one typed edit is exactly one doc commit and the watcher settles', async () => {
    const h = harness();
    const before = revision(h);
    h.at(2, 0);
    h.editing.handleNoteEntry(50);
    await nextTick();
    expect(revision(h)).toBe(before + 1);
    await nextTick();
    expect(h.store.syncAhxWriteBack()).toBe(false);
    expect(revision(h)).toBe(before + 1);
  });

  it('a paste over four cells of one shared track is one pass', async () => {
    // Four channels on one shared track.
    let doc = createNewAhxDoc({ trackLength: ROWS });
    const shared = (doc as AhxDoc).positions[0]!;
    doc = { ...doc, positions: [{ track: [1, 1, 1, 1], transpose: shared.transpose }] } as AhxDoc;
    const h = harness(fixtureBytes(doc));
    expect(new Set(h.store.ahxDoc!.positions[0]!.track).size).toBe(1);
    const before = revision(h);
    const payload = [{ row: 3, note: 'C-3', instrument: '01' }];
    for (let c = 0; c < 4; c++) h.store.patterns[0]!.tracks[c]!.entries = payload.map((e) => ({ ...e }));
    await nextTick();
    expect(revision(h)).toBe(before + 1);
    expect(h.docStep(0, 0, 3)).toMatchObject({ note: 25 });
    expect(h.store.syncAhxWriteBack()).toBe(false);
  });

  it('applySnapshot and loadSongFile commit nothing', async () => {
    const h = harness();
    h.at(2, 0);
    h.editing.handleNoteEntry(50);
    await nextTick();
    const commit = vi.spyOn(h.store, 'commitAhxDoc');

    h.store.undo();
    const undone = h.store.ahxDoc;
    await nextTick();
    expect(h.store.ahxDoc).toBe(undone);
    expect(commit).not.toHaveBeenCalled();

    const bytes = fixtureBytes();
    const file = importAhxToTrackerSong(toBuffer(bytes));
    h.store.loadSongFile(file);
    const loaded = h.store.ahxDoc;
    await nextTick();
    expect(h.store.ahxDoc).toBe(loaded);
    expect(commit).not.toHaveBeenCalled();
  });

  it('createSnapshot right after an un-flushed edit captures the edited doc', () => {
    const h = harness();
    h.at(2, 0);
    h.editing.handleNoteEntry(50);
    // No tick, no explicit sync: the watcher has not run.
    const snapshot = h.store.createSnapshot();
    const doc = snapshot.ahxDoc as AhxDoc;
    expect(doc.tracks[doc.positions[0]!.track[0] as number]![2]).toMatchObject({ note: 27 });
    expect(snapshot.patterns).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Undo / redo, the engine's bytes, capability split, stale docs
// ---------------------------------------------------------------------------

describe('undo, redo and the current bytes', () => {
  const noteAt = (bytes: Uint8Array | null, position: number, channel: number, row: number): number => {
    const song: AhxSong = parseAhx(bytes as Uint8Array);
    const track = song.positions[position]!.track[channel] as number;
    return song.tracks[track]![row]!.note;
  };

  it('after a grid edit currentAhxSource() parses to the edited song (the next Play plays the grid)', () => {
    const h = harness();
    expect(noteAt(currentAhxSource(), 0, 0, 2)).toBe(0);
    h.at(2, 0);
    h.editing.handleNoteEntry(50);
    h.store.flushAhxBytes();
    expect(noteAt(currentAhxSource(), 0, 0, 2)).toBe(27);
  });

  it('the watcher alone keeps the bytes current', async () => {
    const h = harness();
    h.at(5, 2);
    h.editing.handleNoteEntry(55);
    await nextTick();
    expect(noteAt(currentAhxSource(), 0, 2, 5)).toBe(32);
  });

  it('a flush that changed nothing keeps the identity of the bytes', () => {
    const h = harness();
    const bytes = currentAhxSource();
    h.store.flushAhxBytes();
    h.store.flushAhxBytes();
    expect(currentAhxSource()).toBe(bytes);
    h.at(2, 0);
    h.editing.handleNoteEntry(50);
    h.store.flushAhxBytes();
    const edited = currentAhxSource();
    expect(edited).not.toBe(bytes);
    h.store.flushAhxBytes();
    expect(currentAhxSource()).toBe(edited);
  });

  it('a cell edit leaves the preview token; undo (resetEdits) moves it', () => {
    const h = harness();
    const preview = currentAhxPreviewSource();
    expect(preview).toBe(currentAhxSource());
    h.at(2, 0);
    h.editing.handleNoteEntry(50);
    h.store.flushAhxBytes();
    expect(currentAhxSource()).not.toBe(preview);
    expect(currentAhxPreviewSource()).toBe(preview);
    h.store.undo();
    expect(currentAhxPreviewSource()).toBe(currentAhxSource());
    expect(currentAhxPreviewSource()).not.toBe(preview);
    expect(noteAt(currentAhxSource(), 0, 0, 2)).toBe(0);
  });

  it('undo and redo swap the doc and rebuild the grid from it', () => {
    const h = harness();
    const original = h.store.ahxDoc;
    h.at(2, 0);
    h.editing.handleNoteEntry(50);
    h.store.syncAhxWriteBack();
    const edited = h.store.ahxDoc;
    expect(edited).not.toBe(original);
    h.store.undo();
    expect(h.store.ahxDoc).toBe(original);
    expect(h.entryAt(0, 0, 2)).toBeUndefined();
    expect(h.entryAt(1, 0, 2)).toBeUndefined();
    h.store.redo();
    expect(h.store.ahxDoc).toBe(edited);
    expect(h.entryAt(1, 0, 2)).toMatchObject({ note: 'D-3' });
  });

  it('a snapshot of an editable AHX song holds the doc (by reference) and no grid', () => {
    const h = harness();
    const original = h.store.ahxDoc;
    h.at(2, 0);
    h.editing.handleNoteEntry(50);
    expect(h.store.undoStack).toHaveLength(1);
    expect(h.store.undoStack[0]!.ahxDoc).toBe(original);
    expect(h.store.undoStack[0]!.patterns).toEqual([]);
  });
});

describe('capability split and stale docs', () => {
  it('isAhxSong / isAhxEditable / isReadOnly for native, AHX with a doc, AHX without one, HVL', () => {
    const store = useTrackerStore();
    store.initializeIfNeeded();
    expect([store.isAhxSong, store.isAhxEditable, store.isReadOnly]).toEqual([false, false, false]);

    const { store: withDoc } = loadBytes(fixtureBytes());
    expect([withDoc.isAhxSong, withDoc.isAhxEditable, withDoc.isReadOnly]).toEqual([true, true, false]);

    // An AHX song file without its bytes (a saved file's fate): no doc, read-only.
    const bare = importAhxToTrackerSong(toBuffer(fixtureBytes()));
    const noBytes: TrackerSongFile = JSON.parse(JSON.stringify(bare)) as TrackerSongFile;
    store.loadSongFile(noBytes);
    expect([store.isAhxSong, store.isAhxEditable, store.isReadOnly]).toEqual([true, false, true]);
    expect(store.ahxDoc).toBeNull();

    const hvl = fs.readFileSync(path.resolve(__dirname, '../../public/demos/ahx/chiprolled.hvl'));
    store.loadSongFile(importAhxToTrackerSong(toBuffer(new Uint8Array(hvl))));
    expect([store.isAhxSong, store.isAhxEditable, store.isReadOnly]).toEqual([true, false, true]);
    expect(store.ahxDoc).toBeNull();
    expect(store.ahxRefusal({ kind: 'noteOff' })).toBeNull();
  });

  it('an AHX song\'s active instrument is its first filled slot (an AHX slot has no patch, and notes are written with it)', () => {
    const { store } = loadBytes(fixtureBytes());
    expect(pickActiveInstrumentId(store.instrumentSlots, null)).toBe('01');
    expect(pickActiveInstrumentId(store.instrumentSlots, '03')).toBe('03');
    expect(pickActiveInstrumentId(store.instrumentSlots, '09')).toBe('01');
  });

  it('the doc read back from the store is the one that was set (markRaw)', () => {
    const h = harness();
    const doc = h.store.ahxDoc as AhxDoc;
    expect(isReactive(doc)).toBe(false);
    expect(h.store.ahxDoc).toBe(doc);
    h.at(2, 0);
    h.editing.handleNoteEntry(50);
    h.store.syncAhxWriteBack();
    const next = h.store.ahxDoc as AhxDoc;
    expect(next).not.toBe(doc);
    expect(isReactive(next)).toBe(false);
    expect(h.store.createSnapshot().ahxDoc).toBe(next);
  });

  it('every path that installs another song clears the doc (native, XM-style file, doc-less AHX, new song, undo across a swap)', () => {
    const h = harness();
    const store = h.store;
    const revisionBefore = store.ahxRevision;

    // A native song file.
    const native = useTrackerStore().serializeSong();
    store.resetToNewSong();
    expect(store.ahxDoc).toBeNull();
    expect(store.ahxRevision).toBeGreaterThan(revisionBefore);

    loadBytes(fixtureBytes());
    expect(store.ahxDoc).not.toBeNull();
    store.loadSongFile({ ...native, data: { ...native.data, moduleFormat: 'native' } } as TrackerSongFile);
    expect(store.ahxDoc).toBeNull();
    expect(store.isReadOnly).toBe(false);

    // loadSongFile of an AHX song whose bytes are unknown.
    loadBytes(fixtureBytes());
    const bare = JSON.parse(JSON.stringify(importAhxToTrackerSong(toBuffer(fixtureBytes())))) as TrackerSongFile;
    store.loadSongFile(bare);
    expect(store.ahxDoc).toBeNull();
    expect(store.isReadOnly).toBe(true);

    // applySnapshot of a non-AHX snapshot on top of a doc.
    store.resetToNewSong();
    store.pushHistory();
    const nativeSnapshot = store.undoStack[0]!;
    loadBytes(fixtureBytes());
    expect(store.ahxDoc).not.toBeNull();
    store.applySnapshot(nativeSnapshot);
    expect(store.ahxDoc).toBeNull();
    expect(store.moduleFormat).toBe('native');
  });

  it('a song with no bytes offers no editing surface: pre-guards ask nothing and the write-back is idle', () => {
    const store = useTrackerStore();
    const bare = JSON.parse(JSON.stringify(importAhxToTrackerSong(toBuffer(fixtureBytes())))) as TrackerSongFile;
    store.loadSongFile(bare);
    expect(store.syncAhxWriteBack()).toBe(false);
    store.pushHistory();
    expect(store.undoStack).toHaveLength(0);
  });
});
