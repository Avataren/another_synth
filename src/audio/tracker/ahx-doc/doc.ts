import { markRaw } from 'vue';
import {
  parseAhx,
  type AhxInstrument,
  type AhxSong,
  type AhxStep,
} from '@another-synth/tracker-playback';
import {
  AHX_CHANNELS,
  HVL_MAX_CHANNELS,
  HVL_MIN_CHANNELS,
  type AhxDoc,
  type AhxDocStep,
  type AhxDocTrack,
} from './types';

/** The one all-zero step. Shared by every blank cell of every track. */
export const BLANK_STEP: AhxDocStep = Object.freeze({
  note: 0,
  instrument: 0,
  fx: 0,
  fxParam: 0,
  fxb: 0,
  fxbParam: 0,
});

export const isBlankStep = (step: AhxDocStep): boolean =>
  step.note === 0 && step.instrument === 0 && step.fx === 0 && step.fxParam === 0 && step.fxb === 0 && step.fxbParam === 0;

export const isBlankTrack = (track: AhxDocTrack): boolean => track.every(isBlankStep);

export const stepsEqual = (a: AhxDocStep, b: AhxDocStep): boolean =>
  a.note === b.note && a.instrument === b.instrument && a.fx === b.fx && a.fxParam === b.fxParam && a.fxb === b.fxb && a.fxbParam === b.fxbParam;

export const tracksEqual = (a: AhxDocTrack, b: AhxDocTrack): boolean =>
  a === b || (a.length === b.length && a.every((step, row) => stepsEqual(step, b[row] as AhxDocStep)));

/** A track of `trackLength` blank steps. */
export const blankTrack = (trackLength: number): AhxDocTrack => Array.from({ length: trackLength }, () => BLANK_STEP);

/**
 * The single place a doc is made: raw (never a Vue Proxy: it is 16k objects
 * that the store compares by identity) and frozen at the top level, so a stray
 * assignment throws in a test instead of corrupting shared structure. Tracks and
 * positions are shared between docs and are immutable by type, not frozen.
 */
export function makeAhxDoc(fields: AhxDoc): AhxDoc {
  return Object.freeze(markRaw({ ...fields }));
}

/** How many channels every position of `doc` has: 4 for AHX, the header's count for HVL. */
export const docChannels = (doc: AhxDoc): number => (doc.format === 'hvl' ? doc.channels : AHX_CHANNELS);

/**
 * The doc of a parsed AHX or HVL song. `base`, when given, must be the bytes
 * `song` was parsed from. Throws for an HVL song wider than the engine plays
 * (`HVL_MAX_CHANNELS`): a doc would hold channels nobody hears.
 */
export function docFromSong(song: AhxSong, base?: Uint8Array): AhxDoc {
  const fields = {
    version: song.version,
    songName: song.name,
    speedMultiplier: song.speedMultiplier,
    restart: song.restart,
    trackLength: song.trackLength,
    subsongs: [...song.subsongs],
    positions: song.positions.map((p) => ({ track: [...p.track], transpose: [...p.transpose] })),
    tracks: song.tracks.map((track) => track.map((step) => ({ ...step }))),
    ...(base === undefined ? {} : { base }),
  };
  if (song.format === 'ahx') return makeAhxDoc({ format: 'ahx', ...fields });
  if (!Number.isInteger(song.channels) || song.channels < HVL_MIN_CHANNELS || song.channels > HVL_MAX_CHANNELS) {
    throw new Error(`An HVL doc has ${HVL_MIN_CHANNELS} to ${HVL_MAX_CHANNELS} channels (this song has ${String(song.channels)}).`);
  }
  return makeAhxDoc({
    format: 'hvl',
    channels: song.channels,
    mixgainRaw: song.mixgainRaw ?? 0,
    defstereo: song.defstereo ?? 0,
    ...fields,
  });
}

/** Parses `bytes` (throwing what `parseAhx` throws) and keeps them as the doc's `base`. */
export function docFromBytes(bytes: Uint8Array): AhxDoc {
  return docFromSong(parseAhx(bytes), bytes);
}

/**
 * The doc as the `AhxSong` the writer and the library's row builder take.
 * `instruments` is the writer's list, index 0 the unused placeholder. The
 * readonly structure is handed over as mutable: both consumers only read it.
 */
export function docToSong(doc: AhxDoc, instruments: readonly AhxInstrument[]): AhxSong {
  return {
    format: doc.format,
    version: doc.version,
    name: doc.songName,
    channels: docChannels(doc),
    positionNr: doc.positions.length,
    restart: doc.restart,
    speedMultiplier: doc.speedMultiplier,
    trackLength: doc.trackLength,
    trackNr: doc.tracks.length - 1,
    instrumentNr: Math.max(0, instruments.length - 1),
    subsongNr: doc.subsongs.length,
    subsongs: doc.subsongs as number[],
    positions: doc.positions as unknown as AhxSong['positions'],
    tracks: doc.tracks as unknown as AhxStep[][],
    instruments: instruments as AhxInstrument[],
    // AHX has no room for these: the key is left out, as `parseAhx` leaves it.
    ...(doc.format === 'hvl' ? { mixgainRaw: doc.mixgainRaw, defstereo: doc.defstereo } : {}),
  };
}

/**
 * Whether the file leaves track 0 out (header byte 6, bit 7). With a `base` it
 * is the base's own flag (a version-0 file may store an explicit blank track
 * 0); without one the writer guesses "track 0 is all zero".
 */
export function omitsFirstTrack(doc: AhxDoc): boolean {
  if (doc.base !== undefined) return ((doc.base[6] ?? 0) & 0x80) !== 0;
  const first = doc.tracks[0];
  return first !== undefined && isBlankTrack(first);
}
