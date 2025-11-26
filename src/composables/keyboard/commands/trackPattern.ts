import type { KeyboardCommand } from '../types';

/**
 * Track and pattern clipboard/transpose commands
 *
 * Note: F5 is avoided as it's the browser refresh key
 */
export const trackPatternCommands: KeyboardCommand[] = [
  // Track operations
  {
    key: 'F3',
    description: 'Copy track',
    category: 'utility',
    handler: (ctx) => {
      ctx.copyTrack();
    }
  },
  {
    key: 'F3',
    modifiers: { shift: true },
    description: 'Cut track',
    category: 'utility',
    handler: (ctx) => {
      ctx.cutTrack();
    }
  },
  {
    key: 'F4',
    description: 'Paste track',
    category: 'utility',
    handler: (ctx) => {
      ctx.pasteTrack();
    }
  },

  // Pattern operations (F6 with modifiers - safe in browsers)
  {
    key: 'F6',
    description: 'Copy pattern',
    category: 'utility',
    handler: (ctx) => {
      ctx.copyPattern();
    }
  },
  {
    key: 'F6',
    modifiers: { shift: true },
    description: 'Cut pattern',
    category: 'utility',
    handler: (ctx) => {
      ctx.cutPattern();
    }
  },
  {
    key: 'F6',
    modifiers: { ctrl: true },
    description: 'Paste pattern',
    category: 'utility',
    handler: (ctx) => {
      ctx.pastePattern();
    }
  },

  // Track transpose
  {
    key: 'F7',
    description: 'Transpose track down 1 semitone',
    category: 'transpose',
    handler: (ctx) => {
      ctx.transposeTrack(-1);
    }
  },
  {
    key: 'F7',
    modifiers: { shift: true },
    description: 'Transpose track up 1 semitone',
    category: 'transpose',
    handler: (ctx) => {
      ctx.transposeTrack(1);
    }
  },

  // Pattern transpose
  {
    key: 'F8',
    description: 'Transpose pattern down 1 semitone',
    category: 'transpose',
    handler: (ctx) => {
      ctx.transposePattern(-1);
    }
  },
  {
    key: 'F8',
    modifiers: { shift: true },
    description: 'Transpose pattern up 1 semitone',
    category: 'transpose',
    handler: (ctx) => {
      ctx.transposePattern(1);
    }
  }
];
