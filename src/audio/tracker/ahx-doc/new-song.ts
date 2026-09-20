import { blankTrack, makeAhxDoc } from './doc';
import { toLatin1 } from './latin1';
import type { AhxDoc } from './types';

export const NEW_AHX_TRACK_LENGTHS = [8, 12, 16, 32, 48, 64] as const;
export const NEW_AHX_SPEED_MULTIPLIERS = [1, 2, 3, 4] as const;
export const NEW_AHX_SONG_NAME = 'Untitled AHX song';

export interface NewAhxDocOptions {
  trackLength?: (typeof NEW_AHX_TRACK_LENGTHS)[number];
  speedMultiplier?: (typeof NEW_AHX_SPEED_MULTIPLIERS)[number];
  name?: string;
}

/**
 * The smallest valid AHX song: one position, its first channel on the blank
 * track 1 and the others on the shared blank track 0, restart 0, no subsongs.
 * Version 1 (the corpus's most common; version 2's differences are unverified,
 * so it is never written). The engine refuses a song with no positions, so one
 * blank position is the floor. There is no `base`: the writer guesses the
 * blank-first-track flag (always "blank" here) and writes the inert instrument
 * bits as 0.
 *
 * The name is stored as the file can hold it (NUL removed, above U+00FF as `?`).
 */
export function createNewAhxDoc(options: NewAhxDocOptions = {}): AhxDoc {
  const { trackLength = 64, speedMultiplier = 1, name = NEW_AHX_SONG_NAME } = options;
  if (!(NEW_AHX_TRACK_LENGTHS as readonly number[]).includes(trackLength)) {
    throw new RangeError(`A new AHX song has ${NEW_AHX_TRACK_LENGTHS.join('/')} rows per track (got ${String(trackLength)}).`);
  }
  if (!(NEW_AHX_SPEED_MULTIPLIERS as readonly number[]).includes(speedMultiplier)) {
    throw new RangeError(`A new AHX song's speed multiplier is 1 to 4 (got ${String(speedMultiplier)}).`);
  }
  return makeAhxDoc({
    format: 'ahx',
    version: 1,
    songName: toLatin1(name).text,
    speedMultiplier,
    restart: 0,
    trackLength,
    subsongs: [],
    positions: [{ track: [1, 0, 0, 0], transpose: [0, 0, 0, 0] }],
    tracks: [blankTrack(trackLength), blankTrack(trackLength)],
  });
}
