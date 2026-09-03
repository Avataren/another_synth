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

  /**
   * Autovibrato depth in the format's period units, expressed as the detune
   * amplitude in cents for a voice sounding at `baseFrequency`.
   *
   * FT2's autovibrato adds the vibrato offset to the channel *period* and
   * re-derives the frequency from it (updateVolPanAutoVib: `tmpPeriod =
   * outPeriod + autoVibVal`), so the same depth is a different musical
   * interval in every representation. The linear table is uniform -- 64 units
   * to a semitone everywhere -- while a 1/period table wobbles by
   * log2((p+d)/p), which varies with pitch. This is the conversion the
   * hardcoded cents factor in ModInstrument could not do (P4, D18 pattern).
   *
   * Returns the magnitude; a positive period offset lowers the pitch, and the
   * caller decides direction.
   */
  vibratoDepthCents(baseFrequency: number, depthUnits: number): number;
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

/**
 * Autovibrato depth for a 1/period representation (Amiga periods): the same
 * depth-unit period wobble around the voice's base period is a different
 * musical interval at every pitch, so the conversion is evaluated at the
 * voice's own frequency. Frequency is proportional to 1/period, so a depth of
 * `d` units moves the pitch by log2((p+d)/p) octaves around period p.
 */
function amigaVibratoDepthCents(
  rawPeriodFromFrequency: (frequency: number) => number,
  baseFrequency: number,
  depthUnits: number,
): number {
  if (!(depthUnits > 0)) return 0;
  const basePeriod = rawPeriodFromFrequency(baseFrequency);
  // A frequency outside the model's range maps to a non-positive or
  // non-finite period; there is no pitch to wobble around, so no amplitude.
  if (!(basePeriod > 0) || !Number.isFinite(basePeriod)) return 0;
  return 1200 * Math.log2((basePeriod + depthUnits) / basePeriod);
}

/**
 * Index into PT_PERIOD_TABLE of the entry closest to the given period.
 *
 * The table is strictly descending, so the linear scan this replaces was doing
 * 36 subtractions and absolute values to find something a binary search finds
 * in six comparisons -- on a path (arpeggio, glissando snapping) that runs
 * once per tick per channel. Ties keep the lower index, which is what the scan
 * did with its strict `<`; since the table descends, the lower index is the
 * *larger* period, so a period exactly between two entries snaps down in
 * pitch either way.
 */
function nearestPeriodTableIndex(
  period: number,
  table: readonly number[] = PT_PERIOD_TABLE,
): number {
  const last = table.length - 1;
  // Every delta from a non-finite period is Infinity or NaN, neither of which
  // beat the scan's initial Infinity -- so it fell out holding index 0.
  if (!Number.isFinite(period)) return 0;
  if (period >= table[0]!) return 0;
  if (period <= table[last]!) return last;

  // Narrow to the neighbouring pair lo/hi with table[hi] < period < table[lo].
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (table[mid]! > period) lo = mid;
    else hi = mid;
  }
  // `<=` keeps the lower index on an exact tie.
  return table[lo]! - period <= period - table[hi]! ? lo : hi;
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
    vibratoDepthCents: (baseFrequency, depthUnits) =>
      amigaVibratoDepthCents(rawPeriodFromFrequency, baseFrequency, depthUnits),
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
 * FastTracker 2's own portamento limits, which are *not* the note range.
 *
 * XM's note range is 1-96 (C-0..B-7), i.e. periods 7680 down to 1600, and this
 * used to clamp slides to it. FT2 does not: `pitchSlideUp` clamps the channel
 * period at 1 and `pitchSlideDown` at 32000-1, both far outside the note
 * range, so a slide runs well past B-7 and well below C-0 --
 *
 *   static void pitchSlideDown(channel_t *ch, uint8_t param) {
 *       ...
 *       ch->realPeriod += param * 4;
 *       if ((int16_t)ch->realPeriod >= 32000) // FT2 bug, should've been unsigned
 *           ch->realPeriod = 32000-1;
 *
 * (ft2-clone, src/ft2_replayer.c, the reference implementation.)
 *
 * The difference is not academic, because a linear period is exponential in
 * pitch. Clamping at C-0 leaves a runaway `2xx` sounding at 16.33 Hz -- 1/32
 * of the sample's recorded rate, which is an audible rumble that also takes 32
 * times as long to play out, so it survives well into the next pattern. FT2's
 * limit puts the same slide at a rate three orders of magnitude lower, which
 * is silence. See D80.
 *
 * Not emulated: FT2 masks the period to 16 bits in `period2Ft2Delta`, so a
 * period above 9216 wraps and comes out quieter still (2^-27 rather than
 * 2^-17 at the case in D80). Both are inaudible, and reproducing the wrap
 * would make pitch non-monotonic in the period, which the effect processor
 * relies on -- so this keeps the exponential the wrap is an artefact of.
 */
const MIN_LINEAR_PERIOD = 1;
const MAX_LINEAR_PERIOD = 31999;

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
    // Uniform: the linear table moves exactly 64 units per semitone at every
    // pitch, so 1200/768 cents per unit is exact everywhere.
    vibratoDepthCents: (_baseFrequency, depthUnits) =>
      depthUnits * (1200 / XM_UNITS_PER_OCTAVE),
  };
}

