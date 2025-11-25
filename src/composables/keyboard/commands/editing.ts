import type { KeyboardCommand } from '../types';

/**
 * Editing commands for entering notes, volumes, macros, and manipulating cells
 */
export const editingCommands: KeyboardCommand[] = [
  {
    key: 'Insert',
    description: 'Insert note-off',
    category: 'editing',
    handler: (ctx) => {
      ctx.insertNoteOff();
    }
  },
  {
    key: 'Insert',
    modifiers: { shift: true },
    description: 'Insert row and shift down',
    category: 'editing',
    handler: (ctx) => {
      ctx.insertRowAndShiftDown();
    }
  },
  {
    key: 'Delete',
    description: 'Clear current step',
    category: 'editing',
    handler: (ctx) => {
      ctx.clearStep();
    }
  },
  {
    key: 'Delete',
    modifiers: { shift: true },
    description: 'Delete row and shift up',
    category: 'editing',
    handler: (ctx) => {
      ctx.deleteRowAndShiftUp();
    }
  },
  {
    key: 'Delete',
    columnFilter: [2, 3, 4],
    description: 'Clear volume/macro field',
    category: 'editing',
    handler: (ctx) => {
      ctx.clearVolumeField();
      if (ctx.activeColumn.value === 4) {
        ctx.clearMacroField();
      }
    }
  }
];

/**
 * Create hex input commands for volume and macro editing
 * These are dynamically generated for 0-9 and A-F
 */
export function createHexInputCommands(): KeyboardCommand[] {
  const hexChars = '0123456789ABCDEF'.split('');
  const commands: KeyboardCommand[] = [];

  for (const hexChar of hexChars) {
    // Lowercase version
    commands.push({
      key: hexChar.toLowerCase(),
      columnFilter: [2, 3, 4],
      description: `Enter hex digit ${hexChar}`,
      category: 'editing',
      handler: (ctx, event) => {
        if (!event.repeat) {
          if (ctx.activeColumn.value === 4) {
            ctx.handleMacroInput(hexChar);
          } else {
            ctx.handleVolumeInput(hexChar);
          }
        }
      }
    });

    // Uppercase version (if different)
    if (hexChar !== hexChar.toLowerCase()) {
      commands.push({
        key: hexChar,
        columnFilter: [2, 3, 4],
        description: `Enter hex digit ${hexChar}`,
        category: 'editing',
        handler: (ctx, event) => {
          if (!event.repeat) {
            if (ctx.activeColumn.value === 4) {
              ctx.handleMacroInput(hexChar);
            } else {
              ctx.handleVolumeInput(hexChar);
            }
          }
        }
      });
    }
  }

  return commands;
}

/**
 * Create note entry commands from the note key map
 * These are dynamically generated based on the keyboard layout
 */
export function createNoteEntryCommands(noteKeyMap: Record<string, number>): KeyboardCommand[] {
  const commands: KeyboardCommand[] = [];

  for (const [keyCode, midi] of Object.entries(noteKeyMap)) {
    commands.push({
      key: keyCode,
      editModeOnly: true,
      columnFilter: 0,
      description: `Enter note (MIDI ${midi})`,
      category: 'editing',
      handler: (ctx, event) => {
        if (!event.repeat) {
          ctx.ensureActiveInstrument();
          ctx.handleNoteEntry(midi);
        }
      }
    });
  }

  return commands;
}
