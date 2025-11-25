import { ref, computed, type Ref, type ComputedRef } from 'vue';
import type { TrackerEntryData, TrackerSelectionRect } from 'src/components/tracker/tracker-types';
import type { TrackerPattern } from 'src/stores/tracker-store';

/**
 * Clipboard data structure
 */
export interface ClipboardData {
  width: number;
  height: number;
  data: (TrackerEntryData | null)[][];
}

/**
 * Dependencies required by the selection composable
 */
export interface TrackerSelectionContext {
  // State refs
  activeRow: Ref<number>;
  activeTrack: Ref<number>;
  isEditMode: Ref<boolean>;
  rowsCount: Ref<number>;
  currentPattern: ComputedRef<TrackerPattern | undefined>;

  // Functions
  pushHistory: () => void;
  parseTrackerNoteSymbol: (note?: string) => { isNoteOff: boolean; midi?: number };
  midiToTrackerNote: (midi: number) => string;
}

/**
 * Composable for managing tracker selection and clipboard operations
 *
 * Handles:
 * - Selection state (anchor, end, mouse selecting)
 * - Selection rectangle computation
 * - Copy/paste operations
 * - Transpose selection
 * - Mouse-based selection events
 *
 * @param context - Selection context with all dependencies
 */
export function useTrackerSelection(context: TrackerSelectionContext) {
  // Selection state
  const selectionAnchor = ref<{ row: number; trackIndex: number } | null>(null);
  const selectionEnd = ref<{ row: number; trackIndex: number } | null>(null);
  const isMouseSelecting = ref(false);

  // Clipboard state
  const clipboard = ref<ClipboardData | null>(null);

  /**
   * Compute the selection rectangle from anchor and end points
   */
  const selectionRect = computed<TrackerSelectionRect | null>(() => {
    if (!selectionAnchor.value || !selectionEnd.value) return null;
    if (!context.currentPattern.value) return null;
    const totalTracks = context.currentPattern.value.tracks.length;
    const maxRow = context.rowsCount.value - 1;
    if (totalTracks === 0 || maxRow < 0) return null;

    const startRow = Math.max(0, Math.min(selectionAnchor.value.row, selectionEnd.value.row));
    const endRow = Math.min(
      maxRow,
      Math.max(selectionAnchor.value.row, selectionEnd.value.row)
    );
    const startTrack = Math.max(
      0,
      Math.min(selectionAnchor.value.trackIndex, selectionEnd.value.trackIndex)
    );
    const endTrack = Math.min(
      totalTracks - 1,
      Math.max(selectionAnchor.value.trackIndex, selectionEnd.value.trackIndex)
    );

    if (startRow > endRow || startTrack > endTrack) return null;
    return { rowStart: startRow, rowEnd: endRow, trackStart: startTrack, trackEnd: endTrack };
  });

  /**
   * Clear the current selection
   */
  function clearSelection() {
    selectionAnchor.value = null;
    selectionEnd.value = null;
  }

  /**
   * Start a selection at the current cursor position
   */
  function startSelectionAtCursor() {
    selectionAnchor.value = { row: context.activeRow.value, trackIndex: context.activeTrack.value };
    selectionEnd.value = { row: context.activeRow.value, trackIndex: context.activeTrack.value };
  }

  /**
   * Handle mouse selection start event
   */
  function onPatternStartSelection(payload: { row: number; trackIndex: number }) {
    isMouseSelecting.value = true;
    context.activeRow.value = payload.row;
    context.activeTrack.value = payload.trackIndex;
    selectionAnchor.value = { ...payload };
    selectionEnd.value = { ...payload };
  }

  /**
   * Handle mouse selection hover event
   */
  function onPatternHoverSelection(payload: { row: number; trackIndex: number }) {
    if (!isMouseSelecting.value) return;
    context.activeRow.value = payload.row;
    context.activeTrack.value = payload.trackIndex;
    selectionEnd.value = { ...payload };
  }

  /**
   * Transpose selected notes by semitones
   */
  function transposeSelection(semitones: number) {
    if (!selectionRect.value) return;
    if (!context.currentPattern.value) return;
    if (!context.isEditMode.value) return;

    const rect = selectionRect.value;
    const pattern = context.currentPattern.value;

    context.pushHistory();

    for (let trackIndex = rect.trackStart; trackIndex <= rect.trackEnd; trackIndex += 1) {
      const track = pattern.tracks[trackIndex];
      if (!track) continue;

      track.entries = track.entries.map((entry) => {
        if (entry.row < rect.rowStart || entry.row > rect.rowEnd) return entry;

        const parsed = context.parseTrackerNoteSymbol(entry.note);
        if (parsed.isNoteOff || parsed.midi === undefined) return entry;

        let midi = parsed.midi + semitones;
        midi = Math.max(0, Math.min(127, midi));

        return {
          ...entry,
          note: context.midiToTrackerNote(midi)
        };
      });
    }
  }

  /**
   * Copy selected region to clipboard
   */
  function copySelectionToClipboard() {
    if (!selectionRect.value) return;
    if (!context.currentPattern.value) return;
    const rect = selectionRect.value;
    const pattern = context.currentPattern.value;
    const height = rect.rowEnd - rect.rowStart + 1;
    const width = rect.trackEnd - rect.trackStart + 1;
    const data: (TrackerEntryData | null)[][] = [];

    for (let rowOffset = 0; rowOffset < height; rowOffset += 1) {
      const rowIndex = rect.rowStart + rowOffset;
      const rowData: (TrackerEntryData | null)[] = [];
      for (let trackOffset = 0; trackOffset < width; trackOffset += 1) {
        const trackIndex = rect.trackStart + trackOffset;
        const track = pattern.tracks[trackIndex];
        if (!track) {
          rowData.push(null);
          continue;
        }
        const entry = track.entries.find((e) => e.row === rowIndex) ?? null;
        rowData.push(entry ? (JSON.parse(JSON.stringify(entry)) as TrackerEntryData) : null);
      }
      data.push(rowData);
    }

    clipboard.value = { width, height, data };
  }

  /**
   * Paste clipboard data at current cursor position
   */
  function pasteFromClipboard() {
    if (!clipboard.value) return;
    if (!context.currentPattern.value) return;
    if (!context.isEditMode.value) return;

    const clip = clipboard.value;
    const pattern = context.currentPattern.value;
    const totalTracks = pattern.tracks.length;
    const maxRow = context.rowsCount.value - 1;
    if (totalTracks === 0 || maxRow < 0) return;

    context.pushHistory();

    for (let trackOffset = 0; trackOffset < clip.width; trackOffset += 1) {
      const targetTrackIndex = context.activeTrack.value + trackOffset;
      if (targetTrackIndex < 0 || targetTrackIndex >= totalTracks) continue;

      const track = pattern.tracks[targetTrackIndex];
      if (!track) continue;

      let entries = track.entries.slice();

      for (let rowOffset = 0; rowOffset < clip.height; rowOffset += 1) {
        const targetRow = context.activeRow.value + rowOffset;
        if (targetRow < 0 || targetRow > maxRow) continue;

        const srcEntry = clip.data[rowOffset]?.[trackOffset] ?? null;

        // Remove any existing entry at this row
        entries = entries.filter((e) => e.row !== targetRow);

        if (srcEntry) {
          const cloned = JSON.parse(JSON.stringify(srcEntry)) as TrackerEntryData;
          cloned.row = targetRow;
          entries.push(cloned);
        }
      }

      entries.sort((a, b) => a.row - b.row);
      track.entries = entries;
    }
  }

  return {
    // State
    selectionAnchor,
    selectionEnd,
    isMouseSelecting,
    clipboard,
    selectionRect,

    // Functions
    clearSelection,
    startSelectionAtCursor,
    onPatternStartSelection,
    onPatternHoverSelection,
    transposeSelection,
    copySelectionToClipboard,
    pasteFromClipboard
  };
}
