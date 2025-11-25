import type { Ref } from 'vue';

/**
 * Modifiers for keyboard shortcuts
 */
export interface KeyboardModifiers {
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}

/**
 * Context object passed to keyboard command handlers
 * Contains all the state and methods needed by keyboard commands
 */
export interface TrackerKeyboardContext {
  // Current state
  activeRow: Ref<number>;
  activeTrack: Ref<number>;
  activeColumn: Ref<number>;
  activeMacroNibble: Ref<number>;
  isEditMode: Ref<boolean>;
  isFullscreen: Ref<boolean>;
  rowsCount: number;
  trackCount: number;

  // Selection
  selectionAnchor: Ref<{ row: number; trackIndex: number } | null>;
  selectionEnd: Ref<{ row: number; trackIndex: number } | null>;
  clearSelection: () => void;
  startSelectionAtCursor: () => void;
  copySelectionToClipboard: () => void;
  pasteFromClipboard: () => void;
  transposeSelection: (semitones: number) => void;

  // Navigation
  setActiveRow: (row: number) => void;
  moveRow: (delta: number) => void;
  moveColumn: (delta: number) => void;
  jumpToNextTrack: () => void;
  jumpToPrevTrack: () => void;

  // Editing
  handleNoteEntry: (midi: number) => void;
  handleVolumeInput: (hexChar: string) => void;
  handleMacroInput: (hexChar: string) => void;
  clearStep: () => void;
  clearVolumeField: () => void;
  clearMacroField: () => void;
  insertNoteOff: () => void;
  insertRowAndShiftDown: () => void;
  deleteRowAndShiftUp: () => void;
  ensureActiveInstrument: () => void;

  // Playback
  togglePatternPlayback: () => void;

  // UI
  toggleEditMode: () => void;
  toggleFullscreen: () => void;

  // Octave
  baseOctave: Ref<number>;
  setBaseOctaveInput: (octave: number) => void;

  // Store actions
  undo: () => void;
  redo: () => void;

  // Note mapping
  noteKeyMap: Record<string, number>;
}

/**
 * A keyboard command definition
 */
export interface KeyboardCommand {
  /** Primary key code (e.g., 'ArrowUp', 'F2', 'c') */
  key: string;

  /** Required modifiers */
  modifiers?: KeyboardModifiers;

  /** Only active in edit mode */
  editModeOnly?: boolean;

  /** Only active when NOT in edit mode */
  nonEditModeOnly?: boolean;

  /** Only active when on a specific column */
  columnFilter?: number | number[];

  /** Human-readable description */
  description: string;

  /** Command handler */
  handler: (context: TrackerKeyboardContext, event: KeyboardEvent) => void;

  /** Category for organization */
  category?: 'navigation' | 'editing' | 'selection' | 'playback' | 'transpose' | 'utility';
}

/**
 * Check if event modifiers match required modifiers
 */
export function matchesModifiers(event: KeyboardEvent, required?: KeyboardModifiers): boolean {
  if (!required) {
    // No modifiers required means none should be pressed
    return !event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey;
  }

  const ctrlOrMeta = event.ctrlKey || event.metaKey;
  const requiredCtrlOrMeta = required.ctrl || required.meta;

  return (
    (requiredCtrlOrMeta ? ctrlOrMeta : !ctrlOrMeta) &&
    (required.shift ? event.shiftKey : !event.shiftKey) &&
    (required.alt ? event.altKey : !event.altKey)
  );
}

/**
 * Check if a command should be executed given the current context
 */
export function shouldExecuteCommand(
  command: KeyboardCommand,
  context: TrackerKeyboardContext,
  event: KeyboardEvent
): boolean {
  // Check edit mode filter
  if (command.editModeOnly && !context.isEditMode.value) {
    return false;
  }
  if (command.nonEditModeOnly && context.isEditMode.value) {
    return false;
  }

  // Check column filter
  if (command.columnFilter !== undefined) {
    const columns = Array.isArray(command.columnFilter)
      ? command.columnFilter
      : [command.columnFilter];
    if (!columns.includes(context.activeColumn.value)) {
      return false;
    }
  }

  // Check key match (support both event.code for physical keys and event.key for character keys)
  if (event.code !== command.key && event.key !== command.key) {
    return false;
  }

  // Check modifiers
  if (!matchesModifiers(event, command.modifiers)) {
    return false;
  }

  return true;
}
