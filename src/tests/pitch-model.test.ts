import { describe, it, expect } from 'vitest';
import {
  createAmigaPitchModel,
  createLinearPitchModel,
  createXmAmigaPitchModel,
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
