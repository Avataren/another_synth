/**
 * How wide a track column is, and how far apart columns sit.
 *
 * Anything drawing a per-track strip aligned to the pattern -- the pattern
 * grid itself, the waveform row above it -- has to agree on these exactly.
 * They are not constants: multi-channel modules go well beyond the classic
 * four (DOPE.MOD has 28, XM allows 32), and at full width very few columns fit
 * on screen, so both tighten as the channel count grows.
 *
 * They lived in TrackerPattern while the waveform row used its own fixed 180px
 * and 10px gap. For eight channels or fewer the two agreed and everything
 * lined up; past that the row drifted by the difference on every column --
 * 16px each, or 24px past sixteen channels -- until the waveforms sat over
 * completely different tracks than the ones they were metering.
 */

import type { ModuleFormat } from '@another-synth/tracker-playback';

/**
 * Which optional cells a track row has.
 *
 * Every row has a note, an instrument and one three-nibble effect. The volume
 * column is a MOD/XM/S3M thing: AHX, HVL and SID steps have none, so those
 * songs drop it rather than show two dots nothing can be typed into. The
 * second effect column is a user preference for MOD-style songs, always there
 * for HVL (whose steps carry two effects) and never for AHX or SID (one).
 *
 * Column indices stay semantic whatever is shown -- 0 note, 1 instrument, 2-3
 * volume, 4 effect, 5 second effect -- so a hidden column is skipped, not
 * renumbered. Values come from `trackColumns`, which hands out one shared
 * object per combination, so two layouts compare equal by identity.
 */
export interface TrackColumns {
  readonly volume: boolean;
  readonly extraEffect: boolean;
}

const TRACK_COLUMNS: readonly (readonly TrackColumns[])[] = [false, true].map(
  (volume) =>
    [false, true].map((extraEffect) => Object.freeze({ volume, extraEffect })),
);

/** The shared `TrackColumns` for this combination. */
export function trackColumns(volume: boolean, extraEffect: boolean): TrackColumns {
  return TRACK_COLUMNS[volume ? 1 : 0]![extraEffect ? 1 : 0]!;
}

/** The classic MOD layout: volume column, one effect column. */
export const STANDARD_TRACK_COLUMNS = trackColumns(true, false);

/**
 * The columns a song's rows have, from its format.
 *
 * SID (GoatTracker) steps are note, instrument, one command; AHX steps the
 * same; HVL steps add a second effect. None has a volume column. For every
 * other format the second effect column is the user's `preferExtraEffect`.
 * `ahxSongFormat` is whether an AHX song is AHX or HVL (`trackerStore.ahxSongFormat`);
 * `null` only when neither its doc nor its bytes say, which leaves the
 * preference in charge.
 */
export function songTrackColumns(
  moduleFormat: ModuleFormat,
  ahxSongFormat: 'ahx' | 'hvl' | null,
  preferExtraEffect: boolean,
): TrackColumns {
  if (moduleFormat === 'sid') return trackColumns(false, false);
  if (moduleFormat === 'ahx') {
    return trackColumns(
      false,
      ahxSongFormat === null ? preferExtraEffect : ahxSongFormat === 'hvl',
    );
  }
  return trackColumns(true, preferExtraEffect);
}

/**
 * The semantic column indices a cursor can land on, left to right. Hidden
 * columns are simply absent, so moving left/right skips them.
 */
export function visibleColumnIndices(columns: TrackColumns): readonly number[] {
  return VISIBLE_COLUMNS[columns.volume ? 1 : 0]![columns.extraEffect ? 1 : 0]!;
}

const VISIBLE_COLUMNS: readonly (readonly (readonly number[])[])[] = [
  [Object.freeze([0, 1, 4]), Object.freeze([0, 1, 4, 5])],
  [Object.freeze([0, 1, 2, 3, 4]), Object.freeze([0, 1, 2, 3, 4, 5])],
];

/** Full-width column, and the floor it may tighten to. */
const BASE_WIDTH = 180;
const BASE_WIDTH_EXTRA_EFFECT = 240;

/**
 * Below this the note, instrument, volume and effect columns clip rather than
 * merely getting close together. It is the entry's own `min-width` (156px)
 * plus its padding.
 */
const MIN_WIDTH = 160;
const MIN_WIDTH_EXTRA_EFFECT = 216;

/**
 * What the two volume digits take out of a column: their 0.7fr of the
 * entry's content box at full width, rounded. A song without a volume column
 * is this much narrower at every width.
 */
const VOLUME_WIDTH = 22;

/** Channel count above which columns tighten at all. */
const TIGHTEN_ABOVE = 8;
/** ...and above which they tighten further. */
const TIGHTEN_MORE_ABOVE = 16;

export const TRACK_GAP_PX = 10;
export const TRACK_GAP_TIGHT_PX = 6;

/** Width of one track column, in pixels. */
export function trackWidthPx(
  trackCount: number,
  columns: TrackColumns,
): number {
  const volumeWidth = columns.volume ? 0 : VOLUME_WIDTH;
  const base =
    (columns.extraEffect ? BASE_WIDTH_EXTRA_EFFECT : BASE_WIDTH) - volumeWidth;
  if (trackCount <= TIGHTEN_ABOVE) return base;

  const floor =
    (columns.extraEffect ? MIN_WIDTH_EXTRA_EFFECT : MIN_WIDTH) - volumeWidth;
  const tightened =
    trackCount <= TIGHTEN_MORE_ABOVE ? base - 12 : base - 20;
  return Math.max(floor, tightened);
}

/** Gap between track columns, in pixels. */
export function trackGapPx(trackCount: number): number {
  return trackCount > TIGHTEN_ABOVE ? TRACK_GAP_TIGHT_PX : TRACK_GAP_PX;
}

/** Total horizontal advance from one column to the next. */
export function trackPitchPx(
  trackCount: number,
  columns: TrackColumns,
): number {
  return trackWidthPx(trackCount, columns) + trackGapPx(trackCount);
}
