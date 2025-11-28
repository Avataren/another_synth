// src/audio/serialization/patch-serializer.ts
import type {
  Patch,
  SynthState,
  AudioAsset,
  ValidationResult,
  PatchMetadata,
} from '../types/preset-types';
import {
  createDefaultPatchMetadata,
  PRESET_SCHEMA_VERSION,
  type MacroState,
} from '../types/preset-types';
import type OscillatorState from '../models/OscillatorState';
import {
  patchLayoutToSynthLayout,
  synthLayoutToPatchLayout,
} from '../types/synth-layout';
import type {
  SynthLayout,
  PatchLayout,
  FilterState,
  EnvelopeConfig,
  LfoState,
  SamplerState,
  ConvolverState,
  DelayState,
  ChorusState,
  ReverbState,
  CompressorState,
  SaturationState,
  BitcrusherState,
  GlideState,
  VelocityState,
} from '../types/synth-layout';
import {
  FilterType,
  FilterSlope,
  SamplerLoopMode,
  SamplerTriggerMode,
} from '../types/synth-layout';
import type { NoiseState } from '../types/noise';
import { normalizeSamplerState } from '../utils/sampler-detune';

function toNumber(value: unknown, fallback: number): number {
  const num =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(num) ? num : fallback;
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 0 || value === 1) return Boolean(value);
  return fallback;
}

function normalizeOscillatorState(
  osc: Partial<OscillatorState>,
  id: string,
): OscillatorState {
  return {
    id,
    phase_mod_amount: toNumber(osc.phase_mod_amount, 0),
    freq_mod_amount: toNumber(osc.freq_mod_amount, 0),
    detune_oct: toNumber(osc.detune_oct, 0),
    detune_semi: toNumber(osc.detune_semi, 0),
    detune_cents: toNumber(osc.detune_cents, 0),
    detune: toNumber(osc.detune, 0),
    hard_sync: toBoolean(osc.hard_sync, false),
    gain: toNumber(osc.gain, 0.5),
    feedback_amount: toNumber(osc.feedback_amount, 0),
    waveform: toNumber(osc.waveform, 0),
    active: toBoolean(osc.active, true),
    unison_voices: toNumber(osc.unison_voices, 1),
    spread: toNumber(osc.spread, 0),
    wave_index: toNumber(osc.wave_index, 0),
  };
}

function normalizeEnvelopeState(
  env: Partial<EnvelopeConfig>,
  id: string,
): EnvelopeConfig {
  return {
    id,
    attack: toNumber(env.attack, 0),
    decay: toNumber(env.decay, 0.1),
    sustain: toNumber(env.sustain, 0.5),
    release: toNumber(env.release, 0.1),
    active: toBoolean(env.active, true),
    attackCurve: toNumber(env.attackCurve, 0),
    decayCurve: toNumber(env.decayCurve, 0),
    releaseCurve: toNumber(env.releaseCurve, 0),
  };
}

function normalizeLfoState(lfo: Partial<LfoState>, id: string): LfoState {
  const loopMode = toNumber(
    (lfo as Record<string, unknown>).loopMode ??
      (lfo as Record<string, unknown>).loop_mode,
    0,
  );
  return {
    id,
    frequency: toNumber(lfo.frequency, 1.0),
    phaseOffset: toNumber(
      (lfo as Record<string, unknown>).phaseOffset ??
        (lfo as Record<string, unknown>).phase_offset,
      0,
    ),
    waveform: toNumber(lfo.waveform, 0),
    useAbsolute: toBoolean(lfo.useAbsolute, false),
    useNormalized: toBoolean(lfo.useNormalized, false),
    triggerMode: toNumber(
      (lfo as Record<string, unknown>).triggerMode ??
        (lfo as Record<string, unknown>).trigger ??
        (lfo as Record<string, unknown>).trigger_mode,
      0,
    ),
    gain: toNumber(lfo.gain, 1),
    active: toBoolean(lfo.active, true),
    loopMode,
    loopStart: toNumber(
      (lfo as Record<string, unknown>).loopStart ??
        (lfo as Record<string, unknown>).loop_start,
      0.5,
    ),
    loopEnd: toNumber(
      (lfo as Record<string, unknown>).loopEnd ??
        (lfo as Record<string, unknown>).loop_end,
      1,
    ),
  };
}

