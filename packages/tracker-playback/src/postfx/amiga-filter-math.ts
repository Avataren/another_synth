/**
 * Coefficient derivation for the Amiga-style output filter (D114).
 *
 * Pure and unit-testable: no Web Audio, no state. The defaults model the
 * Amiga A500 output chain as libopenmpt does (`soundlib/Paula.cpp`,
 * `BlepTables::InitTables`, fetched 2026-09-04):
 *
 * ```c
 * auto filterFixed5kHz = MakeRCLowpass(sampleRate, 4900.0);
 * auto filterLED       = MakeButterworth(sampleRate, 3275.0, -0.70);
 * auto amiga500Off = filterFixed5kHz.Run(unfilteredA500);
 * auto amiga500On  = filterLED.Run(amiga500Off);
 * ```
 *
 * Documented deviation (D114): libopenmpt's `MakeRCLowpass` is *not*
 * prewarped, and it runs at `PAULA_HZ` (~3.55 MHz) where fc/fs is tiny, so
 * its plain-formula coefficients realize the analog prototype almost exactly
 * *there*. Applying the same formula at our output rates would land the
 * realized -3 dB point near 3.82 kHz @ 44.1 kHz and make it
 * sample-rate-dependent. We instead realize the RC stage with a bilinear
 * transform prewarped at fc (`K = tan(pi*fc/fs)`, `b0 = b1 = K/(1+K)`,
 * `a1 = (K-1)/(K+1)`), so the realized -3 dB point is exactly 4900 Hz at
 * every output rate -- hardware-faithful, since the real A500's RC filter is
 * analog and does not move with our output rate. The LED stage transfers
 * directly: libopenmpt's `MakeButterworth`/`ZTransform` prewarps at fc.
 *
 * All feedback coefficients follow the Web Audio `IIRFilterNode` (and
 * libopenmpt `BiquadFilter`) convention:
 *   y[n] = b0*x[n] + b1*x[n-1] + b2*x[n-2] - a1*y[n-1] - a2*y[n-2]
 */

/** Parameters of the Amiga LPF stage, in libopenmpt-native units. */
export interface AmigaLpfParams {
  /** Stage A: the A500's fixed ~4.9 kHz RC lowpass, prewarped. */
  staticCutoffHz: number;
  /** Stage B: the LED filter's cutoff. */
  ledCutoffHz: number;
  /** Stage B resonance in dB, libopenmpt's `res_dB` (default -0.70). */
  ledResDb: number;
}

/** The Amiga's values. Never store derived Q/zeta as state (D114). */
export const AMIGA_LPF_DEFAULT_PARAMS: AmigaLpfParams = {
  staticCutoffHz: 4900,
  ledCutoffHz: 3275,
  ledResDb: -0.7,
};

/**
 * Derived damping of the default LED stage, for documentation only:
 * `res = 10^(-res_dB/20) ~= 1.08393`, s-domain `a1 = sqrt(2)*res ~= 1.53290`,
 * so zeta = a1/2 ~= 0.76645 and Q = 1/a1 ~= 0.65236. `a1 > sqrt(2)` means more
 * damping than Butterworth: the magnitude is monotone -- there is no peak --
 * and |H(fc)| ~= -5.25 dB. These are consequences of the defaults above,
 * never inputs.
 */
export const AMIGA_LPF_DERIVED_NOTES = {
  zeta: 0.76645,
  q: 0.65236,
} as const;

/** First-order coefficients (b2 = a2 = 0). */
export interface OnePoleCoefficients {
  b0: number;
  b1: number;
  a1: number;
}

/** Biquad coefficients. */
export interface BiquadCoefficients {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export interface AmigaLpfCoefficients {
  rc: OnePoleCoefficients;
  led: BiquadCoefficients;
}

/**
 * Prewarped one-pole RC lowpass: -3 dB exactly at `cutoffHz` at any
 * sample rate.
 */
export function deriveRcPrewarpedCoefficients(
  sampleRate: number,
  cutoffHz: number,
): OnePoleCoefficients {
  const k = Math.tan((Math.PI * cutoffHz) / sampleRate);
  const b0 = k / (1 + k);
  return { b0, b1: b0, a1: (k - 1) / (1 + k) };
}

/**
 * Second-order LED lowpass, reproducing libopenmpt's
 * `MakeButterworth(fs, fc, res_dB)` -> `ZTransform` algebra exactly
 * (prewarped at fc, so it transfers to any output rate):
 *
 *   res = 10^(-res_dB / 10 / 2)
 *   wp  = 2 * fs * tan(pi * fc / fs)
 *   numerator   (libopenmpt "a"): 1
 *   denominator (libopenmpt "b"): 1 + sqrt(2)*res/wp * s + s^2/wp^2
 *   bd = 4*b2*fs^2 + 2*b1*fs + b0   (after prewarp division)
 */
export function deriveLedCoefficients(
  sampleRate: number,
  cutoffHz: number,
  resDb: number,
): BiquadCoefficients {
  const res = Math.pow(10.0, -resDb / 10.0 / 2.0);
  const wp = 2.0 * sampleRate * Math.tan((Math.PI * cutoffHz) / sampleRate);
  // libopenmpt ZTransform(a0, a1, a2, b0, b1, b2, fc, fs) with the call
  // ZTransform(1, 0, 0, 1, sqrt(2)*res, 1, ...): its "a" triple is the
  // numerator, its "b" triple the denominator.
  const numA0 = 1;
  const numA1 = 0;
  const numA2 = 0;
  const denB0 = 1;
  const denB1 = (Math.sqrt(2) * res) / wp;
  const denB2 = 1 / (wp * wp);

  const bd = 4 * denB2 * sampleRate * sampleRate + 2 * denB1 * sampleRate + denB0;
  return {
    b0: (4 * numA2 * sampleRate * sampleRate + 2 * numA1 * sampleRate + numA0) / bd,
    b1: (2 * numA0 - 8 * numA2 * sampleRate * sampleRate) / bd,
    b2: (4 * numA2 * sampleRate * sampleRate - 2 * numA1 * sampleRate + numA0) / bd,
    a1: (2 * denB0 - 8 * denB2 * sampleRate * sampleRate) / bd,
    a2: (4 * denB2 * sampleRate * sampleRate - 2 * denB1 * sampleRate + denB0) / bd,
  };
}

/** Coefficients for both stages at one sample rate. */
export function deriveAmigaLpfCoefficients(
  sampleRate: number,
  params: AmigaLpfParams,
): AmigaLpfCoefficients {
  return {
    rc: deriveRcPrewarpedCoefficients(sampleRate, params.staticCutoffHz),
    led: deriveLedCoefficients(
      sampleRate,
      params.ledCutoffHz,
      params.ledResDb,
    ),
  };
}

/**
 * Clamp helper for UI-provided parameters: finite, and inside the ranges the
 * math stays stable in. Nothing outside these bounds reaches a node.
 */
export function sanitizeAmigaLpfParams(raw: Partial<AmigaLpfParams>): AmigaLpfParams {
  const clamp = (value: unknown, min: number, max: number, fallback: number) => {
    const n = typeof value === 'number' ? value : Number.NaN;
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };
  const d = AMIGA_LPF_DEFAULT_PARAMS;
  return {
    staticCutoffHz: clamp(raw.staticCutoffHz, 200, 20000, d.staticCutoffHz),
    ledCutoffHz: clamp(raw.ledCutoffHz, 200, 20000, d.ledCutoffHz),
    ledResDb: clamp(raw.ledResDb, -12, 6, d.ledResDb),
  };
}