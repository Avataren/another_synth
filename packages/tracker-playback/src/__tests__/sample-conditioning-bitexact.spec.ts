import { describe, it, expect } from 'vitest';
import {
  buildPolyphaseKernel,
  lowpassForRate,
  oversample,
  type LoopRegion,
} from '../sample-conditioning';

/**
 * Bit-exactness net for the tightened oversample/lowpassForRate inner loops.
 *
 * The loops used to call the `resolve` index closure once per tap; the
 * optimisation reads interior frames by direct indexing and only falls back
 * to the resolver at the edges and loop wraps. The reference implementation
 * below is the pre-optimisation algorithm, copied verbatim, and the tests
 * assert the shipped code produces the very same floats on fixtures that
 * exercise every index path: clamped edges, a loop inside the buffer, a loop
 * starting at frame 0 (the negative-wrap branch), and a large looping sample.
 *
 * Element-for-element `===`, not `toBeCloseTo`: the claim being pinned is that
 * the summation order and the values flowing into it did not change at all.
 */

/** HALF_TAPS in sample-conditioning.ts. The reference derives windows from it. */
const HALF_TAPS = 16;

/** The pre-optimisation implementation, kept verbatim as the reference. */
function referenceOversample(
  data: Float32Array,
  factor: number,
  loop?: LoopRegion | undefined,
): Float32Array {
  if (factor <= 1 || data.length === 0) return data;

  const kernel = buildPolyphaseKernel(factor);
  const out = new Float32Array(data.length * factor);
  const resolve = makeIndexResolver(data.length, loop);

  for (let n = 0; n < data.length; n++) {
    for (let phase = 0; phase < factor; phase++) {
      const taps = kernel[phase]!;
      let acc = 0;
      for (let i = 0; i < taps.length; i++) {
        acc += data[resolve(n + i - HALF_TAPS + 1)]! * taps[i]!;
      }
      out[n * factor + phase] = acc;
    }
  }
  return out;
}

function referenceLowpassForRate(
  data: Float32Array,
  rate: number,
  loop?: LoopRegion | undefined,
): Float32Array {
  if (rate <= 1 || data.length === 0) return data;

  const cutoff = 0.5 / rate;
  const taps = HALF_TAPS * 2 + 1;
  const kernel = new Float32Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const x = i - HALF_TAPS;
    const value =
      2 * cutoff * sinc(2 * cutoff * x) * blackman(x / (HALF_TAPS + 1));
    kernel[i] = value;
    sum += value;
  }
  if (sum !== 0) for (let i = 0; i < taps; i++) kernel[i]! /= sum;

  const out = new Float32Array(data.length);
  const resolve = makeIndexResolver(data.length, loop);
  for (let n = 0; n < data.length; n++) {
    let acc = 0;
    for (let i = 0; i < taps; i++) {
      acc += data[resolve(n + i - HALF_TAPS)]! * kernel[i]!;
    }
    out[n] = acc;
  }
  return out;
}

// --- window/sinc helpers, copied verbatim from sample-conditioning.ts ---

function blackman(x: number): number {
  const t = (x + 1) / 2;
  return (
    0.42 - 0.5 * Math.cos(2 * Math.PI * t) + 0.08 * Math.cos(4 * Math.PI * t)
  );
}

function sinc(x: number): number {
  if (x === 0) return 1;
  const pix = Math.PI * x;
  return Math.sin(pix) / pix;
}

function makeIndexResolver(
  length: number,
  loop?: LoopRegion | undefined,
): (index: number) => number {
  const last = length - 1;
  const loopLength = loop ? loop.end - loop.start : 0;

  if (!loop || loopLength <= 0) {
    return (index) => (index < 0 ? 0 : index > last ? last : index);
  }

  const end = loop.end;
  const start = loop.start;
  return (index) => {
    if (index >= end) {
      return start + ((index - start) % loopLength);
    }
    if (index < 0) {
      return start === 0 ? ((index % loopLength) + loopLength) % loopLength : 0;
    }
    return index > last ? last : index;
  };
}

// --- fixtures ---