function normalizeFilterState(
  filter: Partial<FilterState>,
  id: string,
): FilterState {
  const filterType =
    (filter as Record<string, unknown>).filter_type ??
    (filter as Record<string, unknown>).filterType;
  const filterSlope =
    (filter as Record<string, unknown>).filter_slope ??
    (filter as Record<string, unknown>).filterSlope;

  return {
    id,
    cutoff: toNumber(filter.cutoff, 20000),
    resonance: toNumber(filter.resonance, 0),
    keytracking: toNumber(
      (filter as Record<string, unknown>).keytracking ?? filter.keytracking,
      0,
    ),
    comb_frequency: toNumber(filter.comb_frequency, 220),
    comb_dampening: toNumber(filter.comb_dampening, 0.5),
    oversampling: toNumber(filter.oversampling, 0),
    gain: toNumber(filter.gain, 0.5),
    filter_type: toNumber(filterType, FilterType.LowPass) as FilterType,
    filter_slope: toNumber(filterSlope, FilterSlope.Db12) as FilterSlope,
    active: toBoolean(filter.active, true),
  };
}

function normalizeConvolverState(
  convolver: Partial<ConvolverState>,
  id: string,
): ConvolverState {
  return {
    id,
    wetMix: toNumber(convolver.wetMix, 0.1),
    active: toBoolean(convolver.active, false),
    ...(convolver.generator ? { generator: convolver.generator } : {}),
  };
}

function normalizeDelayState(
  delay: Partial<DelayState>,
  id: string,
): DelayState {
  return {
    id,
    delayMs: toNumber(delay.delayMs, 250),
    feedback: toNumber(delay.feedback, 0.5),
    wetMix: toNumber(delay.wetMix, 0.1),
    active: toBoolean(delay.active, false),
  };
}

function normalizeChorusState(
  chorus: Partial<ChorusState>,
  id: string,
): ChorusState {
  return {
    id,
    active: toBoolean(chorus.active, false),
    baseDelayMs: toNumber(chorus.baseDelayMs, 15.0),
    depthMs: toNumber(chorus.depthMs, 5.0),
    lfoRateHz: toNumber(chorus.lfoRateHz, 0.5),
    feedback: toNumber(chorus.feedback, 0.3),
    feedback_filter: toNumber(chorus.feedback_filter, 0.5),
    mix: toNumber(chorus.mix, 0.5),
    stereoPhaseOffsetDeg: toNumber(chorus.stereoPhaseOffsetDeg, 90.0),
  };
}

function normalizeReverbState(
  reverb: Partial<ReverbState>,
  id: string,
): ReverbState {
  return {
    id,
    active: toBoolean(reverb.active, false),
    room_size: toNumber(reverb.room_size, 0.95),
    damp: toNumber(reverb.damp, 0.5),
    wet: toNumber(reverb.wet, 0.3),
    dry: toNumber(reverb.dry, 0.7),
    width: toNumber(reverb.width, 1.0),
  };
}

function normalizeCompressorState(
  comp: Partial<CompressorState>,
  id: string,
): CompressorState {
  return {
    id,
    active: toBoolean(comp.active, false),
    thresholdDb: toNumber(comp.thresholdDb, -12),
    ratio: toNumber(comp.ratio, 4),
    attackMs: toNumber(comp.attackMs, 10),
    releaseMs: toNumber(comp.releaseMs, 80),
    makeupGainDb: toNumber(comp.makeupGainDb, 3),
    mix: toNumber(comp.mix, 0.5),
  };
}

function normalizeSaturationState(
  sat: Partial<SaturationState>,
  id: string,
): SaturationState {
  return {
    id,
    active: toBoolean(sat.active, false),
    drive: toNumber(sat.drive, 2.0),
    mix: toNumber(sat.mix, 0.5),
  };
}

function normalizeBitcrusherState(
  crusher: Partial<BitcrusherState>,
  id: string,
): BitcrusherState {
  return {
    id,
    active: toBoolean(crusher.active, false),
    bits: toNumber(crusher.bits, 12),
    downsampleFactor: toNumber(crusher.downsampleFactor, 4),
    mix: toNumber(crusher.mix, 0.5),
  };
}

