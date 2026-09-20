import { ref, computed, type Ref, type ComputedRef } from 'vue';
import type { TrackerEntryData, TrackerTrackData, TrackerSelectionRect } from 'src/components/tracker/tracker-types';
import type { TrackerPattern } from 'src/stores/tracker-store';
import type { AhxEditGate } from 'src/audio/tracker/ahx-doc/edit-guard';

/**
 * Clipboard data structure for selection copy/paste
 */
export interface ClipboardData {
  width: number;
  height: number;
  data: (TrackerEntryData | null)[][];
}

/**
 * Clipboard data structure for track copy/paste
 */
export interface TrackClipboardData {
  type: 'track';
  entries: TrackerEntryData[];
}

/**
 * Clipboard data structure for pattern copy/paste
 */
export interface PatternClipboardData {
  type: 'pattern';
  tracks: TrackerTrackData[];
}

/**
 * Dependencies required by the selection composable
 */
export interface TrackerSelectionContext {
  // State refs
  activeRow: Ref<number>;
  activeTrack: Ref<number>;
  isEditMode: Ref<boolean>;
  /**
   * The song cannot be edited at all (an AHX/HVL row model). The track and
   * pattern operations below switch edit mode on themselves before they
   * write, so `isEditMode` alone would not stop them.
   */
  isReadOnly?: Readonly<Ref<boolean>>;
  rowsCount: Ref<number>;
  currentPattern: ComputedRef<TrackerPattern | undefined>;

  // Functions
  pushHistory: () => void;
  parseTrackerNoteSymbol: (note?: string) => { isNoteOff: boolean; midi?: number };
  midiToTrackerNote: (midi: number) => string;
  /**
   * Set when the store can hold an editable AHX song. Its bulk edits are then
   * all-or-nothing: the whole result is checked against what an AHX step can
   * hold *before* the undo snapshot, and one entry that cannot be written
   * refuses the whole edit.
   */
  ahx?: AhxEditGate;
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

  const inAhxSong = (): boolean => context.ahx?.active() ?? false;

  /**
   * The notes of `entries` moved by `semitones` (MIDI 0..127, as a tracker
   * always did), as new entries. For an AHX song a note that would leave the
   * format's range refuses the whole edit: `null`, and the gate has said why.
   */
  function transposedEntries(entries: TrackerEntryData[], semitones: number, inRange: (row: number) => boolean): TrackerEntryData[] | null {
    const out: TrackerEntryData[] = [];
    for (const entry of entries) {
      if (!inRange(entry.row)) {
        out.push(entry);
        continue;
      }
      const parsed = context.parseTrackerNoteSymbol(entry.note);
      if (parsed.isNoteOff || parsed.midi === undefined) {
        out.push(entry);
        continue;
      }
      const midi = Math.max(0, Math.min(127, parsed.midi + semitones));
      if (inAhxSong() && context.ahx?.refuse({ kind: 'note', midi })) return null;
      out.push({ ...entry, note: context.midiToTrackerNote(midi) });
    }
    return out;
  }

  // Clipboard state
  const clipboard = ref<ClipboardData | null>(null);
  const trackClipboard = ref<TrackClipboardData | null>(null);
  const patternClipboard = ref<PatternClipboardData | null>(null);

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

    const inSelection = (row: number) => row >= rect.rowStart && row <= rect.rowEnd;
    const results: { trackIndex: number; entries: TrackerEntryData[] }[] = [];
    for (let trackIndex = rect.trackStart; trackIndex <= rect.trackEnd; trackIndex += 1) {
      const track = pattern.tracks[trackIndex];
      if (!track) continue;
      const entries = transposedEntries(track.entries, semitones, inSelection);
      if (entries === null) return;
      results.push({ trackIndex, entries });
    }

