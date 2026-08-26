import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  serializeCurrentPatch,
  deserializePatch,
} from '../src/audio/serialization/patch-serializer';
import type { Patch } from '../src/audio/types/preset-types';
import type OscillatorStateT from '../src/audio/models/OscillatorState';
import type {
  FilterState,
  EnvelopeConfig,
  LfoState,
  SamplerState,
  GlideState,
  ConvolverState,
  DelayState,
  ChorusState,
  ReverbState,
  CompressorState,
  SaturationState,
  BitcrusherState,
  VelocityState,
} from '../src/audio/types/synth-layout';
import type { NoiseState } from '../src/audio/types/noise';
import {
  combineDetuneParts,
  frequencyFromDetune,
} from '../src/audio/utils/sampler-detune';

/**
 * Exercises every node type present in every real system-bank patch: change
 * every field on every node to a distinctive, non-default value, run it
 * through the exact same deserialize -> re-serialize pipeline the
 * instrument editor uses when saving, and assert the edit stuck perfectly
 * (down to the individual field) and stays stable under a second round
 * trip (simulating a second visit to the editor).
 */

function loadSystemBankPatches(): Patch[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bankPath = path.resolve(here, '../public/system-bank.json');
  const raw = JSON.parse(readFileSync(bankPath, 'utf-8')) as {
    patches: Patch[];
  };
  return raw.patches;
}

// Deterministic but distinctive per-node values so we can be sure the value
// we read back is the value we set, not a coincidental default.
function mutateOscillator(id: string): OscillatorStateT {
  return {
    id,
    phase_mod_amount: 0.37,
    freq_mod_amount: 0.41,
    detune_oct: 2,
    detune_semi: -3,
    detune_cents: 17,
    detune: 123,
    hard_sync: true,
    gain: 0.73,
    feedback_amount: 0.29,
    waveform: 3,
    active: false,
    unison_voices: 5,
    spread: 0.66,
    wave_index: 7,
  } as OscillatorStateT;
}

function mutateFilter(id: string): FilterState {
  return {
    id,
    cutoff: 5432,
    resonance: 0.61,
    keytracking: 0.44,
    comb_frequency: 987,
    comb_dampening: 0.22,
    oversampling: 2,
    gain: 0.88,
    filter_type: 3,
    filter_slope: 1,
    active: false,
  } as FilterState;
}

function mutateEnvelope(id: string): EnvelopeConfig {
  return {
    id,
    attack: 0.13,
    decay: 0.27,
    sustain: 0.62,
    release: 0.81,
    active: false,
    attackCurve: 0.34,
    decayCurve: -0.34,
    releaseCurve: 0.5,
  };
}

function mutateLfo(id: string): LfoState {
  return {
    id,
    frequency: 6.66,
    phaseOffset: 0.25,
    waveform: 2,
    useAbsolute: true,
    useNormalized: true,
    triggerMode: 1,
    gain: 0.42,
    active: false,
    loopMode: 1,
    loopStart: 0.1,
    loopEnd: 0.9,
  };
}

// detune_oct/detune_semi/detune_cents are the source of truth for sampler
// tuning (see normalizeSamplerState in sampler-detune.ts); `detune` and
// `frequency` are always re-derived from them, so the mutation must supply
// self-consistent values or a correct round trip would look like data loss.
const MUTATED_SAMPLER_DETUNE = { oct: -1, semi: 4, cents: -22 };
const MUTATED_SAMPLER_DETUNE_TOTAL = combineDetuneParts(
  MUTATED_SAMPLER_DETUNE.oct,
  MUTATED_SAMPLER_DETUNE.semi,
  MUTATED_SAMPLER_DETUNE.cents,
);
const MUTATED_SAMPLER_FREQUENCY = frequencyFromDetune(
  MUTATED_SAMPLER_DETUNE_TOTAL,
);

