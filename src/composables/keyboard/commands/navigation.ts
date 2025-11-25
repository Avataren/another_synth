import type { KeyboardCommand } from '../types';

/**
 * Navigation commands for moving around the tracker grid
 */
export const navigationCommands: KeyboardCommand[] = [
  {
    key: 'ArrowUp',
    description: 'Move cursor up one row',
    category: 'navigation',
    handler: (ctx) => {
      ctx.clearSelection();
      ctx.moveRow(-1);
    }
  },
  {
    key: 'ArrowDown',
    description: 'Move cursor down one row',
    category: 'navigation',
    handler: (ctx) => {
      ctx.clearSelection();
      ctx.moveRow(1);
    }
  },
  {
    key: 'ArrowLeft',
    description: 'Move cursor left one column',
    category: 'navigation',
    handler: (ctx) => {
      ctx.clearSelection();
      ctx.moveColumn(-1);
    }
  },
  {
    key: 'ArrowRight',
    description: 'Move cursor right one column',
    category: 'navigation',
    handler: (ctx) => {
      ctx.clearSelection();
      ctx.moveColumn(1);
    }
  },
  {
    key: 'Tab',
    description: 'Jump to next track',
    category: 'navigation',
    handler: (ctx) => {
      ctx.jumpToNextTrack();
    }
  },
  {
    key: 'Tab',
    modifiers: { shift: true },
    description: 'Jump to previous track',
    category: 'navigation',
    handler: (ctx) => {
      ctx.jumpToPrevTrack();
    }
  },
  {
    key: 'PageDown',
    description: 'Move cursor down 16 rows',
    category: 'navigation',
    handler: (ctx) => {
      ctx.moveRow(16);
    }
  },
  {
    key: 'PageUp',
    description: 'Move cursor up 16 rows',
    category: 'navigation',
    handler: (ctx) => {
      ctx.moveRow(-16);
    }
  },
  {
    key: 'PageDown',
    modifiers: { shift: true },
    description: 'Decrease base octave',
    category: 'navigation',
    handler: (ctx) => {
      const newOctave = Math.max(0, ctx.baseOctave.value - 1);
      ctx.baseOctave.value = newOctave;
      ctx.setBaseOctaveInput(newOctave);
    }
  },
  {
    key: 'PageUp',
    modifiers: { shift: true },
    description: 'Increase base octave',
    category: 'navigation',
    handler: (ctx) => {
      const newOctave = Math.min(8, ctx.baseOctave.value + 1);
      ctx.baseOctave.value = newOctave;
      ctx.setBaseOctaveInput(newOctave);
    }
  },
  {
    key: 'Home',
    description: 'Jump to first row',
    category: 'navigation',
    handler: (ctx) => {
      ctx.setActiveRow(0);
    }
  },
  {
    key: 'End',
    description: 'Jump to last row',
    category: 'navigation',
    handler: (ctx) => {
      ctx.setActiveRow(ctx.rowsCount - 1);
    }
  }
];
