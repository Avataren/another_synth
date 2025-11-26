import type { KeyboardCommand, TrackerKeyboardContext } from './types';
import { shouldExecuteCommand } from './types';
import { navigationCommands } from './commands/navigation';
import { selectionCommands } from './commands/selection';
import { editingCommands, createHexInputCommands, createNoteEntryCommands } from './commands/editing';
import { playbackCommands } from './commands/playback';
import { transposeCommands } from './commands/transpose';
import { trackPatternCommands } from './commands/trackPattern';
import { utilityCommands } from './commands/utility';

// Keys that should be throttled when held down
const THROTTLED_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown']);
const THROTTLE_MS = 30; // ~33fps for smooth navigation

/**
 * Composable for handling all tracker keyboard shortcuts
 *
 * This provides a declarative, testable way to manage keyboard commands.
 * Commands are organized by category and can be easily extended.
 *
 * @param context - The tracker keyboard context with all state and handlers
 * @returns Keyboard event handler and command registry
 */
export function useTrackerKeyboard(context: TrackerKeyboardContext) {
  // Build the complete command registry
  const commands: KeyboardCommand[] = [
    // Order matters! More specific commands should come first
    // (e.g., Shift+Arrow before Arrow, Ctrl+Shift+Z before Ctrl+Z)
    ...transposeCommands,
    ...trackPatternCommands,
    ...selectionCommands,
    ...editingCommands,
    ...createHexInputCommands(),
    ...createNoteEntryCommands(context.noteKeyMap),
    ...navigationCommands,
    ...playbackCommands,
    ...utilityCommands
  ];

  // Throttle state for navigation keys
  let lastNavigationTime = 0;
  let lastNavigationKey = '';

  /**
   * Main keyboard event handler
   * Call this from the component's @keydown handler
   */
  function handleKeyDown(event: KeyboardEvent): boolean {
    // Don't process keyboard events from input fields
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
      return false;
    }

    // Throttle navigation keys when held down (repeat events)
    if (event.repeat && THROTTLED_KEYS.has(event.key)) {
      const now = performance.now();
      if (event.key === lastNavigationKey && now - lastNavigationTime < THROTTLE_MS) {
        event.preventDefault();
        return true; // Consumed but throttled
      }
      lastNavigationTime = now;
      lastNavigationKey = event.key;
    }

    // Find the first matching command
    for (const command of commands) {
      if (shouldExecuteCommand(command, context, event)) {
        event.preventDefault();
        command.handler(context, event);
        return true;
      }
    }

    return false;
  }

  /**
   * Get all registered commands (useful for documentation/debugging)
   */
  function getCommands(): KeyboardCommand[] {
    return commands;
  }

  /**
   * Get commands by category
   */
  function getCommandsByCategory(category: string): KeyboardCommand[] {
    return commands.filter(cmd => cmd.category === category);
  }

  /**
   * Generate human-readable shortcut documentation
   */
  function generateShortcutDocs(): string {
    const categories = ['navigation', 'editing', 'selection', 'playback', 'transpose', 'utility'];
    let docs = '# Tracker Keyboard Shortcuts\n\n';

    for (const category of categories) {
      const categoryCommands = getCommandsByCategory(category);
      if (categoryCommands.length === 0) continue;

      docs += `## ${category.charAt(0).toUpperCase() + category.slice(1)}\n\n`;

      for (const cmd of categoryCommands) {
        const modifiers = [];
        if (cmd.modifiers?.ctrl || cmd.modifiers?.meta) modifiers.push('Ctrl');
        if (cmd.modifiers?.shift) modifiers.push('Shift');
        if (cmd.modifiers?.alt) modifiers.push('Alt');

        const shortcut = [...modifiers, cmd.key].join('+');
        docs += `- **${shortcut}**: ${cmd.description}\n`;
      }

      docs += '\n';
    }

    return docs;
  }

  return {
    handleKeyDown,
    getCommands,
    getCommandsByCategory,
    generateShortcutDocs
  };
}

/**
 * Export command modules for testing
 */
export {
  navigationCommands,
  selectionCommands,
  editingCommands,
  playbackCommands,
  transposeCommands,
  trackPatternCommands,
  utilityCommands,
  createHexInputCommands,
  createNoteEntryCommands
};
