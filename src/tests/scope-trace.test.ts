import { describe, expect, it } from 'vitest';
import {
  scopeFullScale,
  scopeMidrange,
  scopePolyline,
  scopeTriggerStart,
  scopeVisiblePoints,
} from 'src/components/tracker/scope-trace';

describe('scopeTriggerStart', () => {
  it('starts on the first rising zero crossing in the first half', () => {
    expect(scopeTriggerStart([5, 3, -2, -1, 4, 9, 2, -3])).toBe(4);
    // Touching zero counts as "was not above it".
    expect(scopeTriggerStart([1, 0, 7, 8, 1, 0, 0, 0])).toBe(2);
  });

  it('does not trigger on a falling edge, and skips crossings past the first half', () => {
    expect(scopeTriggerStart([3, 2, 1, -1, -2, -3, -4, -5])).toBe(0);
    expect(scopeTriggerStart([1, 1, 1, 1, -1, 5, 5, 5])).toBe(0); // crossing at 4 is in the second half
  });

  it('falls back to 0 for silence, DC and empty input', () => {
    expect(scopeTriggerStart(new Int16Array(16))).toBe(0);
    expect(scopeTriggerStart(new Int16Array(16).fill(100))).toBe(0);
    expect(scopeTriggerStart([])).toBe(0);
  });

  it('always leaves half the snapshot to draw', () => {
    const wave = Int16Array.from({ length: 256 }, (_, i) => (i % 32 < 16 ? -100 : 100));
    const start = scopeTriggerStart(wave);
    expect(start).toBeGreaterThan(0);
    expect(start + scopeVisiblePoints(wave.length)).toBeLessThanOrEqual(wave.length);
  });
});

describe('scopePolyline', () => {
  it('maps +full scale to the top, -full scale to the bottom, 0 to the middle', () => {
    const out = new Float32Array(6);
    const n = scopePolyline([8192, 0, -8192], 0, 3, 100, 60, 8192, out);
    expect(n).toBe(3);
    expect(Array.from(out)).toEqual([0, 0, 50, 30, 100, 60]);
  });

  it('clamps overdriven samples to the canvas', () => {
    const out = new Float32Array(4);
    scopePolyline([30000, -30000], 0, 2, 10, 20, 8192, out);
    expect(Array.from(out)).toEqual([0, 0, 10, 20]);
  });

  it('honours the start offset and never reads past the data', () => {
    const out = new Float32Array(8);
    const n = scopePolyline([0, 0, 8192, 8192], 2, 4, 10, 10, 8192, out);
    expect(n).toBe(2);
    expect(Array.from(out.subarray(0, 4))).toEqual([0, 0, 10, 0]);
  });

  it('a single point sits at x = 0 rather than dividing by zero', () => {
    const out = new Float32Array(2);
    expect(scopePolyline([0], 0, 1, 10, 10, 8192, out)).toBe(1);
    expect(Array.from(out)).toEqual([0, 5]);
  });
});

describe('scopeFullScale (fixed display gain)', () => {
  it('divides the full scale by 1, 2 or 4', () => {
    expect(scopeFullScale(8192, 1)).toBe(8192);
    expect(scopeFullScale(8192, 2)).toBe(4096);
    expect(scopeFullScale(8192, 4)).toBe(2048);
  });

  it('treats a missing or unknown gain as none', () => {
    for (const g of [undefined, 0, -2, 3, 1000, NaN]) expect(scopeFullScale(8192, g)).toBe(8192);
  });

  it('a x4 trace of a quiet voice reaches a quarter of the scope, and a loud one clips at the edge', () => {
    const out = new Float32Array(4);
    // A quarter-scale voice (2048) is at the very top edge at x4, half way up at x2.
    scopePolyline([2048, -2048], 0, 2, 10, 20, scopeFullScale(8192, 4), out);
    expect(Array.from(out)).toEqual([0, 0, 10, 20]);
    scopePolyline([2048, -2048], 0, 2, 10, 20, scopeFullScale(8192, 2), out);
    expect(Array.from(out)).toEqual([0, 5, 10, 15]);
    // Full scale at x4 does not leave the canvas.
    scopePolyline([8192, -8192], 0, 2, 10, 20, scopeFullScale(8192, 4), out);
    expect(Array.from(out)).toEqual([0, 0, 10, 20]);
  });
});

describe('scope centring for a DC-blocked source', () => {
  it('scopeMidrange is halfway between the extremes', () => {
    expect(scopeMidrange([-0.2, 1.8, 0.5, -0.2])).toBeCloseTo(0.8);
    expect(scopeMidrange([])).toBe(0);
  });

  it('a narrow pulse shifted off zero by the DC blocker fills the scope without clipping', () => {
    // Full scale 1, peak-to-peak 2: a 10% pulse after DC removal sits at -0.2 / +1.8.
    const pulse = Array.from({ length: 40 }, (_, i) => (i % 10 === 0 ? 1.8 : -0.2));
    const center = scopeMidrange(pulse);
    const out = new Float32Array(80);
    const n = scopePolyline(pulse, 0, 40, 100, 60, 1, out, center);
    const ys = Array.from({ length: n }, (_, k) => out[2 * k + 1] ?? 0);
    expect(Math.min(...ys)).toBeCloseTo(0); // top edge, not past it
    expect(Math.max(...ys)).toBeCloseTo(60); // bottom edge
  });

  it('scopeTriggerStart triggers on a rising crossing of the given level', () => {
    expect(scopeTriggerStart([1, 0.5, 0.9, 2, 1, 1, 1, 1], 0.8)).toBe(2);
  });
});
