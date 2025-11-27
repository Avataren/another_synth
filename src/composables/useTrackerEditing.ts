import { type Ref, type ComputedRef } from 'vue';
import type { TrackerEntryData } from 'src/components/tracker/tracker-types';
import type { TrackerPattern, InstrumentSlot } from 'src/stores/tracker-store';
import type { TrackerSongBank } from 'src/audio/tracker/song-bank';

/**
 * Dependencies required by the editing composable
 */
export interface TrackerEditingContext {
  // State refs
  activeRow: Ref<number>;
  activeTrack: Ref<number>;
  activeColumn: Ref<number>;
  activeMacroNibble: Ref<number>;
  isEditMode: Ref<boolean>;
  stepSize: Ref<number>;
  baseOctave: Ref<number>;
  defaultBaseOctave: number;
  activeInstrumentId: Ref<string | null>;
  rowsCount: Ref<number>;
  currentPattern: ComputedRef<TrackerPattern | undefined>;
  instrumentSlots: Ref<InstrumentSlot[]>;
  songBank: TrackerSongBank;
  toggleInterpolationRange: (row: number, trackIndex: number) => void;
  clearInterpolationRangeAt: (row: number, trackIndex: number) => void;

  // Functions
  pushHistory: () => void;
  moveRow: (delta: number) => void;
  formatInstrumentId: (slotNumber: number) => string;
  normalizeInstrumentId: (instrumentId?: string) => string | undefined;
  normalizeVolumeChars: (vol?: string) => [string, string];
  normalizeMacroChars: (macro?: string) => [string, string, string];
  midiToTrackerNote: (midi: number) => string;
  // Optional callback to mark track as having active notes (for visualizer)
  // Also provides instrumentId so the caller can set the audio node for visualization
  onNotePreview?: (trackIndex: number, instrumentId: string) => void;
}

/**
 * Composable for managing tracker editing operations
 *
 * Handles:
 * - Note entry and preview
 * - Volume input
 * - Macro input
 * - Row operations (insert/delete)
 * - Step operations (clear, note-off)
 * - Instrument management
 *
 * @param context - Editing context with all dependencies
 */
