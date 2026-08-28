/**
 * How a format represents pitch and slides it.
 *
 * ProTracker works in Amiga periods: an integer divisor for the Paula chip,
 * where *larger* means *lower*, taken from a hand-tuned 36-entry table rather
 * than a formula. FastTracker 2 defaults to a linear frequency table spanning
 * eight octaves with a completely different period/frequency relation. Every
 * pitch effect -- portamento, tone portamento, vibrato, arpeggio, glissando --
 * is defined in terms of whichever representation the format uses, so the
 * representation has to be swappable rather than hardcoded.
 *
 * All models expose a "period" whose units are their own business; the effect
 * processor only relies on the invariants that a larger period is a lower
 * pitch and that the conversions round-trip.
 *
 * See PLAN-module-format-support.md B4 and D18.
 */

const AMIGA_CLOCK = 7159090.5;

/**
 * ProTracker's Paula frequency is AMIGA_CLOCK / (2 * period), which lands
 * ~128x above the equal-tempered note frequencies this synth expects (period
 * 856 -> ~4181 Hz, where our C-1 is ~32.7 Hz). Scaling down by 2^7 keeps us in
 * the engine's "musical Hz" domain instead of driving the sampler at 128x
 * speed. Must stay in step with the same constant in mod-import.ts.
 */
const PAULA_TO_SYNTH_SCALE = 128;

const MIN_PROTRACKER_PERIOD = 113; // ~B-3
const MAX_PROTRACKER_PERIOD = 856; // C-1

/**
 * The real ProTracker note-period table (finetune 0), C-1 through B-3.
 *
 * ProTracker's table is *not* a clean formula, so a continuous
 * period/frequency formula can be off by a period unit (or land on a different
 * pitch entirely near octave boundaries) compared to authentic playback. Only
 * the finetune-0 row is needed: per-sample finetune is applied as a constant
 * instrument-level detune (see mod-import.ts) rather than by selecting a
 * different table row at note-trigger time, so 36 entries are exact for this
 * architecture instead of the full 576-entry finetune x note table.
 *
 * Used only where a period must be *derived* from a note position (arpeggio's
 * semitone offsets, glissando snapping). Normal note playback uses the literal
 * period read from the MOD file and never consults this table.
 */
const PT_PERIOD_TABLE: readonly number[] = [
  856, 808, 762, 720, 678, 640, 604, 570, 538, 508, 480, 453, // C-1..B-1
  428, 404, 381, 360, 339, 320, 302, 285, 269, 254, 240, 226, // C-2..B-2
  214, 202, 190, 180, 170, 160, 151, 143, 135, 127, 120, 113, // C-3..B-3
];

export interface PitchModel {
  readonly kind: 'amiga' | 'linear';

  /** Restrict a period to the format's playable range. */
  clampPeriod(period: number): number;

  /** Convert a period to a synth-domain frequency in Hz. */
  frequencyFromPeriod(period: number): number;

  /**
   * Inverse of frequencyFromPeriod, *without* clamping.
   *
   * Needed where a note's literal frequency must be turned back into a period
   * without being pulled into range first -- clamping there would silently
   * retune notes that sit outside the nominal table.
   */
  rawPeriodFromFrequency(frequency: number): number;

  /** rawPeriodFromFrequency followed by clampPeriod. */
  periodFromFrequency(frequency: number): number;

  /**
   * The period `semitoneOffset` semitones away from `basePeriod`, used by
   * arpeggio and by glissando's note snapping.
   */
  arpeggioPeriod(basePeriod: number, semitoneOffset: number): number;

  /** The nearest in-tune period, for E3x glissando control. */
  snapPeriod(period: number): number;
}

export interface AmigaPitchModelOptions {
  /**
   * ProTracker's arpeggio walks its period table by whole entries, and running
   * off the top wraps to period 0 -- which plays as DC rather than a pitch.
   * Formats that compute arpeggio arithmetically have no such artefact and
   * clamp to the table's edge instead.
   */
  arpeggioWrapsToDC: boolean;
}

/** Index into PT_PERIOD_TABLE of the entry closest to the given period. */
function nearestPeriodTableIndex(period: number): number {
  let bestIndex = 0;
  let bestDelta = Infinity;
  for (let i = 0; i < PT_PERIOD_TABLE.length; i++) {
    const delta = Math.abs(PT_PERIOD_TABLE[i]! - period);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestIndex = i;
    }
  }
  return bestIndex;
}

/**
 * ProTracker / classic MOD pitch: Amiga periods against the hand-tuned table.
 */
export function createAmigaPitchModel(
  options: AmigaPitchModelOptions,
): PitchModel {
  const clampPeriod = (period: number): number => {
    if (!Number.isFinite(period)) return period;
    if (period < MIN_PROTRACKER_PERIOD) return MIN_PROTRACKER_PERIOD;
    if (period > MAX_PROTRACKER_PERIOD) return MAX_PROTRACKER_PERIOD;
    return period;
  };

  const rawPeriodFromFrequency = (frequency: number): number =>
    AMIGA_CLOCK / (2 * frequency * PAULA_TO_SYNTH_SCALE);

  return {
    kind: 'amiga',
    clampPeriod,
    rawPeriodFromFrequency,
    frequencyFromPeriod: (period) =>
      AMIGA_CLOCK / (2 * period * PAULA_TO_SYNTH_SCALE),
    periodFromFrequency: (frequency) =>
      clampPeriod(rawPeriodFromFrequency(frequency)),
    arpeggioPeriod: (basePeriod, semitoneOffset) => {
      // Step by whole table entries rather than scaling by 2^(n/12), which is
      // what ProTracker actually does.
      const shiftedIndex = nearestPeriodTableIndex(basePeriod) + semitoneOffset;
      if (shiftedIndex < 0 || shiftedIndex >= PT_PERIOD_TABLE.length) {
        if (options.arpeggioWrapsToDC) return 0;
        const clamped = Math.max(
          0,
          Math.min(PT_PERIOD_TABLE.length - 1, shiftedIndex),
        );
        return PT_PERIOD_TABLE[clamped]!;
      }
      return PT_PERIOD_TABLE[shiftedIndex]!;
    },
    snapPeriod: (period) => PT_PERIOD_TABLE[nearestPeriodTableIndex(period)]!,
  };
}
