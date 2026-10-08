/**
 * Parameters for the post-fx graphic equalizer.
 *
 * Pure and unit-testable, the same shape as `limiter-math.ts`. The EQ is ten
 * octave-spaced bands, one `BiquadFilterNode` each (lowshelf, eight peaking
 * bands, highshelf), run in series. A biquad is a handful of multiply-adds per
 * sample, so the whole chain costs next to nothing next to the tracker mix.
 */

/** Band centre (shelf corner for the first and last) frequencies, Hz. */
export const EQ_BAND_FREQUENCIES: readonly number[] = [
  31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000,
];

export const EQ_BAND_COUNT = EQ_BAND_FREQUENCIES.length;

/** Gain range per band, dB. */
export const EQ_MIN_GAIN_DB = -12;
export const EQ_MAX_GAIN_DB = 12;

/**
 * Peaking-band Q. 1.0 is the best match for `eqEffectiveGains`, which
 * removes the stacking between neighbours (lower Q needs more compensation
 * than the +-12 dB range has; higher Q scallops between bands).
 */
export const EQ_PEAKING_Q = 1.0;

export type EqBandType = 'lowshelf' | 'peaking' | 'highshelf';

export function eqBandType(index: number): EqBandType {
  if (index === 0) return 'lowshelf';
  if (index === EQ_BAND_COUNT - 1) return 'highshelf';
  return 'peaking';
}

export interface EqParams {
  /** Gain in dB for each of the `EQ_BAND_COUNT` bands. */
  gainsDb: number[];
}

export const EQ_DEFAULT_PARAMS: EqParams = {
  gainsDb: new Array<number>(EQ_BAND_COUNT).fill(0),
};

/** Clamp UI-provided or persisted parameters; missing bands read as flat. */
export function sanitizeEqParams(raw: Partial<EqParams>): EqParams {
  const source = Array.isArray(raw.gainsDb) ? raw.gainsDb : [];
  const gainsDb = EQ_BAND_FREQUENCIES.map((_, i) => {
    const n = typeof source[i] === 'number' ? source[i]! : Number.NaN;
    if (!Number.isFinite(n)) return 0;
    return Math.min(EQ_MAX_GAIN_DB, Math.max(EQ_MIN_GAIN_DB, n));
  });
  return { gainsDb };
}

/** True when every band is (near) flat, so the stage may be bypassed. */
export function eqIsFlat(params: EqParams): boolean {
  return params.gainsDb.every((g) => Math.abs(g) < 0.05);
}

/** RBJ cookbook biquad coefficients, normalised so a0 = 1. */
function biquadCoefficients(
  type: EqBandType,
  frequency: number,
  q: number,
  gainDb: number,
  sampleRate: number,
): { b: [number, number, number]; a: [number, number] } {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * frequency) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  if (type === 'peaking') {
    b0 = 1 + alpha * A;
    b1 = -2 * cos;
    b2 = 1 - alpha * A;
    a0 = 1 + alpha / A;
    a1 = -2 * cos;
    a2 = 1 - alpha / A;
  } else {
    // Web Audio ignores Q on shelves and uses shelf slope S = 1, which makes
    // alpha = sin(w0) / sqrt(2) -- NOT the peaking alpha above.
    const k = 2 * Math.sqrt(A) * (Math.sin(w0) / Math.SQRT2);
    if (type === 'lowshelf') {
      b0 = A * (A + 1 - (A - 1) * cos + k);
      b1 = 2 * A * (A - 1 - (A + 1) * cos);
      b2 = A * (A + 1 - (A - 1) * cos - k);
      a0 = A + 1 + (A - 1) * cos + k;
      a1 = -2 * (A - 1 + (A + 1) * cos);
      a2 = A + 1 + (A - 1) * cos - k;
    } else {
      b0 = A * (A + 1 + (A - 1) * cos + k);
      b1 = -2 * A * (A - 1 + (A + 1) * cos);
      b2 = A * (A + 1 + (A - 1) * cos - k);
      a0 = A + 1 - (A - 1) * cos + k;
      a1 = 2 * (A - 1 - (A + 1) * cos);
      a2 = A + 1 - (A - 1) * cos - k;
    }
  }
  return { b: [b0 / a0, b1 / a0, b2 / a0], a: [a1 / a0, a2 / a0] };
}

/**
 * Combined magnitude response of the whole EQ in dB at each of `frequencies`
 * -- what the UI draws. Same filter family as the stage, so the curve shown is
 * the curve heard (to within Web Audio's shelf-Q convention).
 */
export function eqResponseDb(
  params: EqParams,
  frequencies: ArrayLike<number>,
  sampleRate = 48000,
): Float32Array {
  const out = new Float32Array(frequencies.length);
  EQ_BAND_FREQUENCIES.forEach((centre, band) => {
    const gain = params.gainsDb[band] ?? 0;
    if (Math.abs(gain) < 1e-4) return;
    const { b, a } = biquadCoefficients(
      eqBandType(band),
      centre,
      EQ_PEAKING_Q,
      gain,
      sampleRate,
    );
    for (let i = 0; i < frequencies.length; i++) {
      const w = (2 * Math.PI * frequencies[i]!) / sampleRate;
      const c1 = Math.cos(w), s1 = Math.sin(w);
      const c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
      const nr = b[0] + b[1] * c1 + b[2] * c2;
      const ni = -(b[1] * s1 + b[2] * s2);
      const dr = 1 + a[0] * c1 + a[1] * c2;
      const di = -(a[0] * s1 + a[1] * s2);
      const mag2 = (nr * nr + ni * ni) / (dr * dr + di * di);
      out[i]! += 10 * Math.log10(Math.max(mag2, 1e-12));
    }
  });
  return out;
}

/**
 * Band gains that make the combined response pass through the targets at the
 * band centres. Adjacent octave bands overlap, so applying the targets
 * directly stacks neighbours (a flat +6 comes out near +9, with a ~3 dB
 * scallop between centres). This solves the interaction away by fixed-point
 * iteration: nudge each band by the error left at its own centre. The result
 * is clamped to the band range, so extreme targets saturate rather than
 * explode.
 */
export function eqEffectiveGains(targets: EqParams): EqParams {
  const t = sanitizeEqParams(targets).gainsDb;
  if (eqIsFlat({ gainsDb: t })) return { gainsDb: t.map(() => 0) };
  let g = [...t];
  for (let iter = 0; iter < 40; iter++) {
    const r = eqResponseDb({ gainsDb: g }, EQ_BAND_FREQUENCIES);
    let worst = 0;
    g = g.map((v, i) => {
      const err = t[i]! - r[i]!;
      worst = Math.max(worst, Math.abs(err));
      return Math.min(EQ_MAX_GAIN_DB, Math.max(EQ_MIN_GAIN_DB, v + err * 0.8));
    });
    if (worst < 0.01) break;
  }
  return { gainsDb: g };
}
