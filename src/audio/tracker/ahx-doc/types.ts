import type { AhxStep } from '@another-synth/tracker-playback';

/** Channels of an AHX song. An HVL doc carries its own count (`docChannels`). */
export const AHX_CHANNELS = 4;
/**
 * The fewest and most channels an HVL doc has. The header encodes up to 67
 * (`(buf[8] >> 2) + 4`), but the engine and the reference replayer stop at 16
 * (`AHX_MAX_CHANNELS`, `format.rs`, `hvl_replay.h`'s `MAX_CHANNELS`): a wider
 * file has no doc, since channels past 16 would never sound.
 */
export const HVL_MIN_CHANNELS = 4;
export const HVL_MAX_CHANNELS = 16;
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
  /** One track number per channel (`docChannels`). */
  readonly track: readonly number[];
  /** One signed transpose per channel, -128..127. */
  readonly transpose: readonly number[];
}

/**
 * An AHX or HVL song's structure, as the file holds it: the model the editor
 * edits and the grid is a projection of. Instruments are not in it (they live
 * in the instrument slots, the single source of truth); `buildAhxFile` joins
 * the two.
 *
 * Immutable: every op returns a new doc that shares whatever it did not touch,
 * so an undo step is a reference swap. Every doc is `markRaw`-ed (Vue must not
 * wrap it in a Proxy) and its top level is frozen.
 *
 * The ops and the store's write-back know four channels only: an HVL doc is
 * display-only until they learn its width (plan-hvl-editing.md, P2).
 */
export type AhxDoc = AhxFormatDoc | HvlDoc;

/** An AHX (`THX`) song: always four channels, no mix fields. */
export interface AhxFormatDoc extends AhxDocFields {
  readonly format: 'ahx';
}

/** An HVL song: 4..16 channels, and the two header bytes AHX has no room for. */
export interface HvlDoc extends AhxDocFields {
  readonly format: 'hvl';
  /** `HVL_MIN_CHANNELS..HVL_MAX_CHANNELS`: the width of every position. */
  readonly channels: number;
  /** Header byte 14, as stored: the mix gain in percent (`ht_mixgain = (buf[14]<<8)/100`, hvl_replay.c:406). */
  readonly mixgainRaw: number;
  /** Header byte 15, as stored: the stereo-separation preset (`ht_defstereo`, hvl_replay.c:407). */
  readonly defstereo: number;
}

interface AhxDocFields {
  /** The header's version byte: AHX 0..2, HVL 0..1. A new AHX song writes 1. */
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
  /** 1..1000, each `docChannels` wide. */
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
