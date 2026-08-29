import { describe, it, expect } from 'vitest';
import {
  CLIP_AMPLITUDE,
  MAX_DB,
  MIN_DB,
  amplitudeToDb,
  dbToPercent,
  decayTowards,
  formatPeakLabel,
  peakMagnitude,
} from 'src/components/tracker/level-meter-math';

/**
 * The meter exists to answer one question -- did the mix go past full scale --
 * because trackers do not limit. FT2 sums into an accumulator and clamps, and
 * Paula just sums in analog, so a busy multi-channel module really can run
 * over and the only fix is headroom.
 *
 * These pin the parts that could be quietly wrong while still looking
 * plausible on screen: where 0 dB lands on the bar, and what counts as an over.
 */

describe('the dB scale', () => {
  it('puts full scale where the 0 dB mark is drawn', () => {
    // The bar's 0 dB line is positioned with this same expression in CSS, so
    // if the mapping changes without the line moving they will disagree.
    const expected = ((0 - MIN_DB) / (MAX_DB - MIN_DB)) * 100;
    expect(dbToPercent(0)).toBeCloseTo(expected, 10);
    // Sanity: 0 dB sits near the top, leaving room to show an over.
    expect(dbToPercent(0)).toBeGreaterThan(85);
    expect(dbToPercent(0)).toBeLessThan(90);
  });

  it('bottoms out at the floor and tops out at the ceiling', () => {
    expect(dbToPercent(MIN_DB)).toBe(0);
    expect(dbToPercent(MAX_DB)).toBe(100);
    expect(dbToPercent(-200)).toBe(0);
    expect(dbToPercent(60)).toBe(100);
  });

  it('reads silence as minus infinity rather than a very small number', () => {
    expect(amplitudeToDb(0)).toBe(-Infinity);
    expect(dbToPercent(amplitudeToDb(0))).toBe(0);
  });

  it('maps amplitude to dB', () => {
    expect(amplitudeToDb(1)).toBeCloseTo(0, 10);
    expect(amplitudeToDb(0.5)).toBeCloseTo(-6.0206, 4);
    expect(amplitudeToDb(2)).toBeCloseTo(6.0206, 4);
  });
});

describe('peak detection', () => {
  it('takes the largest magnitude, not an average', () => {
    // A single over among quiet samples is exactly what must not be averaged
    // away -- an RMS reading here would be about 0.16.
    const block = new Float32Array(64);
    block.fill(0.1);
    block[37] = 1.4;

    expect(peakMagnitude(block)).toBeCloseTo(1.4, 6);
  });

  it('counts negative excursions', () => {
    expect(peakMagnitude(new Float32Array([0.2, -0.9, 0.3]))).toBeCloseTo(0.9, 6);
  });

  it('reads an empty block as silence', () => {
    expect(peakMagnitude(new Float32Array(0))).toBe(0);
  });

  it('treats exactly full scale as clipped', () => {
    // A sample landing exactly on 1.0 has already been clamped by anything
    // downstream, so it counts.
    expect(peakMagnitude(new Float32Array([1]))).toBeGreaterThanOrEqual(
      CLIP_AMPLITUDE,
    );
    expect(peakMagnitude(new Float32Array([0.999]))).toBeLessThan(CLIP_AMPLITUDE);
  });
});

describe('the ballistics', () => {
  it('rises instantly', () => {
    // A peak meter that eases upward under-reads the transient it exists for.
    expect(decayTowards(-40, -3, 24, 0.016)).toBe(-3);
  });

  it('falls at the given rate, independent of frame duration', () => {
    // Two 8ms frames must land where one 16ms frame does.
    const oneFrame = decayTowards(0, -Infinity, 24, 0.016);
    const twoFrames = decayTowards(
      decayTowards(0, -Infinity, 24, 0.008),
      -Infinity,
      24,
      0.008,
    );

    expect(oneFrame).toBeCloseTo(-0.384, 6);
    expect(twoFrames).toBeCloseTo(oneFrame, 10);
  });

  it('never falls below the reading it is chasing', () => {
    expect(decayTowards(-10, -12, 24, 10)).toBe(-12);
  });
});

describe('the readout', () => {
  it('shows silence as -inf rather than a huge negative number', () => {
    expect(formatPeakLabel(0)).toBe('-inf');
    expect(formatPeakLabel(0.000001)).toBe('-inf');
  });

  it('signs an over so it is obvious at a glance', () => {
    expect(formatPeakLabel(2)).toBe('+6.0');
    expect(formatPeakLabel(1)).toBe('0.0');
    expect(formatPeakLabel(0.5)).toBe('-6.0');
  });
});