/**
 * Scream Tracker 3 pitch: Amiga periods against ST3's own table.
 *
 * ST3 does not carry MOD's note bytes; it computes each channel's "period"
 * from a base table scaled per octave, then derives the sample playback rate
 * from it. Quoted from 8bitbubsy's st3play (the faithful ST3 replayer
 * port), `digdata.c`:
 *
 *   const int16_t notespd[12+1+3] =
 *   {
 *       //C      C#     D      D#     E      F
 *       27392, 25856, 24384, 23040, 21696, 20480,
 *       //F#     G      G#     A      A#     B
 *       19328, 18240, 17216, 16256, 15360, 14512,
 *   ...
 *   const uint8_t octavediv[8+8] = { 0, 1, 2, 3, 4, 5, 6, 7, ... };
 *
 * and `stnote2herz` (`dig.c`):
 *
 *   uint16_t noteVal = notespd[note & 0x0F];
 *   const uint8_t shiftVal = octavediv[note >> 4];
 *   if (shiftVal > 0) noteVal >>= shiftVal & 0x1F;
 *
 * so the table is ProTracker's own hand-tuned periods times 32, halved per
 * octave nibble (compare notespd[1] = 25856 = 808*32, the ProTracker C#
 * entry). The `notespd` base row corresponds to S3M note 0x00. One quirk:
 * the B-1 entry is NOT ProTracker's 453 times 32 -- 453*32 = 14496, but
 * st3play's notespd[11] = 14512 (= 453.5 * 32), a hand-tuned exception and
 * the reason ST3's high B differs from MOD's.
 *
 * The period-to-rate conversion is quoted from `setspd` (`dig.c`):
 *
 *   const uint32_t hz = 14317056 / (uint16_t)tmpspd;
 *
 * where tmpspd is the channel period, and from `scalec2spd` (`dig.c`) the
 * per-sample transposition:
 *
 *   uint32_t tmpspd = spd * C2FREQ;  // C2FREQ is 8363 (digdata.h)
 *   tmpspd /= ch->ac2spd;
 *
 * i.e. finetune lives in the sample's own c2spd ("C4Spd", 8363 = no
 * finetune per the S2x finetune table in the ST3.20 manual), not in a
 * note-level nibble. OpenMPT reads this field as `c5speed`, and the file's
 * note byte 0x40 maps to C-5 (Load_s3m.cpp: `note = (note & 0x0F) +
 * 12 * (note >> 4) + 12`), which is exactly where a c2spd 8363 sample
 * plays at its recorded rate: period 27392 >> 4 = 1712,
 * hz = 14317056 / 1712 = 8362.6 Hz.
 *
 * `hz` is a sample playback rate in the Paula convention, not musical
 * pitch -- the same situation as XM's rate = 8363*1712/period at C-4. The
 * engine works in musical Hz, so this model divides by 16, not XM's 32:
 * ST3's reference note is C-5, one octave above XM's C-4. Checks: period
 * 27392 (note 0x00 = C-1) -> 32.7 Hz; period 3424 (note 0x30 = C-4) ->
 * 261.3 Hz; period 2032 (note 0x39 = A-4) -> 440.4 Hz, the well-known ST3
 * tuning (the table is not exactly 12-tone equal temperament).
 *
 * The same `<< 2` appears in every slide routine (`s_slidedown`):
 *
 *   ch->aspd += ch->info << 2;
 *
 * so one portamento parameter moves 4 period units per tick -- the profile
 * carries that as portamentoUnitScale.
 *
 * Clamping: `setmasterflags` (`dig.c`) sets the playable range
 *
 *   song.aspdmin = 64; song.aspdmax = 32767;      // default
 *   song.aspdmin = 453; song.aspdmax = 3424;      // amigalimits flag
 *
 * and the slide routines clamp against 32767 (`if ((uint16_t)ch->aspd >
 * 32767) ch->aspd = 32767;`). The amiga-limits variant is a per-file
 * master flag (header flags & 16), the same profile-selection shape as
 * XM's Amiga-mode flag; until the S3M parser exists (P5) this model keeps
 * the default range, which is what un-flagged modules use.
 */
