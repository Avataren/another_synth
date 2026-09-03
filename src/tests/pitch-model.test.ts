import { describe, it, expect } from 'vitest';
import {
  createAmigaPitchModel,
  createLinearPitchModel,
  createS3mPitchModel,
  createXmAmigaPitchModel,
  s3mPeriodForNote,
} from '../../packages/tracker-playback/src/pitch-model';

/**
 * The Amiga model has to reproduce the exact numbers the effect processor
 * used before this logic was extracted, since MOD tuning depends on the
 * hand-tuned ProTracker table rather than a formula. These assertions state
 * the ProTracker values directly rather than deriving them from the
 * implementation.
 */
const model = createAmigaPitchModel({ arpeggioWrapsToDC: true });

// f = AMIGA_CLOCK / (2 * period * 128)
const expectedFrequency = (period: number) => 7159090.5 / (2 * period * 128);

describe('AmigaPitchModel', () => {
  it('identifies itself as the amiga model', () => {
    expect(model.kind).toBe('amiga');
  });

  it('converts periods to synth-domain frequencies', () => {
    // C-1 (period 856) should land near 32.7 Hz, not the ~4181 Hz Paula rate.
    expect(model.frequencyFromPeriod(856)).toBeCloseTo(expectedFrequency(856), 6);
    expect(model.frequencyFromPeriod(856)).toBeGreaterThan(30);
    expect(model.frequencyFromPeriod(856)).toBeLessThan(35);
  });

  it('round-trips period -> frequency -> period', () => {
    for (const period of [113, 214, 428, 856]) {
      expect(
        model.rawPeriodFromFrequency(model.frequencyFromPeriod(period)),
      ).toBeCloseTo(period, 6);
    }
  });

  it('clamps to the ProTracker playable range', () => {
    expect(model.clampPeriod(50)).toBe(113);
    expect(model.clampPeriod(2000)).toBe(856);
    expect(model.clampPeriod(428)).toBe(428);
  });

  it('leaves rawPeriodFromFrequency unclamped', () => {
    // Clamping here would silently retune notes outside the nominal table.
    const highFrequency = model.frequencyFromPeriod(50);
    expect(model.rawPeriodFromFrequency(highFrequency)).toBeCloseTo(50, 6);
    expect(model.periodFromFrequency(highFrequency)).toBe(113);
  });

  it('steps arpeggio through the real period table', () => {
    // 428 is C-2; +12 semitones is C-3 = 214, exactly one table octave up.
    expect(model.arpeggioPeriod(428, 12)).toBe(214);
    expect(model.arpeggioPeriod(428, 0)).toBe(428);
    // +7 from C-2 is G-2 = 285 in the table (not 428/2^(7/12) = 285.9).
    expect(model.arpeggioPeriod(428, 7)).toBe(285);
  });

  it('wraps arpeggio past the top of the table to DC', () => {
    expect(model.arpeggioPeriod(113, 1)).toBe(0);
  });

  it('clamps instead of wrapping when the option is off', () => {
    const clamping = createAmigaPitchModel({ arpeggioWrapsToDC: false });
    expect(clamping.arpeggioPeriod(113, 1)).toBe(113);
    expect(clamping.arpeggioPeriod(856, -1)).toBe(856);
  });

  it('snaps an off-table period to the nearest in-tune entry', () => {
    // Glissando control (E3x) quantises a slide to real notes.
    expect(model.snapPeriod(430)).toBe(428);
    expect(model.snapPeriod(210)).toBe(214);
    expect(model.snapPeriod(856)).toBe(856);
  });
});

/**
 * The linear model implements XM's default frequency table:
 *
 *   period = 7680 - note*64 - finetune/2
 *   rate   = 8363 * 2^((4608 - period) / 768)
 *
 * These assertions state those relations directly. The engine works in
 * musical Hz, so the model scales the XM sample rate down by 32 the same way
 * the Amiga model scales the Paula rate by 128.
 */
