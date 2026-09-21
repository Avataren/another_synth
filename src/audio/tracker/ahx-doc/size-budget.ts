import type { AhxInstrument } from '@another-synth/tracker-playback';
import { omitsFirstTrack } from './doc';
import { AHX_SIZE_LIMIT, type AhxDoc } from './types';

const AHX_HEADER_BYTES = 14;
const INSTRUMENT_CORE_BYTES = 22;
const PLIST_ENTRY_BYTES = 4;

export interface AhxSizeBudget {
  /** The bytes before the string table: what the 16-bit `nameOffset` counts. */
  readonly used: number;
  readonly max: number;
  readonly remaining: number;
}

/** What an instrument takes in the file, apart from its name (which sits in the string table). */
export const ahxInstrumentBytes = (instruments: readonly Pick<AhxInstrument, 'plist'>[]): number =>
  instruments.reduce((sum, ins) => sum + INSTRUMENT_CORE_BYTES + PLIST_ENTRY_BYTES * ins.plist.entries.length, 0);

/**
 * `14 + 2*subsongs + 8*positions + 3*trackLength*(tracks - omitted) + instrumentBytes`,
 * where `omitted` is 1 when the file leaves track 0 out. It equals the
 * serialized file's `nameOffset` exactly (a test compares).
 */
export function ahxUsedBytes(doc: AhxDoc, instrumentBytes = 0): number {
  const stored = doc.tracks.length - (omitsFirstTrack(doc) ? 1 : 0);
  return (
    AHX_HEADER_BYTES +
    2 * doc.subsongs.length +
    8 * doc.positions.length +
    3 * doc.trackLength * stored +
    instrumentBytes
  );
}

export function ahxSizeBudget(doc: AhxDoc, instruments: readonly Pick<AhxInstrument, 'plist'>[]): AhxSizeBudget {
  const used = ahxUsedBytes(doc, ahxInstrumentBytes(instruments));
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
 * instrument of the song takes now (`ahxInstrumentBytes`, `prev` included).
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
  const after = ahxUsedBytes(doc, instrumentBytes - ahxInstrumentBytes([prev]) + ahxInstrumentBytes([next]));
  const rows = (after - before) / PLIST_ENTRY_BYTES;
  return growthRefusal(before, after, rows === 1 ? 'a PList row' : `${formatBytes(rows)} PList rows`);
}
