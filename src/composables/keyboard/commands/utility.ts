import type { KeyboardCommand } from '../types';

/**
 * Utility commands for UI toggles and undo/redo
 */
export const utilityCommands: KeyboardCommand[] = [
  {
    key: 'F2',
    description: 'Toggle edit mode',
    category: 'utility',
    handler: (ctx) => {
      ctx.toggleEditMode();
    }
  },
  {
    key: 'F10',
    description: 'Toggle fullscreen',
    category: 'utility',
    handler: (ctx) => {
      ctx.toggleFullscreen();
    }
  },
  {
    key: 'z',
    modifiers: { ctrl: true },
    description: 'Undo',
    category: 'utility',
    handler: (ctx) => {
      ctx.undo();
    }
  },
  {
    key: 'Z',
    modifiers: { ctrl: true },
    description: 'Undo',
    category: 'utility',
    handler: (ctx) => {
      ctx.undo();
    }
  },
  {
    key: 'y',
    modifiers: { ctrl: true },
    description: 'Redo',
    category: 'utility',
    handler: (ctx) => {
      ctx.redo();
    }
  },
  {
    key: 'Y',
    modifiers: { ctrl: true },
    description: 'Redo',
    category: 'utility',
    handler: (ctx) => {
      ctx.redo();
    }
  },
  {
    key: 'z',
    modifiers: { ctrl: true, shift: true },
    description: 'Redo',
    category: 'utility',
    handler: (ctx) => {
      ctx.redo();
    }
  },
  {
    key: 'Z',
    modifiers: { ctrl: true, shift: true },
    description: 'Redo',
    category: 'utility',
    handler: (ctx) => {
      ctx.redo();
    }
  }
];
