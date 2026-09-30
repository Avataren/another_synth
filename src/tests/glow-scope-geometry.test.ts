import { describe, expect, it } from 'vitest';
import {
  GLOW_INSTANCE_FLOATS,
  flatPolyline,
  ledBarCapacity,
  ledBarSegments,
  spectrumBands,
  needleSegments,
  parseCssColor,
  shiftHue,
  stereoNeedleSegments,
  writeIndependentSegments,
  writeSegmentInstances,
} from 'src/components/tracker/glow-scope-geometry';
import { isScopeWallMode } from 'src/components/tracker/visualization-modes';

describe('writeSegmentInstances', () => {
  it('writes one instance per segment, placed in the cell and clipped to it', () => {
    const out = new Float32Array(GLOW_INSTANCE_FLOATS * 2);
    const polyline = [0, 5, 10, 15, 20, 5];
    const end = writeSegmentInstances(
      out,
      0,
      polyline,
      3,
      { x: 100, y: 50, width: 40, height: 30, brightness: 0.5 },
      2,
    );
    expect(end).toBe(GLOW_INSTANCE_FLOATS * 2);
    // Segment 0: (0,5)->(10,15) scaled by 2 and moved to (100,50).
    expect(Array.from(out.subarray(0, 4))).toEqual([100, 60, 120, 80]);
    // Clip rect is the cell box, brightness is carried.
    expect(Array.from(out.subarray(4, 9))).toEqual([100, 50, 140, 80, 0.5]);
    expect(Array.from(out.subarray(9, 13))).toEqual([120, 80, 140, 60]);
  });

  it('writes nothing for fewer than two points', () => {
    const out = new Float32Array(GLOW_INSTANCE_FLOATS);
    const cell = { x: 0, y: 0, width: 1, height: 1, brightness: 1 };
    expect(writeSegmentInstances(out, 0, [1, 2], 1, cell, 1)).toBe(0);
  });
});

describe('flatPolyline', () => {
  it('runs across the middle', () => {
    const out = new Float32Array(4);
    expect(flatPolyline(200, 80, out)).toBe(2);
    expect(Array.from(out)).toEqual([0, 40, 200, 40]);
  });
});

describe('parseCssColor', () => {
  it('reads hex and rgb forms', () => {
    expect(parseCssColor('#fff')).toEqual([1, 1, 1]);
    expect(parseCssColor('#ff0000')).toEqual([1, 0, 0]);
    expect(parseCssColor('rgb(254, 65, 116)')[0]).toBeCloseTo(254 / 255);
    expect(parseCssColor('rgba(0 255 0 / 0.5)')).toEqual([0, 1, 0]);
  });

  it('falls back on anything else', () => {
    expect(parseCssColor('hsl(10 20% 30%)', [0.1, 0.2, 0.3])).toEqual([0.1, 0.2, 0.3]);
    expect(parseCssColor('')).toHaveLength(3);
  });
});

describe('isScopeWallMode', () => {
  it('is true for the wall views only', () => {
    expect(isScopeWallMode('scopes')).toBe(true);
    expect(isScopeWallMode('glow')).toBe(true);
    expect(isScopeWallMode('pattern')).toBe(false);
  });
});

describe('needleSegments', () => {
  it('makes a mirrored needle per column, as long as the trace strays there', () => {
    // 4 points across a 40x20 cell (centre at 10): swings of 0, 6, 0, 9.
    const poly = [0, 10, 10, 16, 20, 10, 30, 1];
    const out = new Float32Array(16);
    const n = needleSegments(poly, 4, 40, 20, 10, 1, out);
    expect(n).toBe(4);
    expect(Array.from(out.subarray(0, 4))).toEqual([5, 9, 5, 11]); // silence: min length
    expect(Array.from(out.subarray(4, 8))).toEqual([15, 4, 15, 16]);
    expect(Array.from(out.subarray(12, 16))).toEqual([35, 1, 35, 19]);
  });

  it('never runs past the cell', () => {
    const out = new Float32Array(4);
    needleSegments([0, -50], 1, 10, 20, 10, 1, out);
    expect(out[1]).toBe(0);
    expect(out[3]).toBe(20);
  });
});

describe('shiftHue', () => {
  it('rotates red to green and leaves grey alone', () => {
    const g = shiftHue([1, 0, 0], 120);
    expect(g[0]).toBeCloseTo(0);
    expect(g[1]).toBeCloseTo(1);
    expect(shiftHue([0.5, 0.5, 0.5], 90)).toEqual([0.5, 0.5, 0.5]);
  });
});