export function useTrackerEditing(context: TrackerEditingContext) {
  /**
   * Advance the cursor by the current step size
   */
  function advanceRowByStep() {
    context.moveRow(context.stepSize.value);
  }

  /**
   * Ensure there's a valid active instrument, or select the first available one
   */
  function ensureActiveInstrument() {
    if (context.activeInstrumentId.value) {
      const exists = context.instrumentSlots.value.some(
        (slot) =>
          slot.patchId &&
          context.formatInstrumentId(slot.slot) === context.activeInstrumentId.value
      );
      if (exists) return;
    }
    const firstWithPatch = context.instrumentSlots.value.find((slot) => slot.patchId);
    context.activeInstrumentId.value = firstWithPatch
      ? context.formatInstrumentId(firstWithPatch.slot)
      : null;
  }

  /**
   * Set the active instrument by slot number
   */
  function setActiveInstrument(slotNumber: number) {
    context.activeInstrumentId.value = context.formatInstrumentId(slotNumber);
  }

  /**
   * Update or create an entry at a specific row and track
   */
  function updateEntryAt(
    row: number,
    trackIndex: number,
    mutator: (entry: TrackerEntryData) => TrackerEntryData
  ) {
    if (!context.currentPattern.value) return;
    const tracks = context.currentPattern.value.tracks;
    const track = tracks[trackIndex];
    if (!track) return;

    const existing = track.entries.find((e) => e.row === row);
    const baseInstrument =
      context.activeInstrumentId.value ??
      context.normalizeInstrumentId(existing?.instrument) ??
      context.formatInstrumentId(trackIndex + 1);
    const draft: TrackerEntryData = existing
      ? { ...existing, instrument: existing.instrument ?? baseInstrument }
      : { row, instrument: baseInstrument };

    const mutated = mutator(draft);
    const filtered = track.entries.filter((e) => e.row !== row);
    filtered.push(mutated);
    filtered.sort((a, b) => a.row - b.row);

    track.entries = filtered;
  }

  /**
   * Insert a note-off (###) at the current position
   */
  function insertNoteOff() {
    if (!context.isEditMode.value) return;
    context.pushHistory();
    updateEntryAt(context.activeRow.value, context.activeTrack.value, (entry) => ({
      ...entry,
      note: '###'
    }));
    advanceRowByStep();
  }

  /**
   * Clear the entire step at the current position
   */
  function clearStep() {
    if (!context.isEditMode.value) return;
    if (!context.currentPattern.value) return;
    context.pushHistory();
    const track = context.currentPattern.value.tracks[context.activeTrack.value];
    if (!track) return;
    track.entries = track.entries.filter((e) => e.row !== context.activeRow.value);
    advanceRowByStep();
  }

  /**
   * Delete the current row and shift entries below it up
   */
  function deleteRowAndShiftUp() {
    if (!context.isEditMode.value) return;
    if (!context.currentPattern.value) return;
    context.pushHistory();
    const track = context.currentPattern.value.tracks[context.activeTrack.value];
    if (!track) return;

    const currentRow = context.activeRow.value;
    const maxRow = context.rowsCount.value - 1;

    // Remove entries at current row, shift entries below up by one
    track.entries = track.entries
      .filter((e) => e.row !== currentRow)
      .map((e) => {
        if (e.row > currentRow) {
          return { ...e, row: e.row - 1 };
        }
        return e;
      })
      .filter((e) => e.row <= maxRow);
  }

  /**
   * Insert a blank row at current position and shift entries down
   */
  function insertRowAndShiftDown() {
    if (!context.isEditMode.value) return;
    if (!context.currentPattern.value) return;
    context.pushHistory();
    const track = context.currentPattern.value.tracks[context.activeTrack.value];
    if (!track) return;

    const currentRow = context.activeRow.value;
    const maxRow = context.rowsCount.value - 1;

    // Shift entries at and below current row down by one
    track.entries = track.entries
      .map((e) => {
        if (e.row >= currentRow) {
          return { ...e, row: e.row + 1 };
        }
        return e;
      })
      .filter((e) => e.row <= maxRow);
  }

  /**
   * Check if an instrument has a patch assigned
   */
  function hasPatchForInstrument(instrumentId: string): boolean {
    return context.instrumentSlots.value.some(
      (slot) =>
        context.formatInstrumentId(slot.slot) === instrumentId && !!slot.patchId
    );
  }

  /**
   * Preview a note by playing it briefly
   */
  async function previewNote(instrumentId: string, midi: number, velocity = 100) {
    if (!hasPatchForInstrument(instrumentId)) return;
    await context.songBank.prepareInstrument(instrumentId);
    // Mark the active track as having a note playing (for waveform visualizer)
    // Also provide the instrumentId so caller can set the audio node
    context.onNotePreview?.(context.activeTrack.value, instrumentId);
    context.songBank.noteOn(instrumentId, midi, velocity);
    window.setTimeout(() => {
      context.songBank.noteOff(instrumentId, midi);
    }, 250);
  }

  /**
   * Apply the base octave offset to a MIDI note
   */
  function applyBaseOctave(midi: number): number {
    const offset = (context.baseOctave.value - context.defaultBaseOctave) * 12;
    const adjusted = midi + offset;
    return Math.max(0, Math.min(127, Math.round(adjusted)));
  }

  /**
   * Handle note entry from keyboard or MIDI
   */
  function handleNoteEntry(midi: number) {
    // Only enter notes when on the note column (column 0)
    if (context.activeColumn.value !== 0) return;

    const instrumentId =
      context.activeInstrumentId.value ??
      context.formatInstrumentId(context.activeTrack.value + 1);
    const adjustedMidi = applyBaseOctave(midi);

    if (!context.isEditMode.value) {
      void previewNote(instrumentId, adjustedMidi);
      return;
    }

    context.pushHistory();
    updateEntryAt(context.activeRow.value, context.activeTrack.value, (entry) => ({
      ...entry,
      note: context.midiToTrackerNote(adjustedMidi),
      instrument: instrumentId
    }));
    void previewNote(instrumentId, adjustedMidi);
    advanceRowByStep();
  }

  /**
   * Handle volume hexadecimal input
   */
  function handleVolumeInput(hexChar: string) {
    if (!context.isEditMode.value) return;
    context.pushHistory();
    const row = context.activeRow.value;
    const track = context.activeTrack.value;
    const nibbleIndex = context.activeColumn.value === 2 ? 0 : 1;
    updateEntryAt(row, track, (entry) => ({
      ...entry,
      volume: (() => {
        const chars = context.normalizeVolumeChars(entry.volume);
        if (chars[0] === '.') chars[0] = '0';
        if (chars[1] === '.') chars[1] = '0';
        chars[nibbleIndex] = hexChar;
        return chars.join('');
      })()
    }));
    advanceRowByStep();
    context.activeColumn.value = nibbleIndex === 0 ? 2 : 3;
  }

  /**
   * Handle macro hexadecimal input
   */
  function handleMacroInput(hexChar: string) {
    if (!context.isEditMode.value) return;
    if (context.activeColumn.value !== 4) return;
    context.pushHistory();
    const char = hexChar.toUpperCase();
    const nibbleIndex = context.activeMacroNibble.value;
    // First digit is the effect command (allow letters for macros/effects), remaining are hex params
    if (nibbleIndex === 0 && !/^[0-9A-Z]$/.test(char)) return;
    if (nibbleIndex > 0 && !/^[0-9A-F]$/.test(char)) return;

    const row = context.activeRow.value;
    const track = context.activeTrack.value;
    context.clearInterpolationRangeAt(row, track);
    updateEntryAt(row, track, (entry) => {
      const chars = context.normalizeMacroChars(entry.macro);
      chars[nibbleIndex] = char;
      return {
        ...entry,
        macro: chars.join('')
      };
    });

    if (nibbleIndex < 2) {
      context.activeMacroNibble.value = nibbleIndex + 1;
    } else {
      context.activeMacroNibble.value = 0;
      advanceRowByStep();
    }
    context.activeColumn.value = 4;
  }

  /**
   * Clear the instrument field at the current position
   */
  function clearInstrumentField() {
    if (!context.isEditMode.value) return;
    if (!context.currentPattern.value) return;
    if (context.activeColumn.value !== 1) return;

    context.pushHistory();
    const track = context.currentPattern.value.tracks[context.activeTrack.value];
    if (!track) return;
    const idx = track.entries.findIndex((e) => e.row === context.activeRow.value);
    if (idx === -1) return;

    const entry = track.entries[idx];
    if (!entry) return;

    const updatedEntry = { ...entry } as TrackerEntryData & { instrument?: string };
    delete updatedEntry.instrument;

    track.entries = track.entries.map((e, i) => (i === idx ? updatedEntry : e));
  }

  /**
   * Clear a single volume nibble at the current position
   */
  function clearVolumeNibble() {
    if (!context.isEditMode.value) return;
    if (context.activeColumn.value !== 2 && context.activeColumn.value !== 3) return;

    context.pushHistory();
    const row = context.activeRow.value;
    const track = context.activeTrack.value;
    const nibbleIndex = context.activeColumn.value === 2 ? 0 : 1;

    updateEntryAt(row, track, (entry) => ({
      ...entry,
      volume: (() => {
        const chars = context.normalizeVolumeChars(entry.volume);
        chars[nibbleIndex] = '.';
        return chars.join('');
      })()
    }));
  }

  /**
   * Clear the volume field at the current position
   */
  function clearVolumeField() {
    if (!context.isEditMode.value) return;
    if (!context.currentPattern.value) return;
    if (context.activeColumn.value !== 2 && context.activeColumn.value !== 3) return;

    context.pushHistory();
    const track = context.currentPattern.value.tracks[context.activeTrack.value];
    if (!track) return;
    const idx = track.entries.findIndex((e) => e.row === context.activeRow.value);
    if (idx === -1) return;

    const entry = track.entries[idx];
    if (!entry) return;

    const updatedEntry = { ...entry } as TrackerEntryData & { volume?: string };
    delete updatedEntry.volume;

    track.entries = track.entries.map((e, i) => (i === idx ? updatedEntry : e));
  }

  /**
   * Clear a single macro nibble at the current position
   */
  function clearMacroNibble() {
    if (!context.isEditMode.value) return;
    if (context.activeColumn.value !== 4) return;

    context.pushHistory();
    const row = context.activeRow.value;
    const track = context.activeTrack.value;
    const nibbleIndex = context.activeMacroNibble.value;

    updateEntryAt(row, track, (entry) => {
      const chars = context.normalizeMacroChars(entry.macro);
      chars[nibbleIndex] = '.';
      return {
        ...entry,
        macro: chars.join('')
      };
    });
  }

  /**
   * Clear the macro field at the current position
   */
  function clearMacroField() {
    if (!context.isEditMode.value) return;
    if (!context.currentPattern.value) return;
    if (context.activeColumn.value !== 4) return;

    context.pushHistory();
    const track = context.currentPattern.value.tracks[context.activeTrack.value];
    if (!track) return;
    const idx = track.entries.findIndex((e) => e.row === context.activeRow.value);
    if (idx === -1) return;

    const entry = track.entries[idx];
    if (!entry) return;

    context.clearInterpolationRangeAt(context.activeRow.value, context.activeTrack.value);

    const updatedEntry = { ...entry } as TrackerEntryData & { macro?: string };
    delete updatedEntry.macro;

    track.entries = track.entries.map((e, i) => (i === idx ? updatedEntry : e));
    context.activeMacroNibble.value = 0;
  }

  function toggleInterpolationRange() {
    if (!context.isEditMode.value) return;
    if (context.activeColumn.value !== 4) return;
    context.toggleInterpolationRange(context.activeRow.value, context.activeTrack.value);
  }

  return {
    // Functions
    ensureActiveInstrument,
    setActiveInstrument,
    handleNoteEntry,
    handleVolumeInput,
    handleMacroInput,
    clearInstrumentField,
    clearVolumeNibble,
    clearVolumeField,
    clearMacroNibble,
    clearMacroField,
    insertNoteOff,
    clearStep,
    deleteRowAndShiftUp,
    insertRowAndShiftDown,
    toggleInterpolationRange
  };
}