describe('LinearPitchModel (XM)', () => {
  const linear = createLinearPitchModel();

  /** XM period for a 0-based note index (0 = C-0), finetune 0. */
  const periodForNote = (note: number) => 7680 - note * 64;

  it('identifies itself as the linear model', () => {
    expect(linear.kind).toBe('linear');
  });

  it('puts C-4 at the 8363 Hz reference, scaled to musical Hz', () => {
    // Note 48 = C-4, period 4608, XM rate 8363 -> 8363/32 musical Hz.
    expect(periodForNote(48)).toBe(4608);
    expect(linear.frequencyFromPeriod(4608)).toBeCloseTo(8363 / 32, 6);
    // Which should land on a recognisable C-4, near 261.6 Hz.
    expect(linear.frequencyFromPeriod(4608)).toBeGreaterThan(255);
    expect(linear.frequencyFromPeriod(4608)).toBeLessThan(266);
  });

  it('spaces semitones exactly 64 period units apart', () => {
    const c4 = linear.frequencyFromPeriod(4608);
    const cs4 = linear.frequencyFromPeriod(4608 - 64);
    expect(cs4 / c4).toBeCloseTo(Math.pow(2, 1 / 12), 9);
  });

  it('doubles frequency exactly one octave (768 units) up', () => {
    const c4 = linear.frequencyFromPeriod(4608);
    const c5 = linear.frequencyFromPeriod(4608 - 768);
    expect(c5 / c4).toBeCloseTo(2, 9);
  });

  it('keeps larger period meaning lower pitch', () => {
    // The invariant the effect processor relies on across both models.
    expect(linear.frequencyFromPeriod(7680)).toBeLessThan(
      linear.frequencyFromPeriod(1600),
    );
  });

  it('round-trips period -> frequency -> period', () => {
    for (const period of [1600, 3000, 4608, 7680]) {
      expect(
        linear.rawPeriodFromFrequency(linear.frequencyFromPeriod(period)),
      ).toBeCloseTo(period, 6);
    }
  });

  it('clamps to FT2’s portamento limits, not to the note range', () => {
    // FT2 clamps the channel period at 1 and at 32000-1, both far outside
    // XM's own C-0..B-7 note range (periods 7680..1600), so a slide runs well
    // past either end -- ft2-clone's pitchSlideUp/pitchSlideDown. Clamping to
    // the note range instead left a runaway 2xx rumbling at 16.33 Hz where FT2
    // takes it inaudibly low. See D80.
    expect(linear.clampPeriod(0)).toBe(1);
    expect(linear.clampPeriod(40000)).toBe(31999);
    expect(linear.clampPeriod(4608)).toBe(4608);
    // The note range itself is untouched by the clamp.
    expect(linear.clampPeriod(1600)).toBe(1600);
    expect(linear.clampPeriod(7680)).toBe(7680);
  });

  it('takes a slide past C-0 to silence rather than a rumble', () => {
    // The reported case: F-5 (period 3520) under six rows of `240` at speed 6
    // reaches period 11200. Clamped at C-0 that is 1/43 of the sample's rate,
    // which is an audible rumble that also lasts 43x as long; FT2's limit puts
    // it at ~1/1000, which is silence.
    const f5 = linear.frequencyFromPeriod(3520);
    expect(
      linear.frequencyFromPeriod(linear.clampPeriod(11200)) / f5,
    ).toBeLessThan(1 / 500);
  });

  it('computes arpeggio arithmetically with no wrap to DC', () => {
    // Unlike ProTracker there is no table to run off, so an overflowing
    // arpeggio moves by a real interval instead of dropping to DC.
    expect(linear.arpeggioPeriod(4608, 12)).toBe(4608 - 768);
    expect(linear.arpeggioPeriod(4608, 0)).toBe(4608);
    expect(linear.arpeggioPeriod(1600, 12)).toBe(1600 - 768);
    expect(linear.arpeggioPeriod(1600, 12)).not.toBe(0);
  });

  it('snaps glissando to the semitone grid', () => {
    // Grid points are multiples of 64; 4608 and 4544 are adjacent semitones.
    expect(linear.snapPeriod(4600)).toBe(4608);
    expect(linear.snapPeriod(4560)).toBe(4544);
  });
});

