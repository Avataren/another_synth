import { computed, ref, toRef } from 'vue';
import { vi } from 'vitest';
import { formatInstrumentId, midiToTrackerNote, normalizeInstrumentId, parseTrackerNoteSymbol } from '@another-synth/tracker-playback';
import { useTrackerStore } from 'src/stores/tracker-store';
import { useTrackerEditing, type TrackerEditingContext } from 'src/composables/useTrackerEditing';
import { useTrackerSelection, type TrackerSelectionContext } from 'src/composables/useTrackerSelection';
import { reportAhxEditNotice } from 'src/audio/tracker/ahx-edit-notice';
import type { AhxEditGate } from 'src/audio/tracker/ahx-doc';
import type { SidDoc, SidDocRow } from 'src/audio/tracker/sid-doc';
import type { TrackerSongBank } from 'src/audio/tracker/song-bank';
import { buildSidChainSong } from './sid-chain-song';

/**
 * The SID grid as `TrackerPage` wires it: the REAL store and the REAL editing
 * and selection composables (its `ahxEditGate`: active for an editable AHX
 * *or* SID song, the store's `ahxRefusal` answering for the song's format,
 * `flush` writing both formats back). `adopt` puts the song in the store
 * (default: `adoptSidDoc(doc)`); nothing writes into the doc but the store's
 * write-back of what the composables did. Needs an active Pinia.
 */
export function sidGridHarness(
  doc: SidDoc = buildSidChainSong(),
  adopt?: () => void,
  options: Pick<TrackerEditingContext, 'previewSongInstrumentNote'> = {},
) {
  const store = useTrackerStore();
  if (adopt) adopt();
  else store.adoptSidDoc(doc);
  const activeRow = ref(0);
  const activeTrack = ref(0);
  const activeColumn = ref(0);
  const activeMacroNibble = ref(0);
  const isEditMode = ref(true);
  const currentPattern = computed(() => store.patterns.find((p) => p.id === store.currentPatternId));
  const rowsCount = computed(() => store.currentPatternRows);
  const gate: AhxEditGate = {
    active: () => store.isAhxEditable || store.isSidEditable,
    refuse: (check) => {
      const reason = store.ahxRefusal(check);
      if (reason === null) return false;
      reportAhxEditNotice(reason);
      return true;
    },
    flush: () => {
      store.syncAhxWriteBack();
      store.syncSidWriteBack();
    },
  };
  const activeInstrumentId = ref<string | null>('01');
  const editingContext: TrackerEditingContext = {
    activeRow,
    activeTrack,
    activeColumn,
    activeMacroNibble,
    isEditMode,
    stepSize: ref(1),
    baseOctave: ref(4),
    defaultBaseOctave: 4,
    activeInstrumentId,
    rowsCount,
    currentPattern,
    instrumentSlots: toRef(store, 'instrumentSlots'),
    songBank: { prepareInstrument: vi.fn(), noteOn: vi.fn(), noteOff: vi.fn() } as unknown as TrackerSongBank,
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
    ...options,
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
  /** Put the cursor on grid position `position`, voice `track`, `row`, `column`. */
  const at = (position: number, track: number, row: number, column = 0, nibble = 0) => {
    store.setCurrentPatternId(`sid-pos-${position}`);
    activeTrack.value = track;
    activeRow.value = row;
    activeColumn.value = column;
    activeMacroNibble.value = nibble;
  };
  // Readers flush first, as every reader of the doc in the app does (a
  // snapshot, a save, a play); the watcher does the same a tick later.
  const sid = () => {
    store.syncSidWriteBack();
    return store.sidDoc as SidDoc;
  };
  const patternRow = (pattern: number, row: number): SidDocRow => sid().patterns[pattern]!.rows[row]!;
  /** Row `row` of voice `voice` of grid pattern `sid-pos-<position>` in the flat song (what the editor edits). */
  const flatRow = (position: number, voice: number, row: number): SidDocRow => {
    store.syncSidWriteBack();
    return store.sidFlat[store.sidSubsong]!.patterns[`sid-pos-${position}`]!.cells[voice]!.rows[row]!;
  };
  const entryAt = (position: number, track: number, row: number) => {
    store.syncSidWriteBack();
    return store.patterns[position]!.tracks[track]!.entries.find((e) => e.row === row);
  };
  return { store, editing, selection, at, sid, patternRow, flatRow, entryAt, activeInstrumentId };
}