function mutateSampler(id: string): SamplerState {
  return {
    id,
    frequency: MUTATED_SAMPLER_FREQUENCY,
    gain: 0.55,
    detune_oct: MUTATED_SAMPLER_DETUNE.oct,
    detune_semi: MUTATED_SAMPLER_DETUNE.semi,
    detune_cents: MUTATED_SAMPLER_DETUNE.cents,
    detune: MUTATED_SAMPLER_DETUNE_TOTAL,
    loopMode: 2,
    loopStart: 0.15,
    loopEnd: 0.85,
    sampleLength: 88200,
    rootNote: 69,
    triggerMode: 0,
    active: false,
    sampleRate: 48000,
    channels: 2,
  } as SamplerState;
}

function mutateGlide(id: string): GlideState {
  return {
    id,
    time: 0.47,
    active: true,
  };
}

function mutateConvolver(id: string): ConvolverState {
  return {
    id,
    wetMix: 0.63,
    active: true,
  } as ConvolverState;
}

function mutateDelay(id: string): DelayState {
  return {
    id,
    delayMs: 333,
    feedback: 0.44,
    wetMix: 0.28,
    active: true,
  };
}

function mutateChorus(id: string): ChorusState {
  return {
    id,
    active: true,
    baseDelayMs: 21,
    depthMs: 4.4,
    lfoRateHz: 1.75,
    feedback: 0.18,
    feedback_filter: 0.35,
    mix: 0.6,
    stereoPhaseOffsetDeg: 45,
  };
}

function mutateReverb(id: string): ReverbState {
  return {
    id,
    active: true,
    room_size: 0.51,
    damp: 0.37,
    wet: 0.49,
    dry: 0.51,
    width: 0.73,
  };
}

function mutateCompressor(id: string): CompressorState {
  return {
    id,
    active: true,
    thresholdDb: -18,
    ratio: 6,
    attackMs: 3,
    releaseMs: 120,
    makeupGainDb: 5,
    mix: 0.65,
  };
}

function mutateSaturation(id: string): SaturationState {
  return {
    id,
    active: true,
    drive: 3.3,
    mix: 0.4,
  };
}

function mutateBitcrusher(id: string): BitcrusherState {
  return {
    id,
    active: true,
    bits: 6,
    downsampleFactor: 8,
    mix: 0.3,
  };
}

const mutatedNoise: NoiseState = {
  noiseType: 1,
  cutoff: 0.42,
  gain: 0.31,
  is_enabled: true,
};

const mutatedVelocity: VelocityState = {
  sensitivity: 0.6,
  randomize: 0.35,
  active: false,
};

function mutateAllNodes(patch: Patch): Patch {
  const deserialized = deserializePatch(patch);

  const remap = <T>(
    map: Map<string, T>,
    mutate: (id: string) => T,
  ): Map<string, T> => {
    const next = new Map<string, T>();
    map.forEach((_value, id) => next.set(id, mutate(id)));
    return next;
  };

  const mutatedMacros = {
    values: [0.11, 0.22, 0.33, 0.44],
    routes: (deserialized.macros?.routes ?? []).map((route, index) => ({
      ...route,
      amount: 0.1 + index * 0.05,
    })),
  };

  return serializeCurrentPatch({
    name: patch.metadata.name,
    layout: deserialized.layout,
    oscillators: remap(deserialized.oscillators, mutateOscillator),
    wavetableOscillators: remap(
      deserialized.wavetableOscillators,
      mutateOscillator,
    ),
    filters: remap(deserialized.filters, mutateFilter),
    envelopes: remap(deserialized.envelopes, mutateEnvelope),
    lfos: remap(deserialized.lfos, mutateLfo),
    samplers: remap(deserialized.samplers, mutateSampler),
    glides: remap(deserialized.glides, mutateGlide),
    convolvers: remap(deserialized.convolvers, mutateConvolver),
    delays: remap(deserialized.delays, mutateDelay),
    choruses: remap(deserialized.choruses, mutateChorus),
    reverbs: remap(deserialized.reverbs, mutateReverb),
    compressors: remap(deserialized.compressors, mutateCompressor),
    saturations: remap(deserialized.saturations, mutateSaturation),
    bitcrushers: remap(deserialized.bitcrushers, mutateBitcrusher),
    noise: mutatedNoise,
    velocity: mutatedVelocity,
    audioAssets: deserialized.audioAssets,
    metadata: patch.metadata,
    macros: mutatedMacros,
    instrumentGain: 1.42,
  });
}

