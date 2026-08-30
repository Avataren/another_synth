/**
 * Offline conditioning applied to tracker samples before they reach an
 * AudioBuffer.
 *
 * Web Audio resamples an AudioBufferSourceNode with linear interpolation when
 * `playbackRate` is not 1, and nothing exposes that choice. Linear
 * interpolation is not terrible -- it is roughly what FastTracker 2's own mixer
 * did, and better than Paula's zero-order hold -- but it rolls off about 1.8 dB
 * at half Nyquist and 7.8 dB at Nyquist, and the loss moves with pitch.
 *
 * The fix is to hand the browser a signal it cannot damage much: oversample
 * offline with a windowed sinc, and the same content then sits two octaves
 * lower relative to the buffer's rate, where linear interpolation costs about
 * 0.1 dB. This is also the honest version of "convert 8-bit to 16-bit" -- the
 * quantisation noise in an 8-bit sample is already baked in and widening the
 * container recovers nothing, but reconstructing the waveform properly does
 * soften the staircase.
 *
 * What this cannot fix is aliasing when a sample is pitched *up*: content
 * folds at the output, after everything here. See `lowpassForRate`, which
 * builds the pre-filtered copies used for that.
 */

/** Taps per polyphase branch. 16 either side is ample for audio. */
const HALF_TAPS = 16;

/**
 * Blackman window. Chosen over Hann for its lower sidelobes -- the artefact
 * that matters here is the imaging left either side of the passband.
 */
function blackman(x: number): number {
  // x in [-1, 1]; 0 at the edges.
  const t = (x + 1) / 2;
  return 0.42 - 0.5 * Math.cos(2 * Math.PI * t) + 0.08 * Math.cos(4 * Math.PI * t);
}

function sinc(x: number): number {
  if (x === 0) return 1;
  const pix = Math.PI * x;
  return Math.sin(pix) / pix;
}

/**
 * Polyphase kernel for integer-factor upsampling.
 *
 * Each of the `factor` output phases gets its own set of taps, normalised so
 * the branch sums to one. Without that normalisation the interpolated samples
 * sit at a slightly different level from the ones that land on an input frame,
 * which reads as a periodic buzz at the oversampling frequency.
 */
export function buildPolyphaseKernel(factor: number): Float32Array[] {
  const phases: Float32Array[] = [];
  for (let phase = 0; phase < factor; phase++) {
    const taps = new Float32Array(HALF_TAPS * 2);
    const offset = phase / factor;
    let sum = 0;
    for (let i = 0; i < taps.length; i++) {
      const x = i - HALF_TAPS + 1 - offset;
      const value = sinc(x) * blackman(x / HALF_TAPS);
      taps[i] = value;
      sum += value;
    }
    if (sum !== 0) {
      for (let i = 0; i < taps.length; i++) taps[i]! /= sum;
    }
    phases.push(taps);
  }
  return phases;
}

/**
 * Upsample by an integer factor with a windowed-sinc kernel.
 *
 * Edges are handled by clamping to the first and last frame rather than
 * zero-padding: a sample that does not start at zero would otherwise get a
 * click built into it, and tracker samples frequently do not.
 */
export function oversample(data: Float32Array, factor: number): Float32Array {
  if (factor <= 1 || data.length === 0) return data;

  const kernel = buildPolyphaseKernel(factor);
  const out = new Float32Array(data.length * factor);
  const last = data.length - 1;

  for (let n = 0; n < data.length; n++) {
    for (let phase = 0; phase < factor; phase++) {
      const taps = kernel[phase]!;
      let acc = 0;
      for (let i = 0; i < taps.length; i++) {
        const index = n + i - HALF_TAPS + 1;
        const clamped = index < 0 ? 0 : index > last ? last : index;
        acc += data[clamped]! * taps[i]!;
      }
      out[n * factor + phase] = acc;
    }
  }
  return out;
}