function normalizeNoiseState(noise: Partial<NoiseState>): NoiseState {
  const record = noise as Record<string, unknown>;
  const noiseType = toNumber(record.noiseType ?? record.noise_type, 0);
  return {
    noiseType,
    cutoff: toNumber(noise.cutoff, 1.0),
    gain: toNumber(noise.gain, 1.0),
    is_enabled: toBoolean(record.is_enabled ?? record.enabled, false),
  };
}

function normalizeVelocityState(velocity: Partial<VelocityState>): VelocityState {
  return {
    sensitivity: toNumber(velocity.sensitivity, 1.0),
    randomize: toNumber(velocity.randomize, 0.0),
    active: toBoolean(velocity.active, true),
  };
}

function normalizeStateMap<T>(
  map: Map<string, Partial<T>> | undefined,
  normalizer: (state: Partial<T>, id: string) => T,
): Map<string, T> {
  const normalized = new Map<string, T>();
  map?.forEach((state, id) => {
    normalized.set(id, normalizer(state, id));
  });
  return normalized;
}

function normalizeGlideState(
  glide: GlideState | (Partial<GlideState> & { id?: string }),
  id: string,
): GlideState {
  const legacyTime =
    glide.riseTime !== undefined || glide.fallTime !== undefined
      ? Math.max(glide.riseTime ?? 0, glide.fallTime ?? 0)
      : 0;
  const resolvedTime =
    glide.time !== undefined && (glide.time !== 0 || legacyTime === 0)
      ? glide.time
      : legacyTime;

  return {
    id,
    time: resolvedTime ?? 0,
    active: glide.active ?? false,
  };
}

function normalizeSamplerStateWithDefaults(
  sampler: Partial<SamplerState>,
  id: string,
): SamplerState {
  const base: SamplerState = {
    id,
    frequency: toNumber(sampler.frequency, 440.0),
    gain: toNumber(sampler.gain, 1.0),
    detune_oct: toNumber(sampler.detune_oct, 0),
    detune_semi: toNumber(sampler.detune_semi, 0),
    detune_cents: toNumber(sampler.detune_cents, 0),
    detune: toNumber(sampler.detune, 0),
    loopMode: toNumber(sampler.loopMode, SamplerLoopMode.Off) as SamplerLoopMode,
    loopStart: toNumber(sampler.loopStart, 0),
    loopEnd: toNumber(sampler.loopEnd, 1),
    sampleLength: toNumber(
      sampler.sampleLength ?? sampler.sampleRate,
      44100,
    ),
    rootNote: toNumber(sampler.rootNote, 60),
    triggerMode: toNumber(
      sampler.triggerMode,
      SamplerTriggerMode.Gate,
    ) as SamplerTriggerMode,
    active: toBoolean(sampler.active, true),
    sampleRate: toNumber(sampler.sampleRate, 44100),
    channels: toNumber(sampler.channels, 1),
    ...(sampler.fileName ? { fileName: sampler.fileName } : {}),
  };

  return normalizeSamplerState(base);
}

/**
 * Filters out audio assets for convolvers that have generator parameters
 * These will be regenerated from parameters and don't need binary data
 */
function filterConvolverAssets(
  audioAssets: Map<string, AudioAsset>,
  convolvers: Map<string, ConvolverState>,
): Map<string, AudioAsset> {
  const filtered = new Map<string, AudioAsset>();

  audioAssets.forEach((asset, assetId) => {
    // Check if this is an impulse response asset (convolver)
    const parsed = parseAudioAssetId(assetId);
    if (parsed?.nodeType === 'impulse_response') {
      // Check if the convolver has a generator
      const convolverState = convolvers.get(parsed.nodeId);
      if (convolverState?.generator) {
        // Skip this asset - it will be regenerated from parameters
        console.log(
          `Excluding binary data for ${convolverState.generator.type} reverb (node ${parsed.nodeId}) - using generator parameters instead`,
        );
        return;
      }
    }
    // Keep all other assets (non-convolver or convolver without generator)
    filtered.set(assetId, asset);
  });

  return filtered;
}

/**
 * Serializes the current synth state to a Patch object
 */
