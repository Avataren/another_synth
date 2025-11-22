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
  GlideState,
  VelocityState,
} from '../types/synth-layout';
import type { NoiseState } from '../types/noise';
import { normalizeSamplerState } from '../utils/sampler-detune';

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
  noise?: NoiseState,
  velocity?: VelocityState,
  audioAssets?: Map<string, AudioAsset>,
  metadata?: Partial<PatchMetadata>,
): Patch {
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
    oscillators: mapToRecord(oscillators),
    wavetableOscillators: mapToRecord(wavetableOscillators),
    filters: mapToRecord(filters),
    envelopes: mapToRecord(envelopes),
    lfos: mapToRecord(lfos),
    samplers: mapToRecord(samplers),
    glides: mapToRecord(glides),
    convolvers: mapToRecord(convolvers),
    delays: mapToRecord(delays),
    choruses: mapToRecord(choruses),
    reverbs: mapToRecord(reverbs),
    compressors: mapToRecord(compressors),
  };

  if (noise !== undefined) {
    synthState.noise = noise;
  }
  if (velocity !== undefined) {
    synthState.velocity = velocity;
  }

  // Convert audio assets map to record
  const assetRecord = audioAssets ? mapToRecord(audioAssets) : {};

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
  noise?: NoiseState;
  velocity?: VelocityState;
  audioAssets: Map<string, AudioAsset>;
}

export function deserializePatch(patch: Patch): DeserializedPatch {
  const layout = patchLayoutToSynthLayout(patch.synthState.layout);
  const samplers = recordToMap(patch.synthState.samplers);
  const normalizedSamplers = new Map(
    Array.from(samplers.entries()).map(([id, state]) => [
      id,
      normalizeSamplerState({
        ...state,
        id,
      }),
    ]),
  );
  const normalizedGlides = new Map(
    Array.from(recordToMap(patch.synthState.glides).entries()).map(([id, glide]) => [
      id,
      normalizeGlideState(glide, id),
    ]),
  );
  const result: DeserializedPatch = {
    metadata: patch.metadata,
    layout,
    oscillators: recordToMap(patch.synthState.oscillators),
    wavetableOscillators: recordToMap(patch.synthState.wavetableOscillators),
    filters: recordToMap(patch.synthState.filters),
    envelopes: recordToMap(patch.synthState.envelopes),
    lfos: recordToMap(patch.synthState.lfos),
    samplers: normalizedSamplers,
    glides: normalizedGlides,
    convolvers: recordToMap(patch.synthState.convolvers),
  delays: recordToMap(patch.synthState.delays),
  choruses: recordToMap(patch.synthState.choruses),
  reverbs: recordToMap(patch.synthState.reverbs),
  compressors: recordToMap(patch.synthState.compressors ?? {}),
  audioAssets: recordToMap(patch.audioAssets),
};

  if (patch.synthState.noise !== undefined) {
    result.noise = patch.synthState.noise;
  }
  if (patch.synthState.velocity !== undefined) {
    result.velocity = patch.synthState.velocity;
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