/**
 * Remove a constant offset.
 *
 * Some 8-bit tracker samples sit off zero, which thumps when a note starts and
 * adds a DC component to the mix that costs headroom for nothing. Left alone
 * below a threshold so a sample that is merely asymmetric -- which is musical,
 * not a defect -- is not touched.
 */
export function removeDcOffset(data: Float32Array, threshold = 0.002): boolean {
  if (data.length === 0) return false;

  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i]!;
  const mean = sum / data.length;
  if (Math.abs(mean) < threshold) return false;

  for (let i = 0; i < data.length; i++) data[i]! -= mean;
  return true;
}

/**
 * Smooth the seam of a forward loop.
 *
 * A forward loop jumps from `loopEnd` back to `loopStart`, and unless the
 * author matched the two the discontinuity ticks once per cycle. This fades
 * the material just before the loop end into the material just before the loop
 * start, so the wrap is continuous.
 *
 * It needs `fadeFrames` of runway before `loopStart` to read from, and the
 * fade cannot eat more than half the loop. Ping-pong loops do not want this:
 * they reverse at the ends, so the value is already continuous there.
 *
 * FT2 does not do this, so it is a deliberate departure and belongs behind a
 * setting.
 */
export function crossfadeLoop(
  data: Float32Array,
  loopStart: number,
  loopEnd: number,
  fadeFrames: number,
): number {
  const loopLength = loopEnd - loopStart;
  const fade = Math.min(fadeFrames, loopStart, Math.floor(loopLength / 2));
  if (fade <= 0 || loopLength <= 0) return 0;

  for (let i = 0; i < fade; i++) {
    // 0 at the start of the fade, 1 at the loop end.
    const t = (i + 1) / fade;
    const target = loopEnd - fade + i;
    const source = loopStart - fade + i;
    data[target] = data[target]! * (1 - t) + data[source]! * t;
  }
  return fade;
}

/**
 * Low-pass a copy of the sample for playback at a given speed-up.
 *
 * Playing a sample faster shifts its content up, and anything that lands past
 * the output's Nyquist folds back as inharmonic noise. Oversampling cannot
 * help -- the fold happens after the buffer is read. The fix is to hand the
 * player a copy with the offending content already removed, chosen by how fast
 * it is about to be played, which is the sampler equivalent of a mipmap.
 *
 * `rate` is the playback ratio: 2 means an octave up. The cutoff is Nyquist
 * divided by that, expressed as a fraction of the buffer's own sample rate.
 */
export function lowpassForRate(data: Float32Array, rate: number): Float32Array {
  if (rate <= 1 || data.length === 0) return data;

  const cutoff = 0.5 / rate; // cycles per sample
  const taps = HALF_TAPS * 2 + 1;
  const kernel = new Float32Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const x = i - HALF_TAPS;
    const value = 2 * cutoff * sinc(2 * cutoff * x) * blackman(x / (HALF_TAPS + 1));
    kernel[i] = value;
    sum += value;
  }
  if (sum !== 0) for (let i = 0; i < taps; i++) kernel[i]! /= sum;

  const out = new Float32Array(data.length);
  const last = data.length - 1;
  for (let n = 0; n < data.length; n++) {
    let acc = 0;
    for (let i = 0; i < taps; i++) {
      const index = n + i - HALF_TAPS;
      const clamped = index < 0 ? 0 : index > last ? last : index;
      acc += data[clamped]! * kernel[i]!;
    }
    out[n] = acc;
  }
  return out;
}

/**
 * Which mipmap level to play at a given rate.
 *
 * Level 0 is the unfiltered sample, used up to 1x. Each level above is
 * filtered for one more octave of speed-up, so the level is the octave count
 * rounded up, clamped to what was actually built.
 */
export function mipLevelForRate(rate: number, levelCount: number): number {
  if (!Number.isFinite(rate) || rate <= 1 || levelCount <= 1) return 0;
  const octaves = Math.ceil(Math.log2(rate));
  return Math.max(0, Math.min(levelCount - 1, octaves));
}
