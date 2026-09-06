/**
 * Parameters and curve derivation for the post-fx brickwall limiter.
 *
 * Pure and unit-testable: no Web Audio, no state -- the same shape as
 * `amiga-filter-math.ts`.
 *
 * The limiter is two cooperating parts (see `limiter-stage.ts`):
 *
 *  1. A `DynamicsCompressorNode` doing the musical work at a high ratio. It
 *     is smooth and (in Chrome) internally lookahead'd, but it is *not* a
 *     brickwall: fast transients overshoot the threshold before the gain
 *     computer catches them.
 *  2. A `WaveShaperNode` holding the ceiling absolutely. Its curve is exactly
 *     the identity below a knee and saturates asymptotically to the ceiling
 *     above it, so it is inaudible on everything the compressor already
 *     handled and only shaves the overshoot.
 *
 * Together: nothing leaves the rack above the ceiling, and in normal
 * listening the shaper is doing almost nothing.
 */

/** User-facing limiter parameters. */
export interface LimiterParams {
  /** Output ceiling in dBFS. Nothing leaves the stage above this. */
  ceilingDb: number;
  /** Compressor release in milliseconds. */
  releaseMs: number;
}

/**
 * Defaults: a ceiling just under full scale (leaving room for the
 * inter-sample peaks a DAC reconstructs above our samples) and a release slow
 * enough not to pump on a four-channel MOD mix.
 */
export const LIMITER_DEFAULT_PARAMS: LimiterParams = {
  ceilingDb: -1.5,
  releaseMs: 150,
};

/**
 * Fixed compressor settings. These are what makes the node a limiter rather
 * than a compressor, so they are not exposed: the maximum ratio the Web Audio
 * node offers, a hard knee, and the fastest attack that does not distort bass
 * (3 ms -- the shaper covers what leaks through in the meantime).
 */
export const LIMITER_RATIO = 20;
export const LIMITER_KNEE_DB = 0;
export const LIMITER_ATTACK_SECONDS = 0.003;

/**
 * Where the shaper's soft knee starts, as a fraction of the ceiling. Below
 * `KNEE * ceiling` the curve is the identity to within float precision, so
 * ordinary material passes through untouched.
 */
export const LIMITER_SHAPER_KNEE = 0.85;

/** Samples in the generated shaper curve (odd, so 0 maps exactly to 0). */
export const LIMITER_CURVE_SIZE = 8193;

export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

export function linearToDb(linear: number): number {
  return 20 * Math.log10(Math.max(linear, 1e-9));
}

/**
 * The transfer function of the safety clipper, for one sample.
 *
 * `x` is the raw signal; `ceiling` is linear amplitude. Below `knee*ceiling`
 * this is exactly `x`; above, it approaches `ceiling` asymptotically and never
 * exceeds it (`tanh` saturates to exactly 1 in float64 for large arguments,
 * so hot input lands *on* the ceiling, never past it), with a continuous
 * first derivative at the knee -- the derivative of `tanh` at 0 is 1, which
 * is the slope of the identity leg.
 */
export function limiterShaperTransfer(
  x: number,
  ceiling: number,
  knee: number = LIMITER_SHAPER_KNEE,
): number {
  const sign = x < 0 ? -1 : 1;
  const magnitude = Math.abs(x);
  const kneeLevel = knee * ceiling;
  if (magnitude <= kneeLevel) return x;
  const range = ceiling - kneeLevel;
  if (range <= 0) return sign * ceiling;
  return sign * (kneeLevel + range * Math.tanh((magnitude - kneeLevel) / range));
}

/**
 * Build the `WaveShaperNode` curve for a ceiling.
 *
 * The curve spans the node's input domain [-1, 1]; inputs outside it are
 * clamped by the node to the endpoint values, which are already at (just
 * under) the ceiling -- so the brickwall holds for input hotter than full
 * scale too, which is exactly the case that motivates the stage.
 */
export function buildLimiterCurve(
  ceilingLinear: number,
  size: number = LIMITER_CURVE_SIZE,
): Float32Array {
  const curve = new Float32Array(size);
  const last = size - 1;
  for (let i = 0; i < size; i++) {
    const x = (i / last) * 2 - 1;
    curve[i] = limiterShaperTransfer(x, ceilingLinear);
  }
  return curve;
}

/**
 * Clamp UI-provided parameters to ranges the stage stays sane in. Nothing
 * outside these bounds reaches a node.
 */
export function sanitizeLimiterParams(raw: Partial<LimiterParams>): LimiterParams {
  const clamp = (value: unknown, min: number, max: number, fallback: number) => {
    const n = typeof value === 'number' ? value : Number.NaN;
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };
  const d = LIMITER_DEFAULT_PARAMS;
  return {
    ceilingDb: clamp(raw.ceilingDb, -24, 0, d.ceilingDb),
    releaseMs: clamp(raw.releaseMs, 20, 1000, d.releaseMs),
  };
}
