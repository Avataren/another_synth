import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, ref, toRef } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import {
  formatInstrumentId,
  midiToTrackerNote,
  normalizeInstrumentId,
  parseAhx,
  parseTrackerNoteSymbol,
} from '@another-synth/tracker-playback';
import { useTrackerStore } from 'src/stores/tracker-store';
import { useTrackerEditing, type TrackerEditingContext } from 'src/composables/useTrackerEditing';
import { useTrackerSelection, type TrackerSelectionContext } from 'src/composables/useTrackerSelection';
import { importAhxToTrackerSong } from 'src/audio/tracker/ahx-import';
import { ahxSourceInfo, currentAhxSource, setCurrentAhxSource } from 'src/audio/tracker/ahx-source';
import { ahxEditNotice, clearAhxEditNotice, reportAhxEditNotice } from 'src/audio/tracker/ahx-edit-notice';
import {
  ahxEditRefusal,
  docChannels,
  HVL_NOTE_63_REASON,
  projectAhxPatterns,
  tracksEqual,
  type AhxDoc,
  type AhxDocStep,
  type AhxEditGate,
} from 'src/audio/tracker/ahx-doc';
import type { TrackerSongBank } from 'src/audio/tracker/song-bank';
import type { TrackerEntryData } from 'src/components/tracker/tracker-types';

/**
 * plan-hvl-editing.md P2: the store's edit matrix for HVL songs, at 4 channels
 * (ring_modulation_test_song.hvl) and 10 (meltwater_10ch.hvl), through the real
 * store and the real editing and selection composables wired the way
 * `TrackerPage` wires them. Every gate (edit, undo/redo, snapshot, transpose,
 * paste, the second effect column, note 63) is exercised on the *last* channel,
 * which for the 10-channel song is one the old four-channel loops never saw.
 */
const DEMOS = path.resolve(__dirname, '../../public/demos/ahx');
const demo = (name: string): Uint8Array => new Uint8Array(fs.readFileSync(path.resolve(DEMOS, name)));
const toBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

function harness(bytes: Uint8Array) {
  const store = useTrackerStore();
  store.loadSongFile(importAhxToTrackerSong(toBuffer(bytes)));
  setCurrentAhxSource(bytes);
  const activeRow = ref(0);
  const activeTrack = ref(0);
  const activeColumn = ref(0);
  const activeMacroNibble = ref(0);
  const isEditMode = ref(true);
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
    flush: () => {
      store.syncAhxWriteBack();
    },
  };
  const editingContext: TrackerEditingContext = {
    activeRow,
    activeTrack,
    activeColumn,
    activeMacroNibble,
    isEditMode,
    stepSize: ref(1),
    baseOctave: ref(4),
    defaultBaseOctave: 4,
    activeInstrumentId: ref<string | null>('01'),
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
    normalizeVolumeChars: () => ['.', '.'],
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
  const doc = () => store.ahxDoc as AhxDoc;
  const docStep = (position: number, channel: number, row: number): AhxDocStep =>
    doc().tracks[doc().positions[position]!.track[channel]!]![row]!;
  const at = (row: number, track: number, column = 0, nibble = 0) => {
    activeRow.value = row;
    activeTrack.value = track;
    activeColumn.value = column;
    activeMacroNibble.value = nibble;
  };
  /** `run` must change nothing (doc, grid, history) and say `message`. */
  const unchanged = (run: () => void, message: RegExp) => {
    store.syncAhxWriteBack();
    clearAhxEditNotice();
    const before = store.ahxDoc;
    const grid = JSON.stringify(store.patterns);
    const history = store.undoStack.length;
    run();
    store.syncAhxWriteBack();
    expect(store.ahxDoc).toBe(before);
    expect(JSON.stringify(store.patterns)).toBe(grid);
    expect(store.undoStack.length).toBe(history);
    expect(ahxEditNotice.value?.message ?? null).toMatch(message);
  };
  return { store, editing, selection, doc, docStep, at, unchanged };
}

beforeEach(() => {
  setActivePinia(createPinia());
  clearAhxEditNotice();
});
afterEach(() => {
  setCurrentAhxSource(null);
  clearAhxEditNotice();
});

const FIXTURES = [
  { file: 'ring_modulation_test_song.hvl', channels: 4 },
  { file: 'meltwater_10ch.hvl', channels: 10 },
] as const;

