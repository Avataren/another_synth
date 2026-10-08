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
 * Peaking-band Q. Wide bands (0.7) overlap enough for `eqEffectiveGains` to
 * fill the gaps between nodes; at sqrt(2) a boost scallops between centres,
 * and below ~0.6 narrow features (a single mid bump) get too broad.
 */
export const EQ_PEAKING_Q = 0.7;

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

/** Fit grid: log-spaced points over the audible range, plus the band centres. */
const FIT_POINTS_PER_OCTAVE = 8;
const FIT_NODE_WEIGHT = 20;
/** Headroom on the solved filter gains (the curve itself stays within +-12). */
const FIT_GAIN_LIMIT_DB = 24;

interface EqFit {
  frequencies: number[];
  /** Index of each fit point's left node and position (0..1) toward the next. */
  segment: Array<{ left: number; t: number }>;
  /** Pseudo-inverse (UtWU + ridge)^-1 UtW, bands x points. */
  solve: number[][];
}

let fitCache: EqFit | null = null;

/** Solve A x = B for symmetric positive-definite A (small, dense). */
function solveLinear(a: number[][], b: number[][]): number[][] {
  const n = a.length;
  const m = b[0]!.length;
  const aug = a.map((row, r) => [...row, ...b[r]!]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) {
      if (Math.abs(aug[r]![c]!) > Math.abs(aug[pivot]![c]!)) pivot = r;
    }
    [aug[c], aug[pivot]] = [aug[pivot]!, aug[c]!];
    const d = aug[c]![c]!;
    for (let k = c; k < n + m; k++) aug[c]![k]! /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = aug[r]![c]!;
      if (f === 0) continue;
      for (let k = c; k < n + m; k++) aug[r]![k]! -= f * aug[c]![k]!;
    }
  }
  return aug.map((row) => row.slice(n));
}

function buildFit(): EqFit {
  const lo = Math.log2(EQ_BAND_FREQUENCIES[0]!);
  const hi = Math.log2(EQ_BAND_FREQUENCIES[EQ_BAND_COUNT - 1]!);
  const points: Array<{ f: number; w: number }> = [];
  const steps = Math.round((hi - lo) * FIT_POINTS_PER_OCTAVE);
  for (let i = 0; i <= steps; i++) {
    points.push({ f: Math.pow(2, lo + ((hi - lo) * i) / steps), w: 1 });
  }
  for (const f of EQ_BAND_FREQUENCIES) points.push({ f, w: FIT_NODE_WEIGHT });
  const frequencies = points.map((p) => p.f);
  const segment = frequencies.map((f) => {
    let left = 0;
    while (left < EQ_BAND_COUNT - 2 && f >= EQ_BAND_FREQUENCIES[left + 1]!) left++;
    const a = Math.log2(EQ_BAND_FREQUENCIES[left]!);
    const b = Math.log2(EQ_BAND_FREQUENCIES[left + 1]!);
    return { left, t: (Math.log2(f) - a) / (b - a) };
  });
  // Unit response per band (the response is close to linear in dB gain).
  const unit: Float32Array[] = EQ_BAND_FREQUENCIES.map((_, band) => {
    const g = new Array<number>(EQ_BAND_COUNT).fill(0);
    g[band] = 6;
    return eqResponseDb({ gainsDb: g }, frequencies).map((v) => v / 6);
  });
  const n = points.length;
  const ata: number[][] = [];
  for (let i = 0; i < EQ_BAND_COUNT; i++) {
    ata.push([]);
    for (let j = 0; j < EQ_BAND_COUNT; j++) {
      let sum = i === j ? 1e-3 : 0;
      for (let k = 0; k < n; k++) sum += points[k]!.w * unit[i]![k]! * unit[j]![k]!;
      ata[i]!.push(sum);
    }
  }
  const atw: number[][] = unit.map((u) => points.map((p, k) => p.w * u[k]!));
  return { frequencies, segment, solve: solveLinear(ata, atw) };
}

