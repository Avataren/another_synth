import type { AhxInstrument } from '@another-synth/tracker-playback';
import { blankTrack, makeAhxDoc } from './doc';
import { toLatin1 } from './latin1';
import { HVL_MAX_CHANNELS, HVL_MIN_CHANNELS, type AhxDoc, type HvlDoc } from './types';

export const NEW_AHX_TRACK_LENGTHS = [8, 12, 16, 32, 48, 64] as const;
export const NEW_AHX_SPEED_MULTIPLIERS = [1, 2, 3, 4] as const;
export const NEW_AHX_SONG_NAME = 'Untitled AHX song';
export const NEW_HVL_SONG_NAME = 'Untitled HVL song';

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

export interface NewHvlDocOptions extends NewAhxDocOptions {
  /** `HVL_MIN_CHANNELS..HVL_MAX_CHANNELS`; 4 when left out. */
  channels?: number;
  /** The song's instruments (an HVL doc holds its own); none when left out. */
  instruments?: readonly AhxInstrument[];
}

/**
 * The stereo preset a new HVL song stores: 2, what the app plays an AHX song
 * at (`ahx-core` `loadSong`'s default stereo mode).
 */
export const NEW_HVL_DEFSTEREO = 2;

/**
 * The mix gain a new HVL song of `channels` channels stores, in percent. At 4
 * channels it is 76, the gain the engine gives an AHX song at stereo mode 2
 * (`engine.rs` `AHX_DEFGAIN[2]`), so a new 4-channel HVL song is exactly as
 * loud as a new AHX one; wider songs are turned down by the square root of the
 * channel ratio, so all of them playing at once clips no sooner. 16 channels
 * is 38, in line with the corpus's 16-channel songs (42-47).
 */
export function newHvlMixgain(channels: number): number {
  return Math.round(76 * Math.sqrt(4 / channels));
}

/**
 * `createNewAhxDoc`'s song as HVL: the same single position (its first
 * channel on the blank track 1, every other on track 0) across `channels`
 * channels, version 1 (the one with HivelyTracker 1.5's misc-flags effect,
 * which a version-0 song ignores: `engine.rs` `stepfx_3`), and the mix of
 * `newHvlMixgain`. No `base`, as for AHX.
 */
export function createNewHvlDoc(options: NewHvlDocOptions = {}): HvlDoc {
  const { channels = 4, instruments = [], name = NEW_HVL_SONG_NAME, ...rest } = options;
  if (!Number.isInteger(channels) || channels < HVL_MIN_CHANNELS || channels > HVL_MAX_CHANNELS) {
    throw new RangeError(`A new HVL song has ${HVL_MIN_CHANNELS} to ${HVL_MAX_CHANNELS} channels (got ${String(channels)}).`);
  }
  const ahx = createNewAhxDoc({ ...rest, name });
  const zeros = (): number[] => Array.from({ length: channels }, () => 0);
  const track = zeros();
  track[0] = 1;
  return makeAhxDoc({
    ...ahx,
    format: 'hvl',
    channels,
    mixgainRaw: newHvlMixgain(channels),
    defstereo: NEW_HVL_DEFSTEREO,
    instruments: instruments.slice(),
    positions: [{ track, transpose: zeros() }],
  }) as HvlDoc;
}
