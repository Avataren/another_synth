import type { AhxInstrument, AhxSongFormat } from '@another-synth/tracker-playback';
import { docChannels, isBlankStep, omitsFirstTrack } from './doc';
import { AHX_SIZE_LIMIT, type AhxDoc, type AhxDocTrack } from './types';

const AHX_HEADER_BYTES = 14;
/** HVL adds the mix gain and default stereo bytes. */
const HVL_HEADER_BYTES = 16;
const INSTRUMENT_CORE_BYTES = 22;
/** A PList entry: 4 bytes in AHX, 5 in HVL (the wider command set). */
const plistEntryBytes = (format: AhxSongFormat): number => (format === 'hvl' ? 5 : 4);
/** An AHX step is always 3 bytes. */
const AHX_STEP_BYTES = 3;
/** An HVL step is 5 bytes, or the 1-byte `0x3f` escape when it is all zero. */
const HVL_STEP_BYTES = 5;
const HVL_BLANK_STEP_BYTES = 1;

export interface AhxSizeBudget {
  /** The bytes before the string table: what the 16-bit `nameOffset` counts. */
  readonly used: number;
  readonly max: number;
  readonly remaining: number;
}

/**
 * What an instrument takes in the file, apart from its name (which sits in the
 * string table). `format` is the song's: HVL's PList entries are a byte wider.
 */
export const ahxInstrumentBytes = (instruments: readonly Pick<AhxInstrument, 'plist'>[], format: AhxSongFormat = 'ahx'): number =>
  instruments.reduce((sum, ins) => sum + INSTRUMENT_CORE_BYTES + plistEntryBytes(format) * ins.plist.entries.length, 0);

/** What an HVL track takes: 1 byte per blank step, 5 per other. */
const hvlTrackBytes = (track: AhxDocTrack): number =>
  track.reduce((sum, step) => sum + (isBlankStep(step) ? HVL_BLANK_STEP_BYTES : HVL_STEP_BYTES), 0);

/**
 * AHX: `14 + 2*subsongs + 8*positions + 3*trackLength*(tracks - omitted) + instrumentBytes`.
 * HVL: `16 + 2*subsongs + 2*channels*positions + (the stored tracks' steps: 1
 * byte blank, 5 otherwise) + instrumentBytes`. `omitted` is track 0 when the
 * file leaves it out. It equals the serialized file's `nameOffset` exactly (a
 * test compares, for the whole corpus).
 */
export function ahxUsedBytes(doc: AhxDoc, instrumentBytes = 0): number {
  const omitted = omitsFirstTrack(doc) ? 1 : 0;
  const shared = 2 * doc.subsongs.length + 2 * docChannels(doc) * doc.positions.length + instrumentBytes;
  if (doc.format === 'ahx') {
    return AHX_HEADER_BYTES + shared + AHX_STEP_BYTES * doc.trackLength * (doc.tracks.length - omitted);
  }
  let trackBytes = 0;
  for (let t = omitted; t < doc.tracks.length; t++) trackBytes += hvlTrackBytes(doc.tracks[t] as AhxDocTrack);
  return HVL_HEADER_BYTES + shared + trackBytes;
}

export function ahxSizeBudget(doc: AhxDoc, instruments: readonly Pick<AhxInstrument, 'plist'>[]): AhxSizeBudget {
  const used = ahxUsedBytes(doc, ahxInstrumentBytes(instruments, doc.format));
  return { used, max: AHX_SIZE_LIMIT, remaining: AHX_SIZE_LIMIT - used };
}

/** `12345` as `12,345`, the way the size line and the refusals print it. */
export const formatBytes = (n: number): string => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * Why `next` cannot replace `prev`, when the change grows the file past the
 * limit; `null` otherwise. A change that does not grow the file is never
 * refused, so an already-full song can still be edited and shrunk.
 */
export function sizeRefusal(prev: AhxDoc, next: AhxDoc, instrumentBytes: number, what: string): string | null {
  return growthRefusal(ahxUsedBytes(prev, instrumentBytes), ahxUsedBytes(next, instrumentBytes), what);
}

function growthRefusal(before: number, after: number, what: string): string | null {
  if (after <= AHX_SIZE_LIMIT || after <= before) return null;
  return `Song is ${formatBytes(before)} of ${formatBytes(AHX_SIZE_LIMIT)} bytes; ${what} needs ${formatBytes(after - before)}.`;
}

/**
 * Why `next` cannot take the place of `prev` in the song, when the swap grows
 * the file past the limit; `null` otherwise. `instrumentBytes` is what every
 * instrument of the song takes now (`ahxInstrumentBytes` for the doc's
 * format, `prev` included).
 * Only PList rows change an instrument's size, so the growth is said in rows.
 * As with `sizeRefusal`, an edit that does not grow the file is never refused.
 */
export function instrumentGrowthRefusal(
  doc: AhxDoc,
  instrumentBytes: number,
  prev: Pick<AhxInstrument, 'plist'>,
  next: Pick<AhxInstrument, 'plist'>,
): string | null {
  const before = ahxUsedBytes(doc, instrumentBytes);
  const after = ahxUsedBytes(doc, instrumentBytes - ahxInstrumentBytes([prev], doc.format) + ahxInstrumentBytes([next], doc.format));
  const rows = (after - before) / plistEntryBytes(doc.format);
  return growthRefusal(before, after, rows === 1 ? 'a PList row' : `${formatBytes(rows)} PList rows`);
}

/**
 * Why `added` cannot join the song as a new instrument, when it grows the file
 * past the limit; `null` otherwise. `instrumentBytes` is what the song's
 * instruments take now (`ahxInstrumentBytes` for the doc's format).
 */
export function instrumentAddRefusal(doc: AhxDoc, instrumentBytes: number, added: Pick<AhxInstrument, 'plist'>): string | null {
  const before = ahxUsedBytes(doc, instrumentBytes);
  const after = ahxUsedBytes(doc, instrumentBytes + ahxInstrumentBytes([added], doc.format));
  return growthRefusal(before, after, 'an instrument');
}
