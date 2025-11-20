import type { SamplerState } from '../types/synth-layout';

export const BASE_SAMPLER_TUNING_FREQUENCY = 440;
export const CENTS_PER_SEMITONE = 100;
export const CENTS_PER_OCTAVE = 1200;
export const DETUNE_LIMITS = {
  oct: { min: -5, max: 5 },
  semi: { min: -12, max: 12 },
  cents: { min: -100, max: 100 },
} as const;

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

export function combineDetuneParts(
  detuneOct = 0,
  detuneSemi = 0,
  detuneCents = 0,
): number {
  return (
    detuneOct * CENTS_PER_OCTAVE +
    detuneSemi * CENTS_PER_SEMITONE +
    detuneCents
  );
}

export function frequencyFromDetune(
  detuneCents: number,
  baseFrequency = BASE_SAMPLER_TUNING_FREQUENCY,
): number {
  return (
    baseFrequency * Math.pow(2, detuneCents / CENTS_PER_OCTAVE)
  );
}

export function detuneFromFrequency(
  frequency: number,
  baseFrequency = BASE_SAMPLER_TUNING_FREQUENCY,
): number {
  if (!frequency || !isFinite(frequency) || frequency <= 0) {
    return 0;
  }
  return (
    Math.log(frequency / baseFrequency) / Math.log(2)
  ) * CENTS_PER_OCTAVE;
}

export function splitDetune(detuneCents: number): {
  detune_oct: number;
  detune_semi: number;
  detune_cents: number;
} {
  const clampedOct = clamp(
    Math.trunc(detuneCents / CENTS_PER_OCTAVE),
    DETUNE_LIMITS.oct.min,
    DETUNE_LIMITS.oct.max,
  );
  let remainder = detuneCents - clampedOct * CENTS_PER_OCTAVE;
  const clampedSemi = clamp(
    Math.trunc(remainder / CENTS_PER_SEMITONE),
    DETUNE_LIMITS.semi.min,
    DETUNE_LIMITS.semi.max,
  );
  remainder -= clampedSemi * CENTS_PER_SEMITONE;
  const clampedCents = clamp(
    remainder,
    DETUNE_LIMITS.cents.min,
    DETUNE_LIMITS.cents.max,
  );
  return {
    detune_oct: clampedOct,
    detune_semi: clampedSemi,
    detune_cents: clampedCents,
  };
}

export function normalizeSamplerState(state: SamplerState): SamplerState {
  const normalized: SamplerState = {
    ...state,
    detune_oct: state.detune_oct ?? 0,
    detune_semi: state.detune_semi ?? 0,
    detune_cents: state.detune_cents ?? 0,
  };

  normalized.detune_oct = clamp(
    normalized.detune_oct ?? 0,
    DETUNE_LIMITS.oct.min,
    DETUNE_LIMITS.oct.max,
  );
  normalized.detune_semi = clamp(
    normalized.detune_semi ?? 0,
    DETUNE_LIMITS.semi.min,
    DETUNE_LIMITS.semi.max,
  );
  normalized.detune_cents = clamp(
    normalized.detune_cents ?? 0,
    DETUNE_LIMITS.cents.min,
    DETUNE_LIMITS.cents.max,
  );

  const hasExplicitComponents =
    state.detune_oct !== undefined ||
    state.detune_semi !== undefined ||
    state.detune_cents !== undefined;

  let detuneCents: number;
  if (hasExplicitComponents) {
    detuneCents = combineDetuneParts(
      normalized.detune_oct,
      normalized.detune_semi,
      normalized.detune_cents,
    );
  } else if (state.detune !== undefined) {
    detuneCents = state.detune;
  } else {
    detuneCents = detuneFromFrequency(
      state.frequency ?? BASE_SAMPLER_TUNING_FREQUENCY,
    );
  }

  if (!Number.isFinite(detuneCents)) {
    detuneCents = 0;
  }

  if (!hasExplicitComponents) {
    const parts = splitDetune(detuneCents);
    normalized.detune_oct = parts.detune_oct;
    normalized.detune_semi = parts.detune_semi;
    normalized.detune_cents = parts.detune_cents;
  }

  normalized.detune = detuneCents;
  normalized.frequency = frequencyFromDetune(detuneCents);
  return normalized;
}
