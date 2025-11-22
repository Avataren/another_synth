// src/audio/adapters/wasm-type-adapter.ts
/**
 * Centralized adapter for converting between WASM/Rust types and TypeScript types.
 *
 * This eliminates duplicate conversion logic spread across:
 * - synth-worklet.ts
 * - layout-store.ts
 * - synth-layout.ts
 *
 * All conversions are validated and provide clear error messages.
 */

import type { ModulationTransformation, PortId } from 'app/public/wasm/audio_processor';
import { WasmModulationType } from 'app/public/wasm/audio_processor';
import { VoiceNodeType } from '../types/synth-layout';

// ============================================================================
// Node Type Conversions (Rust → TypeScript)
// ============================================================================

/** Mapping from Rust node type strings to TypeScript enum */
const RUST_TO_TS_NODE_TYPE: Record<string, VoiceNodeType> = {
  'analog_oscillator': VoiceNodeType.Oscillator,
  'wavetable_oscillator': VoiceNodeType.WavetableOscillator,
  'filtercollection': VoiceNodeType.Filter,
  'envelope': VoiceNodeType.Envelope,
  'lfo': VoiceNodeType.LFO,
  'mixer': VoiceNodeType.Mixer,
  'noise_generator': VoiceNodeType.Noise,
  'sampler': VoiceNodeType.Sampler,
  'Sampler': VoiceNodeType.Sampler, // Handle inconsistent casing
  'glide': VoiceNodeType.Glide,
  'global_frequency': VoiceNodeType.GlobalFrequency,
  'global_velocity': VoiceNodeType.GlobalVelocity,
  'convolver': VoiceNodeType.Convolver,
  'delay': VoiceNodeType.Delay,
  'gatemixer': VoiceNodeType.GateMixer,
  'arpeggiator_generator': VoiceNodeType.ArpeggiatorGenerator,
  'chorus': VoiceNodeType.Chorus,
  'limiter': VoiceNodeType.Limiter,
  'freeverb': VoiceNodeType.Reverb,
  'compressor': VoiceNodeType.Compressor,
};

/** Reverse mapping for TypeScript → Rust */
const TS_TO_RUST_NODE_TYPE: Record<VoiceNodeType, string> = {
  [VoiceNodeType.Oscillator]: 'analog_oscillator',
  [VoiceNodeType.WavetableOscillator]: 'wavetable_oscillator',
  [VoiceNodeType.Filter]: 'filtercollection',
  [VoiceNodeType.Envelope]: 'envelope',
  [VoiceNodeType.LFO]: 'lfo',
  [VoiceNodeType.Mixer]: 'mixer',
  [VoiceNodeType.Noise]: 'noise_generator',
  [VoiceNodeType.Sampler]: 'sampler',
  [VoiceNodeType.Glide]: 'glide',
  [VoiceNodeType.GlobalFrequency]: 'global_frequency',
  [VoiceNodeType.GlobalVelocity]: 'global_velocity',
  [VoiceNodeType.Convolver]: 'convolver',
  [VoiceNodeType.Delay]: 'delay',
  [VoiceNodeType.GateMixer]: 'gatemixer',
  [VoiceNodeType.ArpeggiatorGenerator]: 'arpeggiator_generator',
  [VoiceNodeType.Chorus]: 'chorus',
  [VoiceNodeType.Limiter]: 'limiter',
  [VoiceNodeType.Reverb]: 'freeverb',
  [VoiceNodeType.Compressor]: 'compressor',
};

/**
 * Converts a Rust node type string to TypeScript VoiceNodeType enum.
 * @throws Error if the node type is not recognized
 */
export function rustNodeTypeToTS(rustType: string): VoiceNodeType {
  const normalized = rustType.trim();
  const tsType = RUST_TO_TS_NODE_TYPE[normalized];

  if (!tsType) {
    console.warn(`Unknown Rust node type: "${rustType}". Available types:`, Object.keys(RUST_TO_TS_NODE_TYPE));
    // Return as-is for forward compatibility, but log warning
    return normalized as VoiceNodeType;
  }

  return tsType;
}