/**
 * XM's Amiga mode. The two XM modes must agree exactly on the pitch of every
 * note -- they differ only in how slides interpolate between notes -- so these
 * tests check the agreement rather than just the formula in isolation.
 */
describe('XmAmigaPitchModel', () => {
  const amiga = createXmAmigaPitchModel();
  const linear = createLinearPitchModel();

  /** XM Amiga period for a 0-based note index (48 = C-4). */
  const periodForNote = (note: number) => 1712 * Math.pow(2, (48 - note) / 12);

  it('puts C-4 at period 1712 and the 8363 Hz reference', () => {
    expect(periodForNote(48)).toBeCloseTo(1712, 9);
    expect(amiga.frequencyFromPeriod(1712)).toBeCloseTo(8363 / 32, 6);
  });

  it('agrees with the linear model on note pitches', () => {
    // A song must sound the same in either mode; only slides differ.
    for (const note of [12, 36, 48, 60, 72, 95]) {
      const amigaHz = amiga.frequencyFromPeriod(periodForNote(note));
      const linearHz = linear.frequencyFromPeriod(7680 - note * 64);
      expect(amigaHz).toBeCloseTo(linearHz, 6);
    }
  });

  it('reproduces the classic ProTracker periods', () => {
    // XM note 60 is Amiga C-1 (856) and note 72 is C-2 (428).
    expect(periodForNote(60)).toBeCloseTo(856, 6);
    expect(periodForNote(72)).toBeCloseTo(428, 6);
  });

  it('halves the period one octave up, as Paula periods do', () => {
    expect(amiga.frequencyFromPeriod(856) / amiga.frequencyFromPeriod(1712))
      .toBeCloseTo(2, 9);
  });

  it('round-trips period -> frequency -> period', () => {
    for (const period of [113, 428, 1712, 27392]) {
      expect(
        amiga.rawPeriodFromFrequency(amiga.frequencyFromPeriod(period)),
      ).toBeCloseTo(period, 4);
    }
  });

  it('covers XM’s full note range without clamping a legal note', () => {
    expect(amiga.clampPeriod(periodForNote(0))).toBeCloseTo(periodForNote(0), 4);
    expect(amiga.clampPeriod(periodForNote(95))).toBeCloseTo(periodForNote(95), 4);
    // ProTracker's 113-856 range would have clamped most of that away.
    expect(periodForNote(0)).toBeGreaterThan(856);
  });

  it('scales arpeggio by semitones with no wrap to DC', () => {
    expect(amiga.arpeggioPeriod(1712, 12)).toBeCloseTo(856, 6);
    expect(amiga.arpeggioPeriod(1712, 0)).toBeCloseTo(1712, 9);
    expect(amiga.arpeggioPeriod(113, 12)).not.toBe(0);
  });

  it('snaps glissando to the nearest semitone', () => {
    expect(amiga.snapPeriod(1700)).toBeCloseTo(1712, 4);
    expect(amiga.snapPeriod(870)).toBeCloseTo(856, 4);
  });
});

/**
 * Scream Tracker 3 (P3, D96). The values are quoted from 8bitbubsy's
 * st3play, the faithful ST3 replayer port: the `notespd` period table
 * (digdata.c -- ProTracker's hand-tuned periods times 32, except the B-1
 * entry which is 14512, not 453*32 = 14496 -- a hand-tuned quirk), `setspd`'s
 * hz = 14317056 / spd conversion, and `setmasterflags`' 64..32767 range.
 * These assertions state the ST3 numbers directly rather than deriving
 * them from the implementation.
 */
