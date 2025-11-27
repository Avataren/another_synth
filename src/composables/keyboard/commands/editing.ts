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
    columnFilter: 0,
    description: 'Clear current step',
    category: 'editing',
    handler: (ctx) => {
      ctx.clearStep();
    }
  },
  {
    key: 'Delete',
    columnFilter: 1,
    description: 'Clear instrument field',
    category: 'editing',
    handler: (ctx) => {
      ctx.clearInstrumentField();
    }
  },
  {
    key: 'Delete',
    columnFilter: [2, 3],
    description: 'Clear volume field',
    category: 'editing',
    handler: (ctx) => {
      ctx.clearVolumeField();
    }
  },
  {
    key: 'Delete',
    columnFilter: 4,
    description: 'Clear macro field',
    category: 'editing',
    handler: (ctx) => {
      ctx.clearMacroField();
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
    key: 'KeyL',
    editModeOnly: true,
    columnFilter: 4,
    description: 'Toggle interpolation (effect column)',
    category: 'editing',
    handler: (ctx, event) => {
      if (!event.repeat) {
        ctx.toggleInterpolationRange();
      }
    }
  }
];

/**
 * Create input commands for the volume/effect column
 * - Hex digits (0-9, A-F) for volume + effect params
 * - Effect letters (G-Z) for effect/macro commands in the effect column
 */
export function createHexInputCommands(): KeyboardCommand[] {
  const hexChars = '0123456789ABCDEF'.split('');
  const effectLetters = 'GHIJKLMNOPQRSTUVWXYZ'.split('');
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

  // Effect command letters (effect column only)
  for (const letter of effectLetters) {
    const lower = letter.toLowerCase();
    commands.push({
      key: lower,
      columnFilter: 4,
      description: `Enter effect letter ${letter}`,
      category: 'editing',
      handler: (ctx, event) => {
        if (!event.repeat) {
          ctx.handleMacroInput(letter);
        }
      }
    });

    commands.push({
      key: letter,
      columnFilter: 4,
      description: `Enter effect letter ${letter}`,
      category: 'editing',
      handler: (ctx, event) => {
        if (!event.repeat) {
          ctx.handleMacroInput(letter);
        }
      }
    });
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
