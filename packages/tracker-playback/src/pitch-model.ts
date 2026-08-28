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

/**
 * FastTracker 2 linear frequency table (XM's default; the alternative is its
 * Amiga mode, which needs its own model).
 *
 * XM's period is linear in semitones rather than an Amiga divisor:
 *
 *   period = 10*12*16*4 - note*16*4 - finetune/2   = 7680 - note*64 - finetune/2
 *   rate   = 8363 * 2^((6*12*16*4 - period) / (12*16*4))
 *          = 8363 * 2^((4608 - period) / 768)
 *
 * so one semitone is exactly 64 period units across eight octaves, and larger
 * period still means lower pitch -- the invariant the effect processor relies
 * on.
 *
 * `rate` is a sample playback rate in Hz, not a musical pitch: period 4608 is
 * C-4 and yields 8363 Hz, the Amiga convention for a sample played at its
 * recorded rate. The engine works in musical Hz (see
 * ModInstrument.calculatePlaybackRate, which compares against
 * 440*2^((rootNote-69)/12)), so this model divides by
 * LINEAR_TO_SYNTH_SCALE the same way the Amiga model divides the Paula rate
 * by 128. 8363/32 = 261.3 Hz, i.e. C-4, as intended.
 */
const XM_REFERENCE_RATE = 8363;
const XM_REFERENCE_PERIOD = 4608; // 6*12*16*4, i.e. C-4
const XM_UNITS_PER_SEMITONE = 64; // 16*4
const XM_UNITS_PER_OCTAVE = 768; // 12*16*4
const LINEAR_TO_SYNTH_SCALE = 32;

/**
 * XM's note range is 1-96 (C-0..B-7), giving periods from 7680 (C-0) down to
 * 7680 - 95*64 = 1600 (B-7). Portamento is clamped to that range.
 *
 * NOTE: this bound is taken from the format's own note range rather than
 * measured against FastTracker 2, and nothing selects this model yet. It wants
 * checking against real XM playback when Phase 3 lands -- particularly whether
 * FT2 lets a slide run past B-7 rather than clamping.
 */
const MIN_LINEAR_PERIOD = 1600;
const MAX_LINEAR_PERIOD = 7680;

export function createLinearPitchModel(): PitchModel {
  const clampPeriod = (period: number): number => {
    if (!Number.isFinite(period)) return period;
    if (period < MIN_LINEAR_PERIOD) return MIN_LINEAR_PERIOD;
    if (period > MAX_LINEAR_PERIOD) return MAX_LINEAR_PERIOD;
    return period;
  };

  const frequencyFromPeriod = (period: number): number =>
    (XM_REFERENCE_RATE *
      Math.pow(2, (XM_REFERENCE_PERIOD - period) / XM_UNITS_PER_OCTAVE)) /
    LINEAR_TO_SYNTH_SCALE;

  const rawPeriodFromFrequency = (frequency: number): number =>
    XM_REFERENCE_PERIOD -
    XM_UNITS_PER_OCTAVE *
      Math.log2((frequency * LINEAR_TO_SYNTH_SCALE) / XM_REFERENCE_RATE);

  return {
    kind: 'linear',
    clampPeriod,
    frequencyFromPeriod,
    rawPeriodFromFrequency,
    periodFromFrequency: (frequency) =>
      clampPeriod(rawPeriodFromFrequency(frequency)),
    // Linear periods are arithmetic in semitones, so arpeggio is a
    // subtraction rather than a table walk -- and there is no table to run
    // off, hence no ProTracker-style wrap to DC.
    arpeggioPeriod: (basePeriod, semitoneOffset) =>
      clampPeriod(basePeriod - semitoneOffset * XM_UNITS_PER_SEMITONE),
    // Glissando quantises to the semitone grid.
    snapPeriod: (period) =>
      clampPeriod(
        Math.round(period / XM_UNITS_PER_SEMITONE) * XM_UNITS_PER_SEMITONE,
      ),
  };
}
