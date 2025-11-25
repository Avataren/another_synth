import type { KeyboardCommand } from '../types';

/**
 * Transpose commands for shifting notes up/down by semitones or octaves
 */
export const transposeCommands: KeyboardCommand[] = [
  {
    key: 'ArrowUp',
    modifiers: { ctrl: true, shift: true },
    description: 'Transpose selection up one octave',
    category: 'transpose',
    handler: (ctx) => {
      ctx.transposeSelection(12);
    }
  },
  {
    key: 'ArrowDown',
    modifiers: { ctrl: true, shift: true },
    description: 'Transpose selection down one octave',
    category: 'transpose',
    handler: (ctx) => {
      ctx.transposeSelection(-12);
    }
  }
];