const S3M_REFERENCE_RATE_NUMERATOR = 14317056; // setspd: hz = 14317056 / spd
const S3M_TO_SYNTH_SCALE = 16;
const MIN_S3M_PERIOD = 64; // setmasterflags: song.aspdmin
const MAX_S3M_PERIOD = 32767; // setmasterflags: song.aspdmax

/**
 * ST3's base period row (S3M note octave 0), quoted verbatim from
 * st3play's `notespd` table (`digdata.c`) -- ProTracker's table entries
 * times 32 (B-1 excepted: 14512, not 453*32 -- hand-tuned). Octave k shifts the row right by k bits, so the full playable
 * table is this row transposed over S3M's octave nibbles.
 */
const ST3_NOTESPD: readonly number[] = [
  27392, 25856, 24384, 23040, 21696, 20480, // C..F
  19328, 18240, 17216, 16256, 15360, 14512, // F#..B
];

/**
 * S3M's note byte spans six octave nibbles of twelve semitones each
 * (0x00..0x5B = C-1..B-6); lo-nibble values 0xC..0xF are octave-overrun
 * spellings of the next octave's first notes, not extra table rows, so the
 * table holds 6 x 12 entries.
 */
const S3M_PERIOD_TABLE: readonly number[] = Array.from(
  { length: 72 },
  (_, i) => ST3_NOTESPD[i % 12]! >> Math.floor(i / 12),
);

export function createS3mPitchModel(): PitchModel {
  const clampPeriod = (period: number): number => {
    if (!Number.isFinite(period)) return period;
    if (period < MIN_S3M_PERIOD) return MIN_S3M_PERIOD;
    if (period > MAX_S3M_PERIOD) return MAX_S3M_PERIOD;
    return period;
  };

  const frequencyFromPeriod = (period: number): number =>
    S3M_REFERENCE_RATE_NUMERATOR / period / S3M_TO_SYNTH_SCALE;

  const rawPeriodFromFrequency = (frequency: number): number =>
    S3M_REFERENCE_RATE_NUMERATOR / (frequency * S3M_TO_SYNTH_SCALE);

  return {
    kind: 'amiga',
    clampPeriod,
    frequencyFromPeriod,
    rawPeriodFromFrequency,
    periodFromFrequency: (frequency) =>
      clampPeriod(rawPeriodFromFrequency(frequency)),
    // ST3's arpeggio re-derives the period from the note table
    // (`s_arp`: `stnote2herz(octa | note)`), so it steps whole table
    // entries. There is no ProTracker-style wrap to DC: the slide and
    // clamp routines hold the period inside 64..32767, so an arpeggio
    // past the table edge stays clamped at the edge instead.
    arpeggioPeriod: (basePeriod, semitoneOffset) => {
      const shiftedIndex =
        nearestPeriodTableIndex(basePeriod, S3M_PERIOD_TABLE) + semitoneOffset;
      const clamped = Math.max(
        0,
        Math.min(S3M_PERIOD_TABLE.length - 1, shiftedIndex),
      );
      return S3M_PERIOD_TABLE[clamped]!;
    },
    snapPeriod: (period) =>
      S3M_PERIOD_TABLE[
        nearestPeriodTableIndex(period, S3M_PERIOD_TABLE)
      ]!,
    vibratoDepthCents: (baseFrequency, depthUnits) =>
      amigaVibratoDepthCents(rawPeriodFromFrequency, baseFrequency, depthUnits),
  };
}

