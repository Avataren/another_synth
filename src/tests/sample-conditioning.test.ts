import { describe, it, expect } from 'vitest';
import {
  buildPolyphaseKernel,
  crossfadeLoop,
  lowpassForRate,
  mipLevelForRate,
  oversample,
  removeDcOffset,
} from 'src/audio/sample-conditioning';

/**
 * These are the parts that could be quietly wrong while still producing
 * plausible-looking audio: a resampler that shifts level or phase, a low-pass
 * that eats the passband, a crossfade that runs off the front of the buffer.
 */

/** Peak error between two signals, ignoring the filter's edge transient. */
function maxError(a: Float32Array, b: Float32Array, skip: number): number {
  let worst = 0;
  for (let i = skip; i < a.length - skip; i++) {
    worst = Math.max(worst, Math.abs(a[i]! - b[i]!));
  }
  return worst;
}

const sine = (length: number, cyclesPerSample: number, amplitude = 1) => {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = amplitude * Math.sin(2 * Math.PI * cyclesPerSample * i);
  }
  return out;
};

describe('the polyphase kernel', () => {
  it('gives every phase unit gain', () => {
    // An un-normalised branch puts interpolated frames at a different level
    // from the ones landing on an input frame, which buzzes at the
    // oversampling rate rather than sounding like a filter.
    for (const factor of [2, 4, 8]) {
      for (const taps of buildPolyphaseKernel(factor)) {
        const sum = taps.reduce((a, b) => a + b, 0);
        expect(sum).toBeCloseTo(1, 6);
      }
    }
  });

  it('passes input frames through untouched on phase 0', () => {
    // Phase 0 lands exactly on an input sample, so it should be a delta.
    const [phase0] = buildPolyphaseKernel(4);
    const peak = Math.max(...Array.from(phase0!, Math.abs));
    expect(peak).toBeCloseTo(1, 3);
  });
});

describe('oversampling', () => {
  it('leaves the signal alone at factor 1', () => {
    const input = sine(64, 0.1);
    expect(oversample(input, 1)).toBe(input);
  });

  it('produces exactly factor times the frames', () => {
    expect(oversample(sine(100, 0.05), 4)).toHaveLength(400);
  });

  it('reconstructs a sine rather than approximating it linearly', () => {
    // The point of the exercise. A 4x oversampled sine should land on the
    // continuous waveform far more accurately than linear interpolation does.
    const cycles = 0.05; // well inside the passband
    const input = sine(256, cycles);
    const out = oversample(input, 4);

    const ideal = new Float32Array(out.length);
    const linear = new Float32Array(out.length);
    for (let i = 0; i < out.length; i++) {
      ideal[i] = Math.sin(2 * Math.PI * cycles * (i / 4));
      const at = i / 4;
      const j = Math.floor(at);
      const frac = at - j;
      linear[i] =
        (input[Math.min(j, input.length - 1)] ?? 0) * (1 - frac) +
        (input[Math.min(j + 1, input.length - 1)] ?? 0) * frac;
    }

    const sincError = maxError(out, ideal, 64);
    const linearError = maxError(linear, ideal, 64);

    expect(sincError).toBeLessThan(0.005);
    expect(sincError).toBeLessThan(linearError / 4);
  });

  it('preserves amplitude', () => {
    const out = oversample(sine(256, 0.05), 4);
    let peak = 0;
    for (let i = 64; i < out.length - 64; i++) peak = Math.max(peak, Math.abs(out[i]!));
    expect(peak).toBeGreaterThan(0.97);
    expect(peak).toBeLessThan(1.03);
  });

  it('does not build a click into a sample that starts away from zero', () => {
    // Zero-padding the edges would; tracker samples often start on a non-zero
    // value, and the discontinuity is audible at every note-on.
    const input = new Float32Array(64).fill(0.8);
    const out = oversample(input, 4);

    expect(out[0]).toBeCloseTo(0.8, 3);
    expect(out[out.length - 1]).toBeCloseTo(0.8, 3);
  });
});