describe('writeIndependentSegments', () => {
  it('writes each segment on its own, clipped to the cell', () => {
    const out = new Float32Array(GLOW_INSTANCE_FLOATS * 2);
    const end = writeIndependentSegments(
      out,
      0,
      [1, 2, 1, 6, 3, 2, 3, 8],
      2,
      { x: 10, y: 20, width: 5, height: 9, brightness: 1 },
      1,
    );
    expect(end).toBe(GLOW_INSTANCE_FLOATS * 2);
    expect(Array.from(out.subarray(0, 9))).toEqual([11, 22, 11, 26, 10, 20, 15, 29, 1]);
    expect(Array.from(out.subarray(9, 13))).toEqual([13, 22, 13, 28]);
  });
});

describe('stereoNeedleSegments', () => {
  it('draws the left channel above the centre and the right below', () => {
    // Cell 20 x 20 (centre 10), full scale 1: L peaks 0.5, R peaks 0.2 in the one column.
    const out = new Float32Array(4);
    const n = stereoNeedleSegments([0.5, -0.1], [0.2, 0], 0, 2, 5, 20, 5, 1, 1, out);
    expect(n).toBe(1);
    expect(out[1]).toBeCloseTo(5); // 10 - 0.5 * 10
    expect(out[3]).toBeCloseTo(12); // 10 + 0.2 * 10
  });

  it('keeps silence as a short mirrored dot and clips at the cell edge', () => {
    const out = new Float32Array(4);
    stereoNeedleSegments([0, 0], [5, 5], 0, 2, 5, 20, 5, 1, 1, out);
    expect(out[1]).toBe(9);
    expect(out[3]).toBe(20);
  });
});

describe('needle shaping', () => {
  it('a curve above 1 shortens the middling needles and keeps the full ones', () => {
    const out = new Float32Array(8);
    // Two columns of a 20-high cell, left channel peaks 0.5 and 1.0.
    stereoNeedleSegments([0.5, 1], [0, 0], 0, 2, 10, 20, 5, 0, 1, out, { curve: 2 });
    expect(out[1]).toBeCloseTo(10 - 2.5); // 0.5^2 * 10
    expect(out[5]).toBeCloseTo(0); // 1.0 stays at the edge
  });

  it('a hold lets a needle fall gradually rather than snap down', () => {
    const hold = new Float32Array(2);
    const out = new Float32Array(4);
    stereoNeedleSegments([1], [0], 0, 1, 5, 20, 5, 0, 1, out, { hold, decay: 0.5 });
    expect(out[1]).toBeCloseTo(0);
    stereoNeedleSegments([0], [0], 0, 1, 5, 20, 5, 0, 1, out, { hold, decay: 0.5 });
    expect(out[1]).toBeCloseTo(10 - 5); // fell to half, not to nothing
  });
});

describe('spectrumBands', () => {
  it('takes the loudest bin of each log-spaced band, scaled between the dB limits', () => {
    // 1 kHz bins up to 8 kHz; a lone -30 dB tone at 4 kHz.
    const db = new Float32Array(9).fill(-120);
    db[4] = -30;
    const out = new Float32Array(3);
    spectrumBands(db, 1000, 3, 1000, 8000, -80, -20, out);
    // Bands: 1-2, 2-4, 4-8 kHz.
    expect(out[0]).toBe(0);
    expect(out[2]).toBeCloseTo((-30 + 80) / 60);
  });
});

describe('ledBarSegments', () => {
  const layout = {
    width: 40,
    height: 100,
    baseline: 60,
    barsHeight: 40,
    ledHeight: 10,
    barWidthFraction: 0.5,
    unlitBrightness: 0.1,
    peakBrightness: 0.5,
    reflection: 0.3,
  };

  it('lights the LEDs a level reaches, dims the rest, and marks the peak', () => {
    const cap = ledBarCapacity(2, layout);
    const out = new Float32Array(cap * 4);
    const w = new Float32Array(cap);
    // Bar 0 at half (2 of 4 rows), peak at 3/4; bar 1 empty.
    const n = ledBarSegments([0.5, 0], [0.75, 0], 2, layout, out, w);
    const lit = Array.from(w.subarray(0, n)).filter((v) => v === 1).length;
    expect(lit).toBe(2);
    expect(Array.from(w.subarray(0, n))).toContain(0.5); // the peak marker
    // First LED of bar 0 sits one half-pitch above the baseline, centred in its slot.
    expect(out[1]).toBe(55);
    expect(out[0]).toBeCloseTo(10 - 5);
    expect(out[2]).toBeCloseTo(10 + 5);
  });

  it('mirrors lit LEDs under the baseline, fading with depth', () => {
    const cap = ledBarCapacity(1, layout);
    const out = new Float32Array(cap * 4);
    const w = new Float32Array(cap);
    const n = ledBarSegments([1], [1], 1, layout, out, w);
    const below: number[] = [];
    for (let i = 0; i < n; i++) if ((out[4 * i + 1] ?? 0) > layout.baseline) below.push(w[i] ?? 0);
    expect(below.length).toBe(4);
    expect(below[0]).toBeGreaterThan(below[3] as number);
  });
});
