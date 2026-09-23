/**
 * Vibrato/tremolo waveforms: the reference sine table, the waveform sampler
 * and the vibrato pitch helpers built on it.
 */

import type { TrackEffectState } from './effect-state';

/**
 * ProTracker's vibrato/tremolo waveform tables peak at 255, and the depth
 * scaling divides by 128 for vibrato (period units) and 64 for tremolo
 * (volume units, 0-64). getWaveformValue returns -1..1 rather than the raw
 * table, so the peak is reintroduced here.
 */
export const VIBRATO_TABLE_PEAK = 255;
const VIBRATO_DEPTH_DIVISOR = 128;
export const TREMOLO_DEPTH_DIVISOR = 64;

/**
 * ProTracker's and FastTracker 2's shared vibrato/tremolo sine table, byte for
 * byte -- `vibratoTable` in pt2_tables.c and `vibratoTab` in ft2_tables.c hold
 * the same 32 values. It is a *half* sine, 255 * sin(pi * i / 32); the second
 * half of the cycle is the same table read again with the offset subtracted
 * instead of added.
 */
const REFERENCE_SINE_TABLE = [
  0, 24, 49, 74, 97, 120, 141, 161, 180, 197, 212, 224, 235, 244, 250, 253, 255,
  253, 250, 244, 235, 224, 212, 197, 180, 161, 141, 120, 97, 74, 49, 24,
] as const;

/**
 * One sample of a vibrato/tremolo waveform, normalised to -1..1 against the
 * tables' peak of 255.
 *
 * The reference keeps its position in an 8-bit counter and reads
 * `(pos >> 2) & 0x1F` out of a 32-entry table, taking the sign from whether
 * the counter's top bit is set. `pos` here is that counter divided by four,
 * i.e. 64 steps per cycle with the sign flipping at 32, which is what the
 * callers advance.
 *
 * Two of the four waveforms were wrong before this was checked against the C:
 *
 * - The **ramp** was `1 - 2 * phase`, a sawtooth falling from +1 to -1. Both
 *   replayers build it as `tmpVib = (pos >> 2 & 31) << 3` -- rising 0..248 --
 *   negated in the second half by `~tmpVib` (FT2) / `255 - tmpVib` (PT), and
 *   then *subtracted* rather than added there. That is a sawtooth *rising*
 *   from 0 to +1, jumping to -1 and rising back to 0: the opposite direction
 *   and a quarter-cycle out of phase.
 * - **Waveform 3 was random.** Neither replayer has a random waveform. Both
 *   switch on the two low bits with `default:` covering 2 *and* 3, and both
 *   defaults set the value to a flat 255 -- a square wave. A random waveform
 *   also made playback non-deterministic, which no tracker output is.
 *
 * (No module in the 61-file corpus selects a waveform at all -- there is not
 * one E4x or E7x in it -- so this fixes nothing audible today. It is fixed
 * because it is checkable and was checked.)
 */
export function getWaveformValue(pos: number, waveform: number): number {
  const p = pos & 63;
  const index = p & 31;
  const negative = p >= 32;

  let value: number;
  switch (waveform & 3) {
    case 1: // Ramp
      value = negative ? -(255 - (index << 3)) : index << 3;
      return value / 255;
    case 2:
    case 3: // Square -- the reference's `default:` arm covers both
      return negative ? -1 : 1;
    default: // Sine
      value = REFERENCE_SINE_TABLE[index]!;
      return (negative ? -value : value) / 255;
  }
}

/**
 * The pitch a vibrato offset lands on, without disturbing the channel's own
 * pitch (vibrato is a deviation, not a slide).
 *
 * ProTracker computes `periodDelta = (vibratoTable[pos] * depth) / 128` with a
 * table peaking at 255, so a depth of x swings the period by about +-2x --
 * *period* units, which means the musical size of a given depth depends on the
 * note being played. FT2 uses the same formula against its four-times-finer
 * period scale, hence portamentoUnitScale.
 *
 * That division is **integer**, and dropping the remainder is not a rounding
 * detail at small depths -- it is most of the effect. `vibrato2` in
 * pt2_replayer.c has `vibratoData = (vibratoData * (ch->n_vibratocmd & 0xF)) /
 * 128;` on an int16_t, and `vibrato2` in ft2_replayer.c has `tmpVib =
 * (tmpVib * ch->vibDepth) >> 5;` on a uint8_t -- the same quantisation, just
 * against FT2's four-times-finer period. Both truncate a non-negative
 * magnitude and only then pick the sign from the position, so the wave is
 * quantised symmetrically about the note.
 *
 * Keeping the fraction made every vibrato deeper than the reference, by an
 * amount that grows as the depth shrinks: at depth 2 -- "to the beach.mod"
 * order 1, a `432` held from row 48 through row 63 -- ProTracker's table
 * quantises to 0,0,0,1,1,1,2,2,2,3,3,3,3,3,3,3 where this emitted a smooth
 * 0..3.98, a peak 33% wide and a mean swing ~24% wide. At depth 1 the
 * reference peaks at one period unit and this was nearly twice that.
 *
 * The previous code worked in semitones instead (`wave * depth / 16`), which
 * is a fixed musical width. That is only about right in the middle of the
 * range: at C-2 (period 428) it under-swung by ~23%, and an octave lower
 * (period 856) it over-swung by ~55%.
 */