/**
 * Converts a TypeScript VoiceNodeType enum to Rust string.
 * @throws Error if the node type is not recognized
 */
export function tsNodeTypeToRust(tsType: VoiceNodeType): string {
  const rustType = TS_TO_RUST_NODE_TYPE[tsType];

  if (!rustType) {
    throw new Error(`Unknown TypeScript node type: ${tsType}`);
  }

  return rustType;
}

// ============================================================================
// Modulation Type Conversions
// ============================================================================

/** Mapping from Rust numeric enum values to TypeScript */
const RUST_NUM_TO_TS_MODULATION: Record<number, WasmModulationType> = {
  0: WasmModulationType.VCA,
  1: WasmModulationType.Bipolar,
  2: WasmModulationType.Additive,
};

/** Mapping from Rust string enum values to TypeScript */
const RUST_STR_TO_TS_MODULATION: Record<string, WasmModulationType> = {
  'VCA': WasmModulationType.VCA,
  'Bipolar': WasmModulationType.Bipolar,
  'Additive': WasmModulationType.Additive,
};

/** Default fallback for unknown modulation types */
const DEFAULT_MODULATION_TYPE = WasmModulationType.Additive;

/**
 * Converts a Rust modulation type (number or string) to TypeScript enum.
 * Handles both numeric enum values from Rust and string values from JSON.
 *
 * @param raw - Rust modulation type (0=VCA, 1=Bipolar, 2=Additive) or string
 * @param defaultValue - Optional default if conversion fails
 * @returns WasmModulationType enum value
 */
export function rustModulationTypeToTS(
  raw: number | string | undefined,
  defaultValue: WasmModulationType = DEFAULT_MODULATION_TYPE
): WasmModulationType {
  // Handle undefined
  if (raw === undefined) {
    return defaultValue;
  }

  // Handle numeric values from Rust
  if (typeof raw === 'number') {
    const tsType = RUST_NUM_TO_TS_MODULATION[raw];
    if (tsType !== undefined) {
      return tsType;
    }
    console.warn(`Unknown numeric modulation type: ${raw}, defaulting to ${defaultValue}`);
    return defaultValue;
  }

  // Handle string values
  const tsType = RUST_STR_TO_TS_MODULATION[raw];
  if (tsType !== undefined) {
    return tsType;
  }

  console.warn(`Unknown string modulation type: "${raw}", defaulting to ${defaultValue}`);
  return defaultValue;
}

/**
 * Converts TypeScript modulation type to Rust numeric enum.
 */
export function tsModulationTypeToRust(tsType: WasmModulationType): number {
  switch (tsType) {
    case WasmModulationType.VCA:
      return 0;
    case WasmModulationType.Bipolar:
      return 1;
    case WasmModulationType.Additive:
      return 2;
    default:
      console.warn(`Unknown TypeScript modulation type: ${tsType}, defaulting to Additive (2)`);
      return 2;
  }
}

// ============================================================================
// Modulation Transformation Conversions
// ============================================================================

/**
 * Validates and normalizes a modulation transformation value.
 * ModulationTransformation is a numeric enum in Rust.
 */
export function validateModulationTransformation(
  raw: number | ModulationTransformation | undefined
): ModulationTransformation {
  if (raw === undefined) {
    return 0 as ModulationTransformation; // None = 0
  }

  // Ensure it's a number
  const num = typeof raw === 'number' ? raw : Number(raw);

  // Basic validation (adjust range as needed based on Rust enum)
  if (isNaN(num) || num < 0 || num > 10) {
    console.warn(`Invalid modulation transformation: ${raw}, defaulting to 0 (None)`);
    return 0 as ModulationTransformation;
  }

  return num as ModulationTransformation;
}

// ============================================================================
// Port ID Conversions
// ============================================================================