for (const { file, channels } of FIXTURES) {
  const last = channels - 1;

  describe(`HVL edit matrix: ${file} (${channels} channels)`, () => {
    it('loads editable at its own width, and an unedited song keeps the file\'s bytes through every flush point', () => {
      const bytes = demo(file);
      const h = harness(bytes);
      expect(h.doc().format).toBe('hvl');
      expect(docChannels(h.doc())).toBe(channels);
      expect([h.store.isAhxSong, h.store.isAhxEditable, h.store.isReadOnly]).toEqual([true, true, false]);
      h.store.flushAhxBytes();
      h.store.createSnapshot();
      h.store.serializeSong();
      expect(currentAhxSource()).toBe(bytes);
    });

    it('edit: a note typed on the last channel lands in the doc and in the HVL bytes the engine gets', () => {
      const bytes = demo(file);
      const h = harness(bytes);
      h.at(1, last);
      h.editing.handleNoteEntry(50); // D-3, step note 27
      h.store.syncAhxWriteBack();
      expect(h.docStep(0, last, 1)).toMatchObject({ note: 27, instrument: 1 });
      expect(h.store.undoStack).toHaveLength(1);
      const published = currentAhxSource();
      expect(published).not.toBeNull();
      const song = parseAhx(published!);
      expect([song.format, song.channels]).toEqual(['hvl', channels]);
      expect(song.tracks[song.positions[0]!.track[last]!]![1]).toMatchObject({ note: 27, instrument: 1 });
      // The song still has its instruments: a grid edit must not change them
      // (RED at the P2 stop: HVL songs have no instrument slots, so
      // `buildAhxFile` writes none — .ai/p2-stop-notes.md).
      expect(song.instrumentNr).toBe(parseAhx(bytes).instrumentNr);
      expect(song.instruments).toEqual(parseAhx(bytes).instruments);
      // Tagged as what it is: the instrument page reads HVL's own format from it.
      expect(ahxSourceInfo.value?.format).toBe('hvl');
    });

    it('undo and redo: the edit goes and comes back, in the doc, the grid and the engine\'s bytes', () => {
      const bytes = demo(file);
      const h = harness(bytes);
      const original = h.doc();
      h.at(1, last);
      h.editing.handleNoteEntry(50);
      h.store.syncAhxWriteBack();
      const edited = h.doc();
      expect(edited).not.toBe(original);

      h.store.undo();
      expect(h.store.ahxDoc).toBe(original);
      expect(h.store.patterns[0]!.tracks[last]!.entries).toEqual(projectAhxPatterns(original)[0]!.tracks[last]!.entries);
      expect(parseAhx(currentAhxSource()!)).toEqual(parseAhx(bytes));

      h.store.redo();
      expect(h.docStep(0, last, 1)).toMatchObject({ note: 27, instrument: 1 });
      const song = parseAhx(currentAhxSource()!);
      expect(song.tracks[song.positions[0]!.track[last]!]![1]).toMatchObject({ note: 27 });
    });

    it('snapshot: carries the doc by reference and no grid; applying it puts doc, grid and bytes back', () => {
      const bytes = demo(file);
      const h = harness(bytes);
      const snapshot = h.store.createSnapshot();
      expect(snapshot.ahxDoc).toBe(h.doc());
      expect(snapshot.patterns).toEqual([]);
      h.at(0, last);
      h.editing.handleNoteEntry(52);
      h.store.syncAhxWriteBack();
      expect(h.doc()).not.toBe(snapshot.ahxDoc);
      h.store.applySnapshot(snapshot);
      expect(h.store.ahxDoc).toBe(snapshot.ahxDoc);
      expect(h.store.patterns.map((p) => p.tracks.length)).toEqual(h.doc().positions.map(() => channels));
      expect(parseAhx(currentAhxSource()!)).toEqual(parseAhx(bytes));
    });

    it('transpose: the last channel is set, published and undone; one past it is refused with a notice', () => {
      const bytes = demo(file);
      const h = harness(bytes);
      const was = h.doc().positions[0]!.transpose[last]!;
      const value = was === 5 ? 6 : 5;
      expect(h.store.setAhxPositionTranspose(0, last, was)).toBe(false); // same value: no-op, no history
      expect(h.store.undoStack).toHaveLength(0);
      expect(h.store.setAhxPositionTranspose(0, last, value)).toBe(true);
      expect(h.doc().positions[0]!.transpose[last]).toBe(value);
      expect(parseAhx(currentAhxSource()!).positions[0]!.transpose[last]).toBe(value);
      expect(h.store.undoStack).toHaveLength(1);
      h.store.undo();
      expect(h.doc().positions[0]!.transpose[last]).toBe(was);

      clearAhxEditNotice();
      const before = h.store.ahxDoc;
      expect(h.store.setAhxPositionTranspose(0, channels, 1)).toBe(false);
      expect(h.store.ahxDoc).toBe(before);
      expect(ahxEditNotice.value?.message).toMatch(/does not exist/);
    });

    it('paste: a selection lands on the last channel, a pattern paste covers every channel, a wider paste is refused', () => {
      const h = harness(demo(file));
      h.selection.onPatternStartSelection({ row: 0, trackIndex: 0 });
      h.selection.onPatternHoverSelection({ row: 3, trackIndex: 0 });
      h.selection.copySelectionToClipboard();
      h.at(0, last);
      h.selection.pasteFromClipboard();
      h.store.syncAhxWriteBack();
      for (let row = 0; row < 4; row++) expect(h.docStep(0, last, row), `row ${row}`).toEqual(h.docStep(0, 0, row));

      h.store.setCurrentPatternId('ahx-pos-0');
      h.selection.copyPattern();
      h.store.setCurrentPatternId('ahx-pos-1');
      h.selection.pastePattern();
      h.store.syncAhxWriteBack();
      const doc = h.doc();
      for (let c = 0; c < channels; c++) {
        const [from, to] = [doc.positions[0]!.track[c]!, doc.positions[1]!.track[c]!];
        expect(tracksEqual(doc.tracks[to]!, doc.tracks[from]!), `channel ${c + 1}`).toBe(true);
      }

      h.selection.clipboard.value = { width: 2, height: 1, data: [[{ row: 0, note: 'C-3' }, { row: 0, note: 'D-3' }]] };
      h.at(0, last);
      h.unchanged(() => h.selection.pasteFromClipboard(), new RegExp(`exactly ${channels} channels \\(this needs ${channels + 1}\\)`));
    });

    it('second effect column: typed on the last channel it lands in fxb/fxbParam', () => {
      const h = harness(demo(file));
      [['4', 0], ['1', 1], ['F', 2]].forEach(([char, nibble]) => {
        h.at(2, last, 5, nibble as number);
        h.editing.handleMacroInput(char as string);
      });
      h.store.syncAhxWriteBack();
      expect(h.docStep(0, last, 2)).toMatchObject({ fxb: 4, fxbParam: 0x1f });
      const song = parseAhx(currentAhxSource()!);
      expect(song.tracks[song.positions[0]!.track[last]!]![2]).toMatchObject({ fxb: 4, fxbParam: 0x1f });
    });

    it('note 63: refused before the edit with a notice, and reverted with one if it reaches the grid; never a writer throw', () => {
      const h = harness(demo(file));
      // The pre-guard (a paste of D-6, note 63): nothing changes, nothing is recorded.
      h.selection.clipboard.value = { width: 1, height: 1, data: [[{ row: 0, note: 'D-6', instrument: '01' }]] };
      h.at(0, last);
      h.unchanged(() => h.selection.pasteFromClipboard(), /note 63/);
      expect(ahxEditNotice.value?.message).toContain(HVL_NOTE_63_REASON);
      // The keyboard never reaches it (C-1..B-5).
      h.unchanged(() => h.editing.handleNoteEntry(86), /C-1 to B-5/);

      // The safety net: a write that skipped the guards is reverted, with the notice.
      clearAhxEditNotice();
      const before = h.store.ahxDoc;
      const cell = h.store.patterns[0]!.tracks[last]!;
      const shown = JSON.stringify(cell.entries);
      cell.entries = [{ row: 0, note: 'D-6', instrument: '01' } as TrackerEntryData];
      expect(h.store.syncAhxWriteBack()).toBe(false);
      expect(h.store.ahxDoc).toBe(before);
      expect(JSON.stringify(h.store.patterns[0]!.tracks[last]!.entries)).toBe(shown);
      expect(ahxEditNotice.value?.message).toMatch(/note 63/);
      expect(h.store.currentAhxBytes()).not.toBeNull();
    });
  });
}