describe('oversampling a looping sample', () => {
  /**
   * The case that broke a song. Chiptune modules are built from very short
   * single-cycle waveforms -- 66 frames in the one that exposed this -- looped
   * end to end. Clamping the kernel at the buffer's edges, which is right for
   * a one-shot sample, flattens the waveform either side of the loop seam and
   * leaves a step there. That step recurs once per cycle, which is a buzz at
   * the pitch of every note played, on a lead with nothing to hide it.
   */
  const CYCLE = 66;
  const cycle = (length: number) => {
    const out = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      out[i] =
        Math.sin((2 * Math.PI * i) / CYCLE) +
        0.3 * Math.sin((6 * Math.PI * i) / CYCLE);
    }
    return out;
  };
  const idealAt = (t: number) =>
    Math.sin((2 * Math.PI * t) / CYCLE) + 0.3 * Math.sin((6 * Math.PI * t) / CYCLE);

  const worstError = (out: Float32Array, from: number, to: number) => {
    let worst = 0;
    for (let i = from; i < to; i++) {
      worst = Math.max(worst, Math.abs(out[i]! - idealAt(i / 4)));
    }
    return worst;
  };

  it('is as accurate at the seam as in the middle', () => {
    const out = oversample(cycle(CYCLE), 4, { start: 0, end: CYCLE });
    const middle = worstError(out, 80, CYCLE * 4 - 80);
    const ends = Math.max(
      worstError(out, 0, 64),
      worstError(out, CYCLE * 4 - 64, CYCLE * 4),
    );

    expect(middle).toBeLessThan(0.001);
    // Not merely "small": no worse than the middle, which is the whole point.
    expect(ends).toBeLessThan(middle * 4);
  });

  it('is badly wrong at the seam without the loop', () => {
    // Guards the fix rather than the behaviour: if the loop stops being passed
    // through, this is the error that comes back.
    const out = oversample(cycle(CYCLE), 4);

    expect(worstError(out, CYCLE * 4 - 64, CYCLE * 4)).toBeGreaterThan(0.05);
  });

  it('still clamps the attack of a sample that loops later', () => {
    // Material before the loop is played once and really does end at frame 0,
    // so it must not wrap round to the loop's tail.
    const data = new Float32Array(200).fill(0.5);
    for (let i = 100; i < 200; i++) data[i] = -0.5;
    const out = oversample(data, 4, { start: 100, end: 200 });

    expect(out[0]).toBeCloseTo(0.5, 3);
  });
});

describe('DC offset removal', () => {
  it('centres a sample that sits off zero', () => {
    const data = sine(512, 0.05, 0.5);
    for (let i = 0; i < data.length; i++) data[i]! += 0.2;

    expect(removeDcOffset(data)).toBe(true);

    let sum = 0;
    for (const v of data) sum += v;
    expect(sum / data.length).toBeCloseTo(0, 6);
  });

  it('leaves a centred sample alone', () => {
    // A whole number of cycles (32 in 512), so the mean really is zero -- a
    // partial cycle leaves a residual offset that is not a defect.
    const data = sine(512, 0.0625);
    const before = Float32Array.from(data);

    expect(removeDcOffset(data)).toBe(false);
    expect(Array.from(data)).toEqual(Array.from(before));
  });

  it('leaves a merely asymmetric sample alone', () => {
    // Asymmetry is musical -- plenty of real waveforms are not symmetric --
    // so only a genuine offset should move.
    // A tall narrow positive peak against a long shallow trough: strongly
    // asymmetric, but centred. Its mean is subtracted here so the test is
    // about asymmetry alone rather than about a leftover offset.
    const data = new Float32Array(600);
    for (let i = 0; i < data.length; i++) {
      const phase = (i % 20) / 20;
      data[i] = phase < 0.2 ? 1 : -0.25;
    }
    let sum = 0;
    for (const v of data) sum += v;
    const mean = sum / data.length;
    for (let i = 0; i < data.length; i++) data[i]! -= mean;

    expect(removeDcOffset(data)).toBe(false);
  });
});