export function vibratoFrequency(state: TrackEffectState, wave: number): number {
  const period = state.currentPeriod;
  if (period === undefined) {
    const semitones = (wave * state.vibratoDepth) / 16;
    return state.currentFrequency * Math.pow(2, -semitones / 12);
  }
  const pitch = state.profile.pitch;
  // `wave` is the reference's table entry normalised to -1..1; scaling it back
  // by the peak recovers the exact non-negative magnitude both replayers
  // multiply (Math.round because 24/255*255 need not be exactly 24 in binary
  // floating point), and the sign comes off the position afterwards, as it
  // does there.
  const magnitude = Math.round(Math.abs(wave) * VIBRATO_TABLE_PEAK);
  const delta =
    Math.sign(wave) *
    Math.trunc(
      (magnitude * state.vibratoDepth * state.profile.portamentoUnitScale) /
        VIBRATO_DEPTH_DIVISOR,
    );
  // The offset is *added* to the period, so the first half of the waveform
  // bends the pitch down and the second half up.
  //
  // ProTracker and FT2 both branch on the sign of the vibrato position and
  // add the delta to the period while it is positive; subtracting instead
  // inverts the whole waveform. That is inaudible on a fast vibrato -- it only
  // shifts the phase -- but jt_911.xm holds `41F` (speed 1, depth 15) for a
  // full cycle of about ten rows, so an inverted phase leaves the channel
  // nearly two semitones sharp for five rows where it should be flat, against
  // other channels holding the chord.
  //
  // Note the tremolo below has always added its offset to the volume, which is
  // the same convention; period is inverted relative to pitch, which is what
  // made this one look right.
  return pitch.frequencyFromPeriod(pitch.clampPeriod(period + delta));
}

/**
 * One tick of vibrato: take the sample at the current position, then advance.
 *
 * The order matters and was wrong. Both replayers read the waveform at the
 * position they already hold and only then move it on -- `doVibrato` in
 * ft2_replayer.c ends with `ch->vibratoPos += ch->vibratoSpeed;`, and
 * `vibrato2` in pt2_replayer.c with `ch->n_vibratopos += (ch->n_vibratocmd >> 2)
 * & 0x3C;`. Neither runs vibrato on tick 0 at all: FT2 has `dummy` at slot 4
 * of `JumpTab_TickZero`, and ProTracker's tick 0 goes through `setPeriod` ->
 * `checkMoreEffects`, which handles only 9/B/C/D/E/F. A note trigger zeroes the
 * position (`if ((ch->n_wavecontrol & 0x04) == 0) ch->n_vibratopos = 0;`).
 *
 * So the first vibrato tick of a fresh note reads position 0, whose sample is
 * zero -- the note's own pitch -- and the deviation only starts on the tick
 * after. Advancing first, as this used to, made every vibrato start one step
 * into the wave: at `4x8` (speed 4, depth 8) the very first tick jumped
 * straight to a 6.1-period offset instead of 0, and the whole wave ran a
 * 64th of a cycle early for as long as the note lasted. 6880 MOD and 25124 XM
 * vibrato commands in the corpus, plus every 6xy.
 */
export function advanceVibrato(state: TrackEffectState): number {
  const wave = getWaveformValue(state.vibratoPos, state.vibratoWaveform);
  state.vibratoApplied = true;
  state.vibratoHeldWave = wave;
  const frequency = vibratoFrequency(state, wave);
  state.vibratoPos += state.vibratoSpeed;
  return frequency;
}