describe('S3mPitchModel (ST3)', () => {
  const s3m = createS3mPitchModel();

  /** ST3 period for a file note byte (0x40 = C-5, the c2spd reference). */
  const periodForNote = (note: number) =>
    [27392, 25856, 24384, 23040, 21696, 20480, 19328, 18240, 17216, 16256, 15360, 14512][
      note & 0xf
    ]! >> (note >> 4);

  it('identifies itself as the amiga model', () => {
    expect(s3m.kind).toBe('amiga');
  });

  it('puts C-5 at the c2spd reference rate, scaled to musical Hz', () => {
    // File note 0x40 = C-5, period 1712: hz = 14317056/1712 = 8362.6, the
    // rate where a c2spd 8363 sample plays at its recorded rate. Musical
    // domain divides by 16 (ST3's reference is C-5, XM's is C-4).
    expect(periodForNote(0x40)).toBe(1712);
    expect(s3m.frequencyFromPeriod(1712)).toBeCloseTo(14317056 / 1712 / 16, 6);
    expect(s3m.frequencyFromPeriod(1712)).toBeGreaterThan(515);
    expect(s3m.frequencyFromPeriod(1712)).toBeLessThan(530);
  });

  it('puts file note 0x00 at C-1 and 0x30 at C-4', () => {
    expect(periodForNote(0x00)).toBe(27392);
    expect(s3m.frequencyFromPeriod(27392)).toBeCloseTo(32.7, 1);
    expect(periodForNote(0x30)).toBe(3424);
    expect(s3m.frequencyFromPeriod(3424)).toBeCloseTo(261.3, 1);
  });

  it('tunes A-4 to ST3’s known 440.4 Hz, not exactly 440', () => {
    // File note 0x39 = A-4, period 2032. The table is hand-tuned, not
    // exactly 12-tone equal temperament -- the well-known ST3 tuning.
    expect(periodForNote(0x39)).toBe(2032);
    expect(s3m.frequencyFromPeriod(2032)).toBeGreaterThan(440.0);
    expect(s3m.frequencyFromPeriod(2032)).toBeLessThan(440.6);
  });

  it('round-trips period -> frequency -> period', () => {
    for (const period of [2032, 3424, 1712, 27392, 5000]) {
      expect(
        s3m.rawPeriodFromFrequency(s3m.frequencyFromPeriod(period)),
      ).toBeCloseTo(period, 4);
    }
  });

  it('clamps to ST3’s own playable range', () => {
    // setmasterflags: aspdmin = 64, aspdmax = 32767 (the amiga-limits
    // variant, 453..3424, is a per-file flag and stays open for P5).
    expect(s3m.clampPeriod(10)).toBe(64);
    expect(s3m.clampPeriod(40000)).toBe(32767);
    expect(s3m.clampPeriod(2032)).toBe(2032);
  });

  it('leaves rawPeriodFromFrequency unclamped', () => {
    const highFrequency = s3m.frequencyFromPeriod(50);
    expect(s3m.rawPeriodFromFrequency(highFrequency)).toBeCloseTo(50, 4);
    expect(s3m.periodFromFrequency(highFrequency)).toBe(64);
  });

  it('steps arpeggio through the real period table', () => {
    // File note 0x30 (C-4) + 12 halfnotes is 0x40 (C-5): exactly one
    // octave, period halved.
    expect(s3m.arpeggioPeriod(3424, 12)).toBe(1712);
    expect(s3m.arpeggioPeriod(3424, 0)).toBe(3424);
    // +2 from 0x30 is 0x32 (D-4) = 24384 >> 3, a table entry -- not the
    // exponential 3424 * 2^(-2/12) = 3040.7.
    expect(s3m.arpeggioPeriod(3424, 2)).toBe(3048);
    // +1 from 0x39 (A-4) is 0x3A (A#-4) = 15360 >> 3.
    expect(s3m.arpeggioPeriod(2032, 1)).toBe(1920);
  });

  it('clamps an arpeggio past the table edge instead of wrapping to DC', () => {
    // st3play's slide routines hold the period inside 64..32767; unlike
    // ProTracker there is no wrap-to-DC artefact.
    const lowest = periodForNote(0x5b); // B-6, 14512 >> 5 = 453
    expect(s3m.arpeggioPeriod(lowest, 1)).toBe(lowest);
    expect(s3m.arpeggioPeriod(lowest, 1)).not.toBe(0);
  });

  it('snaps glissando to the nearest table entry', () => {
    // Adjacent entries around 4500: 0x27 (G-3, 18240 >> 2 = 4560) and
    // 0x28 (G#-3, 17216 >> 2 = 4304); 4560 is nearer.
    expect(s3m.snapPeriod(4500)).toBe(4560);
    expect(s3m.snapPeriod(4400)).toBe(4304);
    expect(s3m.snapPeriod(3424)).toBe(3424);
  });

  it('maps file notes to table periods, including the overrun lo nibbles', () => {
    // Exported for the importer, reading the model's own table: 0x40 = C-5
    // and 0x0C (the chromatic continuation of octave 0) land on the same
    // entry, 27392 >> 1.
    expect(s3mPeriodForNote(0x40)).toBe(1712);
    expect(s3mPeriodForNote(0x00)).toBe(27392);
    expect(s3mPeriodForNote(0x0c)).toBe(13696);
    expect(s3mPeriodForNote(0x5b)).toBe(453); // B-6, the table's edge
    expect(s3mPeriodForNote(0x5c)).toBeUndefined();
  });

  it('clamps to the amiga-limits range under the per-file flag', () => {
    // st3play setmasterflags (dig.c, quoted in formats/s3m.ts):
    //   if (song.masterflags & 16) { aspdmin = 453; aspdmax = 3424; }
    // The default model keeps 64..32767; the variant is a per-file profile
    // selection (D59), not a change to S3M_PROFILE.
    const limited = createS3mPitchModel({ amigaLimits: true });
    expect(limited.clampPeriod(64)).toBe(453);
    expect(limited.clampPeriod(40000)).toBe(3424);
    expect(limited.clampPeriod(3424)).toBe(3424);
    expect(limited.clampPeriod(2032)).toBe(2032);
    // Note frequencies are identical in the shared range -- only how far a
    // slide can run changes.
    expect(limited.frequencyFromPeriod(2032)).toBe(
      s3m.frequencyFromPeriod(2032),
    );
  });
});

