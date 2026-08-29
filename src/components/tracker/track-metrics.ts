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

/** Channel count above which columns tighten at all. */
const TIGHTEN_ABOVE = 8;
/** ...and above which they tighten further. */
const TIGHTEN_MORE_ABOVE = 16;

export const TRACK_GAP_PX = 10;
export const TRACK_GAP_TIGHT_PX = 6;

/** Width of one track column, in pixels. */
export function trackWidthPx(
  trackCount: number,
  showExtraEffectColumn: boolean,
): number {
  const base = showExtraEffectColumn ? BASE_WIDTH_EXTRA_EFFECT : BASE_WIDTH;
  if (trackCount <= TIGHTEN_ABOVE) return base;

  const floor = showExtraEffectColumn ? MIN_WIDTH_EXTRA_EFFECT : MIN_WIDTH;
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
  showExtraEffectColumn: boolean,
): number {
  return (
    trackWidthPx(trackCount, showExtraEffectColumn) + trackGapPx(trackCount)
  );
}
