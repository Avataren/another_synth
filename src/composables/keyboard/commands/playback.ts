import type { KeyboardCommand } from '../types';

/**
 * Playback control commands
 */
export const playbackCommands: KeyboardCommand[] = [
  {
    key: ' ',
    description: 'Toggle pattern playback',
    category: 'playback',
    handler: (ctx) => {
      ctx.togglePatternPlayback();
    }
  }
];
