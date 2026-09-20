import { markRaw } from 'vue';
import {
  parseAhx,
  type AhxInstrument,
  type AhxSong,
  type AhxStep,
} from '@another-synth/tracker-playback';
import { AHX_CHANNELS, type AhxDoc, type AhxDocStep, type AhxDocTrack } from './types';

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

/**
 * The doc of a parsed AHX song. `base`, when given, must be the bytes `song`
 * was parsed from. Throws for an HVL song: nothing constructs an HVL doc.
 */
export function docFromSong(song: AhxSong, base?: Uint8Array): AhxDoc {
  if (song.format !== 'ahx') throw new Error('Only AHX songs have an editable doc; HVL songs stay read-only.');
  const doc: AhxDoc = {
    format: 'ahx',
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
  return makeAhxDoc(doc);
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
    format: 'ahx',
    version: doc.version,
    name: doc.songName,
    channels: AHX_CHANNELS,
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
