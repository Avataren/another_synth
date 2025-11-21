// src/audio/types/preset-types.ts
import type OscillatorState from '../models/OscillatorState';
import type {
  PatchLayout,
  FilterState,
  EnvelopeConfig,
  LfoState,
  SamplerState,
  ConvolverState,
  DelayState,
  ChorusState,
  ReverbState,
  VelocityState,
  GlideState,
} from './synth-layout';
import type { NoiseState } from './noise';

/**
 * Audio asset types that can be stored in patches
 */
export enum AudioAssetType {
  /** WAV audio sample for Sampler nodes */
  Sample = 'sample',
  /** Impulse response for Convolver nodes */
  ImpulseResponse = 'impulse_response',
  /** Custom wavetable data */
  Wavetable = 'wavetable',
}

/**
 * Audio asset with base64-encoded data
 */
export interface AudioAsset {
  /** Unique identifier for this asset (e.g., "sampler_42") */
  id: string;
  /** Type of audio asset */
  type: AudioAssetType;
  /** Base64-encoded audio data */
  base64Data: string;
  /** Sample rate of the audio */
  sampleRate: number;
  /** Number of channels (1 = mono, 2 = stereo) */
  channels: number;
  /** For samples: MIDI root note (60 = C4) */
  rootNote?: number;
  /** Original filename if available */
  fileName?: string;
  /** Duration in seconds */
  duration?: number;
}

/**
 * Metadata for a patch
 */
export interface PatchMetadata {
  /** Unique identifier for this patch */
  id: string;
  /** User-friendly name */
  name: string;
  /** Hierarchical category path, e.g. "FM/Lead" */
  category?: string | undefined;
  /** Author/creator name */
  author?: string;
  /** Tags for categorization */
  tags?: string[];
  /** Description or notes */
  description?: string;
  /** Creation timestamp */
  created: number;
  /** Last modification timestamp */
  modified: number;
  /** Schema version for compatibility */
  version: number;
}

/**
 * Complete synthesizer state snapshot
 * All state maps use node ID as key
 */
export interface SynthState {
  /** Synth layout with voices and connections */
  layout: PatchLayout;

  /** Oscillator states by node ID */
  oscillators: Record<string, OscillatorState>;

  /** Wavetable oscillator states by node ID */
  wavetableOscillators: Record<string, OscillatorState>;

  /** Filter states by node ID */
  filters: Record<string, FilterState>;

  /** Envelope states by node ID */
  envelopes: Record<string, EnvelopeConfig>;

  /** LFO states by node ID */
  lfos: Record<string, LfoState>;

  /** Sampler states by node ID */
  samplers: Record<string, SamplerState>;

  /** Glide states by node ID */
  glides: Record<string, GlideState>;

  /** Convolver states by node ID */
  convolvers: Record<string, ConvolverState>;

  /** Delay states by node ID */
  delays: Record<string, DelayState>;

  /** Chorus states by node ID */
  choruses: Record<string, ChorusState>;

  /** Reverb states by node ID */
  reverbs: Record<string, ReverbState>;

  /** Global noise state */
  noise?: NoiseState;

  /** Global velocity state */
  velocity?: VelocityState;
}

/**
 * Complete patch with metadata, state, and audio assets
 */
export interface Patch {
  /** Patch metadata */
  metadata: PatchMetadata;

  /** Complete synthesizer state */
  synthState: SynthState;

  /** Audio assets (samples, impulse responses, etc.) */
  audioAssets: Record<string, AudioAsset>;
}

/**
 * Bank metadata
 */
export interface BankMetadata {
  /** Unique identifier for this bank */
  id: string;
  /** User-friendly name */
  name: string;
  /** Author/creator name */
  author?: string;
  /** Description or notes */
  description?: string;
  /** Creation timestamp */
  created: number;
  /** Last modification timestamp */
  modified: number;
  /** Schema version for compatibility */
  version: number;
}

/**
 * Bank - collection of patches
 */
export interface Bank {
  /** Bank metadata */
  metadata: BankMetadata;

  /** Array of patches in this bank */
  patches: Patch[];
}

/**
 * Validation result for patch/bank import
 */
export interface ValidationResult {
  /** Whether the validation passed */
  valid: boolean;
  /** Error messages if validation failed */
  errors?: string[];
  /** Warning messages (non-critical issues) */
  warnings?: string[];
}

/**
 * Current preset schema version
 * Increment when making breaking changes to the preset format
 */
export const PRESET_SCHEMA_VERSION = 1;

/**
 * Helper to create default patch metadata
 */
export function createDefaultPatchMetadata(
  name: string,
  category?: string,
): PatchMetadata {
  const now = Date.now();
  return {
    id: `patch_${now}_${Math.random().toString(36).substring(2, 9)}`,
    name,
    ...(category ? { category } : {}),
    created: now,
    modified: now,
    version: PRESET_SCHEMA_VERSION,
  };
}

/**
 * Helper to create default bank metadata
 */
export function createDefaultBankMetadata(name: string): BankMetadata {
  const now = Date.now();
  return {
    id: `bank_${now}_${Math.random().toString(36).substring(2, 9)}`,
    name,
    created: now,
    modified: now,
    version: PRESET_SCHEMA_VERSION,
  };
}

/**
 * Helper to create an empty synth state
 */
export function createEmptySynthState(): SynthState {
  return {
    layout: {
      voiceCount: 0,
      voices: [],
      globalNodes: {},
    },
    oscillators: {},
    wavetableOscillators: {},
    filters: {},
    envelopes: {},
    lfos: {},
    samplers: {},
    glides: {},
    convolvers: {},
    delays: {},
    choruses: {},
    reverbs: {},
  };
}
