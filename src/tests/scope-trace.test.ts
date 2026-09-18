import { describe, expect, it } from 'vitest';
import {
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