function expectAllNodesMatch(patch: Patch) {
  const deserialized = deserializePatch(patch);

  deserialized.oscillators.forEach((state, id) =>
    expect(state).toEqual(mutateOscillator(id)),
  );
  deserialized.wavetableOscillators.forEach((state, id) =>
    expect(state).toEqual(mutateOscillator(id)),
  );
  deserialized.filters.forEach((state, id) =>
    expect(state).toEqual(mutateFilter(id)),
  );
  deserialized.envelopes.forEach((state, id) =>
    expect(state).toEqual(mutateEnvelope(id)),
  );
  deserialized.lfos.forEach((state, id) =>
    expect(state).toEqual(mutateLfo(id)),
  );
  deserialized.samplers.forEach((state, id) =>
    expect(state).toEqual(mutateSampler(id)),
  );
  deserialized.glides.forEach((state, id) =>
    expect(state).toEqual(mutateGlide(id)),
  );
  deserialized.convolvers.forEach((state, id) =>
    expect(state).toEqual(mutateConvolver(id)),
  );
  deserialized.delays.forEach((state, id) =>
    expect(state).toEqual(mutateDelay(id)),
  );
  deserialized.choruses.forEach((state, id) =>
    expect(state).toEqual(mutateChorus(id)),
  );
  deserialized.reverbs.forEach((state, id) =>
    expect(state).toEqual(mutateReverb(id)),
  );
  deserialized.compressors.forEach((state, id) =>
    expect(state).toEqual(mutateCompressor(id)),
  );
  deserialized.saturations.forEach((state, id) =>
    expect(state).toEqual(mutateSaturation(id)),
  );
  deserialized.bitcrushers.forEach((state, id) =>
    expect(state).toEqual(mutateBitcrusher(id)),
  );
  expect(deserialized.noise).toEqual(mutatedNoise);
  expect(deserialized.velocity).toEqual(mutatedVelocity);
  expect(deserialized.macros?.values).toEqual([0.11, 0.22, 0.33, 0.44]);
  deserialized.macros?.routes?.forEach((route, index) => {
    expect(route.amount).toBeCloseTo(0.1 + index * 0.05, 10);
  });
  expect(patch.synthState.instrumentGain).toBe(1.42);
}

describe('editing every node type persists perfectly through the editor round trip', () => {
  const patches = loadSystemBankPatches();

  it('loaded at least one patch from the system bank fixture', () => {
    expect(patches.length).toBeGreaterThan(0);
  });

  it.each(patches.map((p) => [p.metadata.name, p] as const))(
    'every node edit on "%s" survives save (deserialize -> serialize)',
    (_name, patch) => {
      const saved = mutateAllNodes(patch);
      expectAllNodesMatch(saved);
    },
  );

  it.each(patches.map((p) => [p.metadata.name, p] as const))(
    'every node edit on "%s" survives a second editor visit unchanged',
    (_name, patch) => {
      const saved = mutateAllNodes(patch);
      const deserialized = deserializePatch(saved);
      const resaved = serializeCurrentPatch({
        name: saved.metadata.name,
        layout: deserialized.layout,
        oscillators: deserialized.oscillators,
        wavetableOscillators: deserialized.wavetableOscillators,
        filters: deserialized.filters,
        envelopes: deserialized.envelopes,
        lfos: deserialized.lfos,
        samplers: deserialized.samplers,
        glides: deserialized.glides,
        convolvers: deserialized.convolvers,
        delays: deserialized.delays,
        choruses: deserialized.choruses,
        reverbs: deserialized.reverbs,
        compressors: deserialized.compressors,
        saturations: deserialized.saturations,
        bitcrushers: deserialized.bitcrushers,
        noise: deserialized.noise,
        velocity: deserialized.velocity,
        audioAssets: deserialized.audioAssets,
        metadata: saved.metadata,
        macros: deserialized.macros,
        instrumentGain: saved.synthState.instrumentGain,
      });

      expect(resaved.synthState).toEqual(saved.synthState);
      expectAllNodesMatch(resaved);
    },
  );
});