export function serializeCurrentPatch(
  name: string,
  layout: SynthLayout,
  oscillators: Map<string, OscillatorState>,
  wavetableOscillators: Map<string, OscillatorState>,
  filters: Map<string, FilterState>,
  envelopes: Map<string, EnvelopeConfig>,
  lfos: Map<string, LfoState>,
  samplers: Map<string, SamplerState>,
  glides: Map<string, GlideState>,
  convolvers: Map<string, ConvolverState>,
  delays: Map<string, DelayState>,
  choruses: Map<string, ChorusState>,
  reverbs: Map<string, ReverbState>,
  compressors: Map<string, CompressorState>,
  saturations: Map<string, SaturationState>,
  bitcrushers: Map<string, BitcrusherState>,
  noise?: NoiseState,
  velocity?: VelocityState,
  audioAssets?: Map<string, AudioAsset>,
  metadata?: Partial<PatchMetadata>,
  macros?: MacroState,
  instrumentGain?: number,
): Patch {
  const normalizedOscillators = normalizeStateMap(
    oscillators,
    normalizeOscillatorState,
  );
  const normalizedWavetableOscillators = normalizeStateMap(
    wavetableOscillators,
    normalizeOscillatorState,
  );
  const normalizedEnvelopes = normalizeStateMap(envelopes, normalizeEnvelopeState);
  const normalizedLfos = normalizeStateMap(lfos, normalizeLfoState);
  const normalizedFilters = normalizeStateMap(filters, normalizeFilterState);
  const normalizedSamplers = normalizeStateMap(
    samplers as Map<string, Partial<SamplerState>>,
    normalizeSamplerStateWithDefaults,
  );
  const normalizedGlides = normalizeStateMap(glides, normalizeGlideState);
  const normalizedConvolvers = normalizeStateMap(convolvers, normalizeConvolverState);
  const normalizedDelays = normalizeStateMap(delays, normalizeDelayState);
  const normalizedChoruses = normalizeStateMap(choruses, normalizeChorusState);
  const normalizedReverbs = normalizeStateMap(reverbs, normalizeReverbState);
  const normalizedCompressors = normalizeStateMap(
    compressors,
    normalizeCompressorState,
  );
  const normalizedSaturations = normalizeStateMap(
    saturations,
    normalizeSaturationState,
  );
  const normalizedBitcrushers = normalizeStateMap(
    bitcrushers,
    normalizeBitcrusherState,
  );

  // Create or use provided metadata
  const patchMetadata: PatchMetadata = metadata
    ? {
        ...createDefaultPatchMetadata(name),
        ...metadata,
        name, // Ensure name is set
      }
    : createDefaultPatchMetadata(name);

  // Convert Maps to Records for JSON serialization
  const layoutForPatch = synthLayoutToPatchLayout(layout);
  const synthState: SynthState = {
    layout: layoutForPatch,
    oscillators: mapToRecord(normalizedOscillators),
    wavetableOscillators: mapToRecord(normalizedWavetableOscillators),
    filters: mapToRecord(normalizedFilters),
    envelopes: mapToRecord(normalizedEnvelopes),
    lfos: mapToRecord(normalizedLfos),
    samplers: mapToRecord(normalizedSamplers),
    glides: mapToRecord(normalizedGlides),
    convolvers: mapToRecord(normalizedConvolvers),
    delays: mapToRecord(normalizedDelays),
    choruses: mapToRecord(normalizedChoruses),
    reverbs: mapToRecord(normalizedReverbs),
    compressors: mapToRecord(normalizedCompressors),
    saturations: mapToRecord(normalizedSaturations),
    bitcrushers: mapToRecord(normalizedBitcrushers),
  };

  if (noise !== undefined) {
    synthState.noise = normalizeNoiseState(noise);
  }
  if (velocity !== undefined) {
    synthState.velocity = normalizeVelocityState(velocity);
  }

  if (macros) {
    synthState.macros = {
      values: macros.values ?? [],
      routes: macros.routes ?? [],
    };
  }

  if (instrumentGain !== undefined && instrumentGain !== 1.0) {
    synthState.instrumentGain = instrumentGain;
  }

  // Filter out convolver assets that have generators (they'll be regenerated from parameters)
  const filteredAssets = audioAssets
    ? filterConvolverAssets(audioAssets, normalizedConvolvers)
    : new Map<string, AudioAsset>();

  // Convert audio assets map to record
  const assetRecord = mapToRecord(filteredAssets);

  return {
    metadata: patchMetadata,
    synthState,
    audioAssets: assetRecord,
  };
}

