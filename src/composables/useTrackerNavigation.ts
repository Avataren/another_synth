import type { Ref, ComputedRef } from 'vue';
import type { TrackerPattern } from 'src/stores/tracker-store';

/**
 * Dependencies required by the navigation composable
 */
export interface TrackerNavigationContext {
  // State refs
  activeRow: Ref<number>;
  activeTrack: Ref<number>;
  activeColumn: Ref<number>;
  activeMacroNibble: Ref<number>;
  rowsCount: Ref<number>;
  currentPattern: ComputedRef<TrackerPattern | undefined>;

  /**
   * The semantic column indices a row shows, left to right (`visibleColumnIndices`):
   * a song without a volume column skips 2 and 3, one effect column stops at 4.
   */
  visibleColumns: Ref<readonly number[]>;

  // Functions
  clearSelection: () => void;
}

/**
 * Composable for managing tracker navigation and cursor movement
 *
 * Handles:
 * - Active row/cell positioning
 * - Cursor movement (row, column, track)
 * - Track jumping
 * - Bounds checking and wrapping
 *
 * @param context - Navigation context with all dependencies
 */
export function useTrackerNavigation(context: TrackerNavigationContext) {
  /**
   * Set the active row with bounds checking
   */
  function setActiveRow(row: number) {
    const count = context.rowsCount.value;
    const clamped = Math.min(count - 1, Math.max(0, row));
    context.activeRow.value = clamped;
  }

  /**
   * Set the active cell position
   */
  function setActiveCell(payload: {
    row: number;
    column: number;
    trackIndex: number;
    macroNibble?: number;
  }) {
    context.activeRow.value = payload.row;
    context.activeTrack.value = payload.trackIndex;
    context.activeColumn.value = payload.column;
    context.activeMacroNibble.value = payload.macroNibble ?? 0;
    // Clear selection when clicking on a specific cell
    context.clearSelection();
  }

  /**
   * Move the cursor up or down by delta rows
   */
  function moveRow(delta: number) {
    const count = context.rowsCount.value;
    if (count <= 0) return;
    const next = (context.activeRow.value + delta) % count;
    const wrapped = next < 0 ? next + count : next;
    context.activeRow.value = wrapped;
    context.activeMacroNibble.value = 0;
  }

  /**
   * Move the cursor left or right, handling column and track wrapping
   */
  function moveColumn(delta: number) {
    if (!context.currentPattern.value) return;

    // Special handling for macro column nibble navigation
    if ((context.activeColumn.value === 4 || context.activeColumn.value === 5) && delta !== 0) {
      const nextNibble = context.activeMacroNibble.value + delta;
      if (nextNibble >= 0 && nextNibble <= 2) {
        context.activeMacroNibble.value = nextNibble;
        return;
      }
    }

    const columns = context.visibleColumns.value;
    // A cursor left on a hidden column (the layout changed under it) steps
    // from the nearest visible column to its left.
    let position = columns.indexOf(context.activeColumn.value);
    if (position < 0) {
      position = columns.filter((column) => column < context.activeColumn.value).length - 1;
      if (delta < 0) position += 1;
    }
    const nextPosition = position + delta;

    // Wrap to previous track if moving left from first column
    if (nextPosition < 0) {
      context.activeTrack.value =
        (context.activeTrack.value - 1 + context.currentPattern.value.tracks.length) %
        context.currentPattern.value.tracks.length;
      context.activeColumn.value = columns[columns.length - 1]!;
      context.activeMacroNibble.value = 0;
      return;
    }

    // Wrap to next track if moving right from last column
    if (nextPosition >= columns.length) {
      context.activeTrack.value =
        (context.activeTrack.value + 1) % context.currentPattern.value.tracks.length;
      context.activeColumn.value = 0;
      context.activeMacroNibble.value = 0;
      return;
    }

    // Normal column movement
    context.activeColumn.value = columns[nextPosition]!;
    if (context.activeColumn.value !== 4) {
      context.activeMacroNibble.value = 0;
    }
  }

  /**
   * Jump to the next track
   */
  function jumpToNextTrack() {
    if (!context.currentPattern.value) return;
    context.activeTrack.value =
      (context.activeTrack.value + 1) % context.currentPattern.value.tracks.length;
    context.activeColumn.value = 0;
  }

  /**
   * Jump to the previous track
   */
  function jumpToPrevTrack() {
    if (!context.currentPattern.value) return;
    context.activeTrack.value =
      (context.activeTrack.value - 1 + context.currentPattern.value.tracks.length) %
      context.currentPattern.value.tracks.length;
    context.activeColumn.value = 0;
  }

  return {
    setActiveRow,
    setActiveCell,
    moveRow,
    moveColumn,
    jumpToNextTrack,
    jumpToPrevTrack
  };
}
