import { describe, it, expect } from 'vitest';
import { createAmigaPitchModel } from '../../packages/tracker-playback/src/pitch-model';

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