/**
 * Deserializes a Patch object back to individual state components
 */
export interface DeserializedPatch {
  metadata: PatchMetadata;
  layout: SynthLayout;
  oscillators: Map<string, OscillatorState>;
  wavetableOscillators: Map<string, OscillatorState>;
  filters: Map<string, FilterState>;
  envelopes: Map<string, EnvelopeConfig>;
  lfos: Map<string, LfoState>;
  samplers: Map<string, SamplerState>;
  glides: Map<string, GlideState>;
  convolvers: Map<string, ConvolverState>;
  delays: Map<string, DelayState>;
  choruses: Map<string, ChorusState>;
  reverbs: Map<string, ReverbState>;
  compressors: Map<string, CompressorState>;
  saturations: Map<string, SaturationState>;
  bitcrushers: Map<string, BitcrusherState>;
  noise?: NoiseState;
  velocity?: VelocityState;
  audioAssets: Map<string, AudioAsset>;
  macros?: MacroState;
}

export function deserializePatch(patch: Patch): DeserializedPatch {
  const layout = patchLayoutToSynthLayout(patch.synthState.layout);
  const oscillators = normalizeStateMap(
    recordToMap(patch.synthState.oscillators),
    normalizeOscillatorState,
  );
  const wavetableOscillators = normalizeStateMap(
    recordToMap(patch.synthState.wavetableOscillators),
    normalizeOscillatorState,
  );
  const envelopes = normalizeStateMap(
    recordToMap(patch.synthState.envelopes),
    normalizeEnvelopeState,
  );
  const lfos = normalizeStateMap(
    recordToMap(patch.synthState.lfos),
    normalizeLfoState,
  );
  const filters = normalizeStateMap(
    recordToMap(patch.synthState.filters),
    normalizeFilterState,
  );
  const normalizedSamplers = normalizeStateMap(
    recordToMap(patch.synthState.samplers),
    normalizeSamplerStateWithDefaults,
  );
  const normalizedGlides = normalizeStateMap(
    recordToMap(patch.synthState.glides),
    normalizeGlideState,
  );
  const convolvers = normalizeStateMap(
    recordToMap(patch.synthState.convolvers),
    normalizeConvolverState,
  );
  const delays = normalizeStateMap(
    recordToMap(patch.synthState.delays),
    normalizeDelayState,
  );
  const choruses = normalizeStateMap(
    recordToMap(patch.synthState.choruses),
    normalizeChorusState,
  );
  const reverbs = normalizeStateMap(
    recordToMap(patch.synthState.reverbs),
    normalizeReverbState,
  );
  const compressors = normalizeStateMap(
    recordToMap(patch.synthState.compressors ?? {}),
    normalizeCompressorState,
  );
  const saturations = normalizeStateMap(
    recordToMap(patch.synthState.saturations ?? {}),
    normalizeSaturationState,
  );
  const bitcrushers = normalizeStateMap(
    recordToMap(patch.synthState.bitcrushers ?? {}),
    normalizeBitcrusherState,
  );
  const audioAssets = recordToMap(patch.audioAssets);
  const result: DeserializedPatch = {
    metadata: patch.metadata,
    layout,
    oscillators,
    wavetableOscillators,
    filters,
    envelopes,
    lfos,
    samplers: normalizedSamplers,
    glides: normalizedGlides,
    convolvers,
    delays,
    choruses,
    reverbs,
    compressors,
    saturations,
    bitcrushers,
    audioAssets,
  };

  if (patch.synthState.noise !== undefined) {
    result.noise = normalizeNoiseState(patch.synthState.noise);
  }
  if (patch.synthState.velocity !== undefined) {
    result.velocity = normalizeVelocityState(patch.synthState.velocity);
  }

  if (patch.synthState.macros !== undefined) {
    result.macros = patch.synthState.macros;
  }

  return result;
}

/**
 * Validates a patch object structure
 */
