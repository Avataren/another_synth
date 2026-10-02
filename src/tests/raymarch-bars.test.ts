import { describe, expect, it } from 'vitest';
import {
  RaymarchBarData,
  RAYMARCH_MAX_BARS,
} from '../components/tracker/raymarch-bars';

describe('raymarch bar texture', () => {
  it('packs each height and peak without allowing invalid audio values', () => {
    const bars = new RaymarchBarData();
    bars.update([0.5, NaN, Infinity, -2, 2], [0.7, NaN, -1, 2], 5, 2.85);
    expect(bars.data[0]).toBeCloseTo(1.425);
    expect(bars.data[1]).toBeCloseTo(2.035);
    for (const b of [1, 2, 3]) expect(bars.data[b * 4]).toBeCloseTo(0.02);
    expect(bars.data[16]).toBeCloseTo(2.85);
    expect(bars.data[13]).toBeCloseTo(2.89);
    expect(bars.data[17]).toBeCloseTo(0.04);
    expect(Array.from(bars.data).every(Number.isFinite)).toBe(true);
  });

  it('preserves the authored rainbow as levels animate', () => {
    const bars = new RaymarchBarData();
    bars.update([0, 0, 0], [0, 0, 0], 3, 2.85);
    const first = bars.data.slice(RAYMARCH_MAX_BARS * 4);
    bars.update([1, 0.3, 0.7], [1, 0.4, 0.8], 3, 2.85);
    expect(bars.data.slice(RAYMARCH_MAX_BARS * 4)).toEqual(first);
    for (let b = 0; b < 3; b++) {
      const t = b / 2;
      const rgb = [0.02, 0.36, 0.68].map(
        (phase) => 0.5 + 0.5 * Math.cos(2 * Math.PI * (t * 0.9 + phase)),
      );
      const mean = rgb.reduce((sum, c) => sum + c, 0) / 3;
      for (const [channel, c] of rgb.entries()) {
        expect(bars.data[(RAYMARCH_MAX_BARS + b) * 4 + channel]).toBeCloseTo(
          Math.min(1, Math.max(0, mean + (c - mean) * 1.25)) ** 2.2,
        );
      }
    }
  });

  it('clears removed columns when the frequency count changes', () => {
    const bars = new RaymarchBarData();
    bars.update(new Float32Array(128).fill(1), [], 128, 2.85);
    bars.update([0.5], [0.6], 1, 2.85);
    expect(Array.from(bars.data.slice(4, RAYMARCH_MAX_BARS * 4))).toEqual(
      new Array<number>((RAYMARCH_MAX_BARS - 1) * 4).fill(0),
    );
    expect(Array.from(bars.data.slice((RAYMARCH_MAX_BARS + 1) * 4))).toEqual(
      new Array<number>((RAYMARCH_MAX_BARS - 1) * 4).fill(0),
    );
    expect(bars.data[0]).toBeCloseTo(1.425);
  });

  it('reports bounded average loudness for sky illumination', () => {
    const bars = new RaymarchBarData();
    expect(bars.update([0, 0], [], 2, 2.85)).toBe(0);
    expect(bars.update([0.1, 0.3], [], 2, 2.85)).toBeCloseTo(0.5);
    expect(bars.update([1, 1], [], 2, 2.85)).toBe(1);
  });
});