/**
 * FastTracker 2 Amiga-mode frequency table.
 *
 * Roughly half of real XM modules use this rather than the linear table (4 of
 * the 9 in the local corpus, including both 4-mat tunes -- see
 * PLAN-module-format-support.md section 6c), so it is not an exotic path.
 *
 * XM's Amiga periods follow the Paula convention:
 *
 *   rate   = 8363 * 1712 / period
 *   period = 1712 * 2^((48 - note - finetune/128) / 12)
 *
 * where note 48 is C-4 and period 1712 is its reference. Both XM modes agree
 * exactly on the pitch of every note -- period 1712 gives 8363 Hz in either --
 * and differ only in how slides interpolate between notes: linear mode moves
 * uniformly in semitones, Amiga mode uniformly in period. That is why this
 * model shares the linear model's /32 scale into musical Hz.
 *
 * ProTracker's own table is visible inside this one: XM note 60 lands on
 * period 856 and note 72 on 428, the classic Amiga C-1 and C-2 values.
 *
 * APPROXIMATION: FastTracker 2 ships a precomputed table with logarithmic
 * interpolation between eight finetune steps per semitone, and its entries
 * deviate from this continuous formula by up to about a period unit. That is
 * inaudible for note playback but can differ slightly on long slides. Replacing
 * this with FT2's literal table is worth doing if XM slides ever sound subtly
 * off against a reference player.
 */
const XM_AMIGA_REFERENCE_PERIOD = 1712; // C-4
const XM_AMIGA_REFERENCE_NOTE = 48; // C-4
const XM_AMIGA_RATE_NUMERATOR = XM_REFERENCE_RATE * XM_AMIGA_REFERENCE_PERIOD;

/**
 * Periods for XM's note range 1-96 (C-0..B-7): note 0 gives 27392 and note 95
 * about 113. Rounded outward so a legal note is never clamped away.
 */
const MIN_XM_AMIGA_PERIOD = 113;
const MAX_XM_AMIGA_PERIOD = 27392;

export function createXmAmigaPitchModel(): PitchModel {
  const clampPeriod = (period: number): number => {
    if (!Number.isFinite(period)) return period;
    if (period < MIN_XM_AMIGA_PERIOD) return MIN_XM_AMIGA_PERIOD;
    if (period > MAX_XM_AMIGA_PERIOD) return MAX_XM_AMIGA_PERIOD;
    return period;
  };

  const frequencyFromPeriod = (period: number): number =>
    XM_AMIGA_RATE_NUMERATOR / period / LINEAR_TO_SYNTH_SCALE;

  const rawPeriodFromFrequency = (frequency: number): number =>
    XM_AMIGA_RATE_NUMERATOR / (frequency * LINEAR_TO_SYNTH_SCALE);

  /** Fractional note index for a period, where 48 is C-4. */
  const noteFromPeriod = (period: number): number =>
    XM_AMIGA_REFERENCE_NOTE -
    12 * Math.log2(period / XM_AMIGA_REFERENCE_PERIOD);

  const periodFromNote = (note: number): number =>
    XM_AMIGA_REFERENCE_PERIOD *
    Math.pow(2, (XM_AMIGA_REFERENCE_NOTE - note) / 12);

  return {
    kind: 'amiga',
    clampPeriod,
    frequencyFromPeriod,
    rawPeriodFromFrequency,
    periodFromFrequency: (frequency) =>
      clampPeriod(rawPeriodFromFrequency(frequency)),
    // Unlike ProTracker there is no 36-entry table to step through, so
    // arpeggio scales the period directly and cannot overflow into DC.
    arpeggioPeriod: (basePeriod, semitoneOffset) =>
      clampPeriod(basePeriod * Math.pow(2, -semitoneOffset / 12)),
    snapPeriod: (period) =>
      clampPeriod(periodFromNote(Math.round(noteFromPeriod(period)))),
    vibratoDepthCents: (baseFrequency, depthUnits) =>
      amigaVibratoDepthCents(rawPeriodFromFrequency, baseFrequency, depthUnits),
  };
}