/**
 * Band gains whose combined response follows the curve the user drew.
 *
 * Adjacent octave bands overlap, so applying the targets directly stacks
 * neighbours (a flat +6 comes out near +9, with a ~3 dB scallop between
 * centres), and only forcing the response through the band centres still
 * leaves dips between them. Instead the targets are joined by a smooth curve
 * (smoothstep in log-frequency) and the gains are a weighted least-squares fit
 * to it, nodes weighted heavily so they stay on target. A few Gauss-Newton
 * steps absorb the small nonlinearity. Solved gains may exceed +-12 dB (never the curve you see), within +-24.
 */
export function eqEffectiveGains(targets: EqParams): EqParams {
  const t = sanitizeEqParams(targets).gainsDb;
  if (eqIsFlat({ gainsDb: t })) return { gainsDb: t.map(() => 0) };
  const fit = (fitCache ??= buildFit());
  const want = fit.segment.map(({ left, t: x }) => {
    const s = x * x * (3 - 2 * x);
    return t[left]! * (1 - s) + t[left + 1]! * s;
  });
  let g = [...t];
  for (let iter = 0; iter < 4; iter++) {
    const r = eqResponseDb({ gainsDb: g }, fit.frequencies);
    g = g.map((v, band) => {
      let delta = 0;
      const row = fit.solve[band]!;
      for (let k = 0; k < want.length; k++) delta += row[k]! * (want[k]! - r[k]!);
      return Math.min(FIT_GAIN_LIMIT_DB, Math.max(-FIT_GAIN_LIMIT_DB, v + delta));
    });
  }
  return { gainsDb: g };
}

export interface EqPreset {
  id: string;
  label: string;
  /** Target gains in dB, one per band (31 Hz ... 16 kHz). */
  gainsDb: readonly number[];
}

/** Built-in presets. Gains are the curve you see, not raw band gains. */
export const EQ_PRESETS: readonly EqPreset[] = [
  { id: 'flat', label: 'Flat', gainsDb: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { id: 'bass-boost', label: 'Bass boost', gainsDb: [6, 6, 4, 2, 0, 0, 0, 0, 0, 0] },
  { id: 'treble-boost', label: 'Treble boost', gainsDb: [0, 0, 0, 0, 0, 0, 1, 3, 5, 6] },
  { id: 'loudness', label: 'Loudness', gainsDb: [6, 5, 3, 0, -1, -1, 0, 2, 4, 5] },
  { id: 'warm', label: 'Warm', gainsDb: [2, 3, 3, 2, 0, 0, -1, -2, -3, -4] },
  { id: 'bright', label: 'Bright', gainsDb: [-2, -1, 0, 0, 0, 1, 2, 4, 5, 5] },
  { id: 'presence', label: 'Presence', gainsDb: [0, 0, -1, -1, 0, 2, 4, 4, 1, 0] },
  { id: 'smile', label: 'Smile (V)', gainsDb: [5, 4, 2, 0, -3, -3, 0, 2, 4, 5] },
  { id: 'tame-highs', label: 'Tame harsh highs', gainsDb: [0, 0, 0, 0, 0, 0, -1, -3, -5, -7] },
  { id: 'lo-fi', label: 'Lo-fi', gainsDb: [-12, -9, -4, 0, 2, 3, 2, -3, -9, -12] },
  { id: 'cut-mud', label: 'Cut mud', gainsDb: [0, 0, -2, -5, -3, 0, 0, 0, 0, 0] },
];

/** The preset whose gains match `params` (within 0.25 dB), if any. */
export function matchEqPreset(params: EqParams): EqPreset | null {
  const gains = sanitizeEqParams(params).gainsDb;
  return (
    EQ_PRESETS.find((p) =>
      p.gainsDb.every((g, i) => Math.abs(g - gains[i]!) < 0.25),
    ) ?? null
  );
}