describe('HVL edit rules leave AHX as it was', () => {
  it('an AHX step still refuses the second column and takes note 63; HVL takes the column and refuses the note', () => {
    const d6: TrackerEntryData[] = [{ row: 0, note: 'D-6' }];
    const fx2: TrackerEntryData[] = [{ row: 0, macro2: 'F01' }];
    expect(ahxEditRefusal({ kind: 'macro2' }, 64)).toBe('AHX steps have one effect column.');
    expect(ahxEditRefusal({ kind: 'entries', entries: d6 }, 64)).toBeNull();
    expect(ahxEditRefusal({ kind: 'entries', entries: fx2 }, 64)).toMatch(/one effect column/);
    expect(ahxEditRefusal({ kind: 'channels', count: 5 }, 64)).toBe('AHX songs have exactly 4 channels (this needs 5).');
    const hvl = { format: 'hvl', channels: 10 } as const;
    expect(ahxEditRefusal({ kind: 'macro2' }, 64, hvl)).toBeNull();
    expect(ahxEditRefusal({ kind: 'entries', entries: d6 }, 64, hvl)).toBe(`Row 0: ${HVL_NOTE_63_REASON}`);
    expect(ahxEditRefusal({ kind: 'entries', entries: fx2 }, 64, hvl)).toBeNull();
    expect(ahxEditRefusal({ kind: 'channels', count: 10 }, 64, hvl)).toBeNull();
  });
});