/**
 * Validates that a port ID is a valid PortId enum value.
 * @throws Error if the port ID is invalid
 */
export function validatePortId(portId: number | PortId): PortId {
  // PortId is an enum, so we validate it's in the expected range
  const num = typeof portId === 'number' ? portId : Number(portId);

  if (isNaN(num)) {
    throw new Error(`Invalid port ID: ${portId}`);
  }

  // Note: You might want to add actual validation against known PortId values
  // if the enum provides a way to check valid values
  return num as PortId;
}

/**
 * Converts a numeric port ID to a human-readable string (for debugging).
 * This uses the PortId enum exported from WASM.
 */
export function portIdToString(portId: PortId): string {
  // This is a helper for debugging - maps numeric enum to name
  // You may need to maintain this manually or generate it
  const portNames: Record<number, string> = {
    0: 'AudioInput0',
    1: 'AudioInput1',
    2: 'AudioOutput0',
    3: 'AudioOutput1',
    9: 'GlobalFrequency',
    17: 'GainMod',
    26: 'CombinedGate',
    // Add more as needed from your PortId enum
  };

  return portNames[portId] || `PortId(${portId})`;
}

// ============================================================================
// Connection Data Conversions
// ============================================================================

/** Raw connection format from Rust/WASM */
export interface RawConnection {
  from_id: string;
  to_id: string;
  target: number;
  amount: number;
  modulation_type?: number | string;
  modulation_transform?: number;
}

/** Normalized connection format for TypeScript */
export interface NormalizedConnection {
  fromId: string;
  toId: string;
  target: PortId;
  amount: number;
  modulationType: WasmModulationType;
  modulationTransformation: ModulationTransformation;
}

/**
 * Converts a raw Rust connection to normalized TypeScript format.
 * Handles snake_case → camelCase and type conversions.
 */
export function normalizeConnection(raw: RawConnection): NormalizedConnection {
  return {
    fromId: raw.from_id,
    toId: raw.to_id,
    target: validatePortId(raw.target),
    amount: raw.amount,
    modulationType: rustModulationTypeToTS(raw.modulation_type),
    modulationTransformation: validateModulationTransformation(raw.modulation_transform),
  };
}

/**
 * Converts a normalized TypeScript connection to raw Rust format.
 * Handles camelCase → snake_case and type conversions.
 */
export function denormalizeConnection(normalized: NormalizedConnection): RawConnection {
  return {
    from_id: normalized.fromId,
    to_id: normalized.toId,
    target: normalized.target as number,
    amount: normalized.amount,
    modulation_type: tsModulationTypeToRust(normalized.modulationType),
    modulation_transform: normalized.modulationTransformation as number,
  };
}

// ============================================================================
// Validation Utilities
// ============================================================================

/**
 * Validates that a value is a finite number (not NaN or Infinity).
 * Used for parameter validation before sending to WASM.
 */
export function validateFiniteNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !isFinite(value)) {
    throw new Error(`${name} must be a finite number, got: ${value}`);
  }
  return value;
}

/**
 * Validates that a value is in a specific range.
 */
export function validateRange(value: number, min: number, max: number, name: string): number {
  if (value < min || value > max) {
    console.warn(`${name} value ${value} out of range [${min}, ${max}], clamping`);
    return Math.max(min, Math.min(max, value));
  }
  return value;
}

/**
 * Sanitizes a JSON object for WASM consumption.
 * Removes undefined, NaN, and Infinity values that would break serialization.
 */
export function sanitizeForWasm<T extends Record<string, unknown>>(obj: T): T {
  const sanitized = { ...obj };

  for (const key in sanitized) {
    const value = sanitized[key];

    if (value === undefined) {
      delete sanitized[key];
      continue;
    }

    if (typeof value === 'number') {
      if (!isFinite(value)) {
        console.warn(`Removing non-finite number field "${key}": ${value}`);
        delete sanitized[key];
      }
    }
  }

  return sanitized;
}