/**
 * P4: autovibrato depth is a period-unit wobble, and its cents amplitude
 * depends on the representation. FT2's updateVolPanAutoVib adds the offset to
 * the channel period and re-derives the frequency, so the conversion belongs
 * here rather than in a hardcoded cents factor.
 */
describe('vibratoDepthCents (P4)', () => {
  it('is exactly 100/64 cents per unit on the linear table, at any pitch', () => {
    const linear = createLinearPitchModel();
    // 64 units to a semitone, uniformly: 1200/768 cents per unit.
    expect(linear.vibratoDepthCents(261.6, 64)).toBeCloseTo(100, 6);
    expect(linear.vibratoDepthCents(32.7, 8)).toBeCloseTo(12.5, 6);
    expect(linear.vibratoDepthCents(880, 8)).toBeCloseTo(12.5, 6);
  });

  it('widens with pitch on the 1/period models', () => {
    // Frequency ∝ 1/period, so a depth-unit wobble around period p moves the
    // pitch by log2((p+d)/p): an octave up, the same depth is twice the
    // interval. Checked against the closed form, not the implementation.
    const amiga = createXmAmigaPitchModel();
    const cents = (frequency: number) => {
      const p = (8363 * 1712) / (frequency * 32);
      return 1200 * Math.log2((p + 8) / p);
    };
    expect(amiga.vibratoDepthCents(440, 8)).toBeCloseTo(cents(440), 6);
    expect(amiga.vibratoDepthCents(880, 8)).toBeCloseTo(cents(880), 6);
    // An octave up the period has halved, so the same depth wobbles wider:
    // the conversion tracks pitch rather than being a constant.
    expect(amiga.vibratoDepthCents(880, 8)).toBeGreaterThan(
      1.9 * amiga.vibratoDepthCents(440, 8),
    );
  });

  it('converts S3M periods the same way', () => {
    // ST3's period→rate is 14317056/period, also 1/period. Corpus-unverified
    // (no S3M parser yet, P5): implemented per the shared invariants.
    const s3m = createS3mPitchModel();
    const p = 14317056 / (440 * 16); // A-4 in ST3's own units
    expect(s3m.vibratoDepthCents(440, 8)).toBeCloseTo(
      1200 * Math.log2((p + 8) / p),
      6,
    );
  });
});