export function validatePatch(patch: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!patch || typeof patch !== 'object') {
    return {
      valid: false,
      errors: ['Invalid patch: not an object'],
    };
  }

  const p = patch as Partial<Patch>;

  // Validate metadata
  if (!p.metadata) {
    errors.push('Missing metadata');
  } else {
    if (!p.metadata.id) errors.push('Missing metadata.id');
    if (!p.metadata.name) errors.push('Missing metadata.name');
    if (!p.metadata.version) {
      errors.push('Missing metadata.version');
    } else if (p.metadata.version > PRESET_SCHEMA_VERSION) {
      warnings.push(
        `Patch version ${p.metadata.version} is newer than current version ${PRESET_SCHEMA_VERSION}. Some features may not work correctly.`,
      );
    }
  }

  // Validate synthState
  if (!p.synthState) {
    errors.push('Missing synthState');
  } else {
    if (!p.synthState.layout) {
      errors.push('Missing synthState.layout');
    } else {
      const layout = p.synthState.layout as PatchLayout;
      const hasCanonicalVoice =
        !!layout.canonicalVoice && typeof layout.canonicalVoice === 'object';
      const hasVoiceArray = Array.isArray(layout.voices);

      if (!hasCanonicalVoice && !hasVoiceArray) {
        errors.push(
          'synthState.layout must include canonicalVoice or a voices array',
        );
      }

      const voiceCountValue = layout.voiceCount;
      if (
        voiceCountValue !== undefined &&
        (typeof voiceCountValue !== 'number' || voiceCountValue < 1)
      ) {
        errors.push('synthState.layout.voiceCount must be a positive number');
      }

      if (!layout.globalNodes) {
        errors.push('Missing synthState.layout.globalNodes');
      }
    }

    // Check that state objects exist (can be empty)
    const requiredStateKeys = [
      'oscillators',
      'wavetableOscillators',
      'filters',
      'envelopes',
      'lfos',
      'samplers',
      'convolvers',
      'delays',
      'choruses',
      'reverbs',
    ];

    for (const key of requiredStateKeys) {
      if (!(key in p.synthState)) {
        errors.push(`Missing synthState.${key}`);
      }
    }

    if (p.synthState.macros) {
      const macros = p.synthState.macros as unknown;
      if (typeof macros !== 'object') {
        errors.push('synthState.macros must be an object');
      }
    }
  }

  // Validate audioAssets
  if (!p.audioAssets) {
    errors.push('Missing audioAssets (should at least be an empty object)');
  } else if (typeof p.audioAssets !== 'object') {
    errors.push('audioAssets must be an object');
  }

  const result: ValidationResult = {
    valid: errors.length === 0,
  };

  if (errors.length > 0) {
    result.errors = errors;
  }
  if (warnings.length > 0) {
    result.warnings = warnings;
  }

  return result;
}

/**
 * Exports a patch to JSON string
 */
export function exportPatchToJSON(patch: Patch, pretty = true): string {
  return JSON.stringify(patch, null, pretty ? 2 : undefined);
}

/**
 * Imports a patch from JSON string
 */
export function importPatchFromJSON(json: string): {
  patch?: Patch;
  validation: ValidationResult;
} {
  try {
    const parsed = JSON.parse(json);
    const validation = validatePatch(parsed);

    if (!validation.valid) {
      return { validation };
    }

    return {
      patch: parsed as Patch,
      validation,
    };
  } catch (error) {
    return {
      validation: {
        valid: false,
        errors: [
          `Failed to parse JSON: ${error instanceof Error ? error.message : 'Unknown error'}`,
        ],
      },
    };
  }
}

/**
 * Helper: Convert Map to Record for JSON serialization
 */
function mapToRecord<T>(
  map: Map<string, T>,
): Record<string, T> {
  const record: Record<string, T> = {};
  map.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

/**
 * Helper: Convert Record to Map for deserialization
 */
function recordToMap<T>(record: Record<string | number, T>): Map<string, T> {
  const map = new Map<string, T>();
  if (!record) {
    return map;
  }
  for (const [key, value] of Object.entries(record)) {
    map.set(String(key), value);
  }
  return map;
}

/**
 * Creates an audio asset ID for a node
 */
export function createAudioAssetId(nodeType: string, nodeId: string): string {
  return `${nodeType}_${nodeId}`;
}

/**
 * Parses an audio asset ID to get node type and ID
 */
export function parseAudioAssetId(assetId: string): {
  nodeType: string;
  nodeId: string;
} | null {
  const parts = assetId.split('_');
  if (parts.length < 2) return null;

  const nodeId = parts[parts.length - 1];
  const nodeType = parts.slice(0, -1).join('_');
  return nodeId ? { nodeType, nodeId } : null;
}