    context.pushHistory();
    for (const { trackIndex, entries } of results) {
      const track = pattern.tracks[trackIndex];
      if (track) track.entries = entries;
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

    // What each target track would hold after the paste, worked out before
    // anything is written: an AHX paste is all-or-nothing (a row past the end
    // of the song's tracks, a volume or a second effect a step cannot hold
    // refuses it whole), while the other formats clip to the pattern as ever.
    const ahx = inAhxSong();
    if (ahx && context.ahx?.refuse({ kind: 'channels', count: Math.max(clip.width, totalTracks) })) return;
    // The rows the paste needs, named once: the last one it would write.
    const lastRow = context.activeRow.value + clip.height - 1;
    if (ahx && lastRow > maxRow && context.ahx?.refuse({ kind: 'entries', entries: [{ row: lastRow }] })) return;
    const results: { trackIndex: number; entries: TrackerEntryData[] }[] = [];
    for (let trackOffset = 0; trackOffset < clip.width; trackOffset += 1) {
      const targetTrackIndex = context.activeTrack.value + trackOffset;
      if (targetTrackIndex < 0 || targetTrackIndex >= totalTracks) {
        // Past the last channel: clipped, except in an AHX song.
        if (ahx && context.ahx?.refuse({ kind: 'channels', count: context.activeTrack.value + clip.width })) return;
        continue;
      }

      const track = pattern.tracks[targetTrackIndex];
      if (!track) continue;

      let entries = track.entries.slice();

      for (let rowOffset = 0; rowOffset < clip.height; rowOffset += 1) {
        const targetRow = context.activeRow.value + rowOffset;
        if (targetRow < 0 || targetRow > maxRow) {
          if (ahx && context.ahx?.refuse({ kind: 'entries', entries: [{ row: targetRow }] })) return;
          continue;
        }

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
      if (ahx && context.ahx?.refuse({ kind: 'entries', entries })) return;
      results.push({ trackIndex: targetTrackIndex, entries });
    }

    context.pushHistory();
    for (const { trackIndex, entries } of results) {
      const track = pattern.tracks[trackIndex];
      if (track) track.entries = entries;
    }
  }

  // ============================================
  // Track operations
  // ============================================

  /**
   * Copy the current track to clipboard
   */
  function copyTrack() {
    if (!context.currentPattern.value) return;
    const track = context.currentPattern.value.tracks[context.activeTrack.value];
    if (!track) return;

    trackClipboard.value = {
      type: 'track',
      entries: JSON.parse(JSON.stringify(track.entries))
    };
  }

  /**
   * Cut the current track (copy and clear)
   */
  function cutTrack() {
    if (context.isReadOnly?.value) return;
    if (!context.currentPattern.value) return;

    copyTrack();

    // Auto-enable edit mode for modifications
    context.isEditMode.value = true;
    context.pushHistory();

    const track = context.currentPattern.value.tracks[context.activeTrack.value];
    if (track) {
      track.entries = [];
    }
  }

  /**
   * Paste track from clipboard to current track
   */
  function pasteTrack() {
    if (context.isReadOnly?.value) return;
    if (!trackClipboard.value) return;
    if (!context.currentPattern.value) return;

    const pasted = JSON.parse(JSON.stringify(trackClipboard.value.entries)) as TrackerEntryData[];
    // All-or-nothing in an AHX song: before edit mode is switched on, before the snapshot.
    if (inAhxSong() && context.ahx?.refuse({ kind: 'entries', entries: pasted })) return;

    // Auto-enable edit mode for modifications
    context.isEditMode.value = true;
    context.pushHistory();

    const track = context.currentPattern.value.tracks[context.activeTrack.value];
    if (track) {
      track.entries = pasted;
    }
  }

  /**
   * Transpose all notes in the current track
   */
  function transposeTrack(semitones: number) {
    if (context.isReadOnly?.value) return;
    if (!context.currentPattern.value) return;

    const track = context.currentPattern.value.tracks[context.activeTrack.value];
    if (!track) return;

    const transposed = transposedEntries(track.entries, semitones, () => true);
    if (transposed === null) return;

    // Auto-enable edit mode for modifications
    context.isEditMode.value = true;
    context.pushHistory();

    track.entries = transposed;
  }

  // ============================================
  // Pattern operations
  // ============================================

  /**
   * Copy the entire current pattern to clipboard
   */
  function copyPattern() {
    if (!context.currentPattern.value) return;

    patternClipboard.value = {
      type: 'pattern',
      tracks: JSON.parse(JSON.stringify(context.currentPattern.value.tracks))
    };
  }

  /**
   * Cut the entire current pattern (copy and clear all tracks)
   */
  function cutPattern() {
    if (context.isReadOnly?.value) return;
    if (!context.currentPattern.value) return;

    copyPattern();

    // Auto-enable edit mode for modifications
    context.isEditMode.value = true;
    context.pushHistory();

    context.currentPattern.value.tracks.forEach((track) => {
      track.entries = [];
    });
  }

  /**
   * Paste pattern from clipboard to current pattern
   */
  function pastePattern() {
    if (context.isReadOnly?.value) return;
    if (!patternClipboard.value) return;
    if (!context.currentPattern.value) return;

    const currentTracks = context.currentPattern.value.tracks;
    const clipTracks = patternClipboard.value.tracks;

    if (inAhxSong() && context.ahx) {
      // An AHX pattern is four channels and never grows: a wider clipboard, or
      // one row a step cannot hold, refuses the paste whole.
      if (context.ahx.refuse({ kind: 'channels', count: Math.max(clipTracks.length, currentTracks.length) })) return;
      for (const clipTrack of clipTracks) {
        if (context.ahx.refuse({ kind: 'entries', entries: clipTrack.entries })) return;
      }
    }

    // Auto-enable edit mode for modifications
    context.isEditMode.value = true;
    context.pushHistory();

    // Expand the current pattern to fit the clipboard tracks if needed
    const tracksNeeded = clipTracks.length - currentTracks.length;
    if (tracksNeeded > 0) {
      const maxTracks = 32;
      const currentCount = currentTracks.length;
      const tracksToAdd = Math.min(tracksNeeded, maxTracks - currentCount);

      const DEFAULT_TRACK_COLORS = [
        '#4df2c5',
        '#9da6ff',
        '#ffde7b',
        '#70c2ff',
        '#ff9db5',
        '#8ef5c5',
        '#ffa95e',
        '#b08bff'
      ];

      for (let i = 0; i < tracksToAdd; i++) {
        const nextIndex = currentTracks.length;
        const newTrack = {
          id: `T${(nextIndex + 1).toString().padStart(2, '0')}`,
          name: `Track ${nextIndex + 1}`,
          color: DEFAULT_TRACK_COLORS[nextIndex % DEFAULT_TRACK_COLORS.length] ?? '#4df2c5',
          entries: []
        };
        currentTracks.push(newTrack);
      }
    }

    // Paste as many tracks as we can fit
    for (let i = 0; i < Math.min(currentTracks.length, clipTracks.length); i++) {
      const srcTrack = clipTracks[i];
      const dstTrack = currentTracks[i];
      if (srcTrack && dstTrack) {
        dstTrack.entries = JSON.parse(JSON.stringify(srcTrack.entries));
      }
    }
  }

  /**
   * Transpose all notes in the entire current pattern
   */
  function transposePattern(semitones: number) {
    if (context.isReadOnly?.value) return;
    if (!context.currentPattern.value) return;

    const tracks = context.currentPattern.value.tracks;
    const results: TrackerEntryData[][] = [];
    for (const track of tracks) {
      const transposed = transposedEntries(track.entries, semitones, () => true);
      if (transposed === null) return;
      results.push(transposed);
    }

    // Auto-enable edit mode for modifications
    context.isEditMode.value = true;
    context.pushHistory();

    tracks.forEach((track, index) => {
      track.entries = results[index] as TrackerEntryData[];
    });
  }

  return {
    // State
    selectionAnchor,
    selectionEnd,
    isMouseSelecting,
    clipboard,
    trackClipboard,
    patternClipboard,
    selectionRect,

    // Selection functions
    clearSelection,
    startSelectionAtCursor,
    onPatternStartSelection,
    onPatternHoverSelection,
    transposeSelection,
    copySelectionToClipboard,
    pasteFromClipboard,

    // Track functions
    copyTrack,
    cutTrack,
    pasteTrack,
    transposeTrack,

    // Pattern functions
    copyPattern,
    cutPattern,
    pastePattern,
    transposePattern
  };
}
