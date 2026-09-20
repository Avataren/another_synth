import type { AhxStep } from '@another-synth/tracker-playback';

/** Channels of an AHX song. HVL's variable width has no doc (plan section 6). */
export const AHX_CHANNELS = 4;
/** `trackNr` is a byte, so a file holds at most 256 tracks. */
export const AHX_MAX_TRACKS = 256;
/** The header's position count is 12 bits, and the loader rejects more than 1000. */
export const AHX_MAX_POSITIONS = 1000;
export const AHX_MAX_TRACK_LENGTH = 64;
/** The 16-bit `nameOffset`: everything before the string table must fit under it. */
export const AHX_SIZE_LIMIT = 0xffff;

/** A step is never edited in place: an edit makes a new one. */
export type AhxDocStep = Readonly<AhxStep>;
/** One track: exactly `trackLength` steps. Never mutated; an edit makes a new array. */
export type AhxDocTrack = readonly AhxDocStep[];

export interface AhxDocPosition {
  /** One track number per channel (`AHX_CHANNELS`). */
  readonly track: readonly number[];
  /** One signed transpose per channel, -128..127. */
  readonly transpose: readonly number[];
}

/**
 * An AHX song's structure, as the file holds it: the model the editor edits and
 * the grid is a projection of. Instruments are not in it (they live in the
 * instrument slots, the single source of truth); `buildAhxFile` joins the two.
 *
 * Immutable: every op returns a new doc that shares whatever it did not touch,
 * so an undo step is a reference swap. Every doc is `markRaw`-ed (Vue must not
 * wrap it in a Proxy) and its top level is frozen.
 */
export interface AhxDoc {
  readonly format: 'ahx';
  /** The header's version byte, 0..2. A new song writes 1. */
  readonly version: number;
  /** The file's own song name, raw and untrimmed (edge whitespace survives a round trip). */
  readonly songName: string;
  /** 1..4. The engine ticks at `50 * speedMultiplier` Hz. */
  readonly speedMultiplier: number;
  /** Always below `positions.length`. */
  readonly restart: number;
  /** 1..64, the whole song. */
  readonly trackLength: number;
  /** Start positions of subsongs 1.. (kept and remapped by position ops, not editable). */
  readonly subsongs: readonly number[];
  /** 1..1000. */
  readonly positions: readonly AhxDocPosition[];
  /** 1..256, each `trackLength` steps. The file's own table: shared tracks stay shared. */
  readonly tracks: readonly AhxDocTrack[];
  /**
   * The bytes the doc was parsed from, if any. The writer reads two things
   * from them that the model cannot carry: the blank-first-track flag and the
   * loader-ignored bits of instrument cores. Held by reference, never copied
   * or changed.
   */
  readonly base?: Uint8Array;
}

/** Old position index -> new one, or `null` when that position no longer exists. */
export type AhxPositionMap = (old: number) => number | null;

export type AhxOpResult<Extra extends object = object> =
  | ({ readonly ok: true; readonly doc: AhxDoc } & Extra)
  | { readonly ok: false; readonly reason: string };

/**
 * What an op needs to know about the file besides the doc: the bytes the
 * instruments take (`ahxInstrumentBytes`), since the size limit covers them.
 * Omitted = 0, which only a test with no instruments should do.
 */
export interface AhxOpContext {
  readonly instrumentBytes?: number;
}