/** Deterministic pseudo-random data in [-0.9, 0.9], so edges are non-zero. */
function noisy(length: number, seed = 1): Float32Array {
  const out = new Float32Array(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (state / 0x3fffffff - 1) * 0.9;
  }
  return out;
}

/** Every element identical by `===` (NaN-safe), and the lengths equal. */
function expectBitIdentical(a: Float32Array, b: Float32Array): void {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      // One diff line beats 2.6M silent assertions on failure.
      throw new Error(
        `first differing element at ${i}: ${a[i]} !== ${b[i]} (${a.length} frames)`,
      );
    }
  }
}

describe('sample conditioning is bit-exact against the reference loops', () => {
  describe('oversample', () => {
    it('one-shot: only the clamped edges differ from the interior', () => {
      const data = noisy(500);
      expectBitIdentical(
        oversample(data, 4),
        referenceOversample(data, 4),
      );
    });

    it('tiny sample: every frame is edge (shorter than the kernel window)', () => {
      const data = noisy(5, 7);
      expectBitIdentical(oversample(data, 2), referenceOversample(data, 2));
      expectBitIdentical(oversample(data, 4), referenceOversample(data, 4));
    });

    it('forward loop inside the buffer: wrap at the loop end, clamp at the edges', () => {
      const data = noisy(600);
      const loop: LoopRegion = { start: 100, end: 400 };
      expectBitIdentical(
        oversample(data, 4, loop),
        referenceOversample(data, 4, loop),
      );
    });

    it('loop starting at frame 0: negative indices wrap instead of clamping', () => {
      const data = noisy(300);
      const loop: LoopRegion = { start: 0, end: 200 };
      expectBitIdentical(
        oversample(data, 4, loop),
        referenceOversample(data, 4, loop),
      );
    });

    it('large loop sample: corpus-scale data through every index path', () => {
      // 656,615 frames is the largest sample in the demo corpus; the loop is
      // placed so a run of interior frames sits either side of the seam.
      const data = noisy(656_615, 3);
      const loop: LoopRegion = { start: 4096, end: 600_000 };
      expectBitIdentical(
        oversample(data, 4, loop),
        referenceOversample(data, 4, loop),
      );
    });
  });

  describe('lowpassForRate', () => {
    it('one-shot: only the clamped edges differ from the interior', () => {
      const data = noisy(500);
      expectBitIdentical(
        lowpassForRate(data, 2),
        referenceLowpassForRate(data, 2),
      );
      expectBitIdentical(
        lowpassForRate(data, 4),
        referenceLowpassForRate(data, 4),
      );
    });

    it('tiny sample: every frame is edge', () => {
      const data = noisy(5, 7);
      expectBitIdentical(
        lowpassForRate(data, 2),
        referenceLowpassForRate(data, 2),
      );
    });

    it('forward loop inside the buffer', () => {
      const data = noisy(600);
      const loop: LoopRegion = { start: 100, end: 400 };
      expectBitIdentical(
        lowpassForRate(data, 2, loop),
        referenceLowpassForRate(data, 2, loop),
      );
    });

    it('loop starting at frame 0', () => {
      const data = noisy(300);
      const loop: LoopRegion = { start: 0, end: 200 };
      expectBitIdentical(
        lowpassForRate(data, 4, loop),
        referenceLowpassForRate(data, 4, loop),
      );
    });

    it('large loop sample: the oversampled scale mips are filtered at', () => {
      // 2.6M frames: the size of the largest corpus sample's 4x copy, which
      // is what lowpassForRate actually sees (worstRate = 2^level * factor).
      const data = noisy(656_615 * 4, 3);
      const loop: LoopRegion = { start: 4096 * 4, end: 600_000 * 4 };
      expectBitIdentical(
        lowpassForRate(data, 8, loop),
        referenceLowpassForRate(data, 8, loop),
      );
    });
  });

  it('memoised kernel: same values, shared instance, unchanged output', () => {
    const first = buildPolyphaseKernel(4);
    const second = buildPolyphaseKernel(4);
    expect(second).toBe(first); // memoised, not rebuilt
    // And the memoised kernel still produces the reference output.
    const data = noisy(64);
    expectBitIdentical(oversample(data, 4), referenceOversample(data, 4));
  });
});