describe('the loop crossfade', () => {
  it('makes the wrap continuous', () => {
    // A loop whose end does not meet its start ticks once per cycle.
    const data = new Float32Array(200);
    // Steps down inside the loop, so the loop ends on a different value from
    // the one it restarts at.
    for (let i = 0; i < data.length; i++) data[i] = i < 140 ? 0.5 : -0.5;
    const loopStart = 100;
    const loopEnd = 180;

    const before = Math.abs(data[loopEnd - 1]! - data[loopStart]!);
    crossfadeLoop(data, loopStart, loopEnd, 16);
    const after = Math.abs(data[loopEnd - 1]! - data[loopStart]!);

    expect(before).toBeCloseTo(1, 6);
    expect(after).toBeLessThan(before / 4);
  });

  it('never reads before the start of the buffer', () => {
    // The fade reads `fadeFrames` before loopStart, so a loop that starts near
    // the front has to shorten the fade rather than run off the buffer.
    const data = new Float32Array(64).fill(0.25);
    const applied = crossfadeLoop(data, 4, 60, 32);

    expect(applied).toBeLessThanOrEqual(4);
    expect(Array.from(data).every(Number.isFinite)).toBe(true);
  });

  it('never eats more than half the loop', () => {
    const data = new Float32Array(200).fill(0.1);
    expect(crossfadeLoop(data, 100, 120, 64)).toBeLessThanOrEqual(10);
  });

  it('does nothing to a degenerate loop', () => {
    const data = new Float32Array(64).fill(0.5);
    expect(crossfadeLoop(data, 32, 32, 8)).toBe(0);
    expect(crossfadeLoop(data, 0, 64, 8)).toBe(0);
  });
});

describe('the mipmap low-pass', () => {
  it('keeps content that will still fit after the speed-up', () => {
    // An octave up doubles every frequency; content at 1/8 the sample rate
    // lands at 1/4, comfortably inside Nyquist, and must survive.
    const input = sine(1024, 0.125);
    const out = lowpassForRate(input, 2);

    let peak = 0;
    for (let i = 64; i < out.length - 64; i++) peak = Math.max(peak, Math.abs(out[i]!));
    expect(peak).toBeGreaterThan(0.9);
  });

  it('removes content that would fold', () => {
    // Content at 0.35 of the sample rate lands past Nyquist an octave up, so
    // it is exactly what has to go.
    const input = sine(1024, 0.35);
    const out = lowpassForRate(input, 2);

    let peak = 0;
    for (let i = 64; i < out.length - 64; i++) peak = Math.max(peak, Math.abs(out[i]!));
    expect(peak).toBeLessThan(0.15);
  });

  it('leaves the sample alone at or below unity rate', () => {
    const input = sine(256, 0.2);
    expect(lowpassForRate(input, 1)).toBe(input);
    expect(lowpassForRate(input, 0.5)).toBe(input);
  });
});

describe('choosing a mipmap level', () => {
  it('uses the unfiltered sample at or below unity', () => {
    expect(mipLevelForRate(1, 4)).toBe(0);
    expect(mipLevelForRate(0.25, 4)).toBe(0);
  });

  it('steps up one level per octave', () => {
    expect(mipLevelForRate(2, 4)).toBe(1);
    expect(mipLevelForRate(3, 4)).toBe(2);
    expect(mipLevelForRate(4, 4)).toBe(2);
    expect(mipLevelForRate(5, 4)).toBe(3);
  });

  it('clamps to what was actually built', () => {
    // yuki plays a sample 29 semitones up, a rate of about 5.4.
    expect(mipLevelForRate(5.4, 3)).toBe(2);
    expect(mipLevelForRate(64, 3)).toBe(2);
  });

  it('survives a nonsense rate', () => {
    expect(mipLevelForRate(Number.NaN, 4)).toBe(0);
    expect(mipLevelForRate(Number.POSITIVE_INFINITY, 4)).toBe(0);
  });
});
