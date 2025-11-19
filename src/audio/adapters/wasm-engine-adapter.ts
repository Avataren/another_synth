// src/audio/adapters/wasm-engine-adapter.ts
/**
 * Adapter layer for the WASM AudioEngine.
 *
 * This adapter:
 * - Decouples the worklet from direct WASM imports
 * - Provides a clean, typed interface to the audio engine
 * - Handles errors and validation
 * - Makes WASM API changes easier to manage
 * - Enables testing and mocking
 *
 * The worklet should ONLY interact with WASM through this adapter.
 */

import type {
  AudioEngine,
  AutomationAdapter,
  AnalogOscillatorStateUpdate,
  WasmLfoUpdateParams,
  EnvelopeUpdateParams,
} from 'app/public/wasm/audio_processor';
import {
  PortId,
  WasmModulationType,
  type ModulationTransformation,
  initSync,
  AutomationAdapter as WasmAutomationAdapter,
} from 'app/public/wasm/audio_processor';
import { AudioEngine as WasmAudioEngine } from 'app/public/wasm/audio_processor';
import type { EnvelopeConfig, FilterState } from '../types/synth-layout';
import {
  validateFiniteNumber,
  validatePortId,
  sanitizeForWasm,
} from './wasm-type-adapter';

// ============================================================================
// Adapter Interfaces
// ============================================================================

/** Configuration for initializing the WASM engine */
export interface WasmEngineConfig {
  sampleRate: number;
  numVoices: number;
  wasmBinary: ArrayBuffer;
}

/** Result of engine initialization */
export interface InitializationResult {
  success: boolean;
  error?: string;
}

/** State returned from WASM engine */
export interface WasmEngineState {
  // Raw state from WASM - structure depends on Rust implementation
  [key: string]: unknown;
}

// ============================================================================
// WasmEngineAdapter Class
// ============================================================================

export class WasmEngineAdapter {
  private engine: AudioEngine | null = null;
  private automationAdapter: AutomationAdapter | null = null;
  private initialized = false;
  private sampleRate = 0;
  private numVoices = 0;

  // Configuration
  private readonly macroCount = 16;
  private readonly macroBufferSize = 128;

  // ========================================================================
  // Initialization
  // ========================================================================

  /**
   * Initializes the WASM module and audio engine.
   */
  initialize(config: WasmEngineConfig): InitializationResult {
    try {
      // Initialize WASM module
      initSync({ module: new Uint8Array(config.wasmBinary) });

      // Create engine
      this.sampleRate = validateFiniteNumber(config.sampleRate, 'sampleRate');
      this.numVoices = Math.floor(validateFiniteNumber(config.numVoices, 'numVoices'));

      this.engine = new WasmAudioEngine(this.sampleRate);
      this.engine.init(this.sampleRate, this.numVoices);

      // Create automation adapter
      this.automationAdapter = new WasmAutomationAdapter(
        this.numVoices,
        this.macroCount,
        this.macroBufferSize
      );

      this.initialized = true;

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[WasmEngineAdapter] Initialization failed:', errorMessage);
      return {
        success: false,
        error: `WASM initialization failed: ${errorMessage}`,
      };
    }
  }

  /**
   * Checks if the engine is initialized.
   */
  isInitialized(): boolean {
    return this.initialized && this.engine !== null;
  }

  /**
   * Gets the engine instance (throws if not initialized).
   */
  private requireEngine(): AudioEngine {
    if (!this.engine) {
      throw new Error('WASM engine not initialized. Call initialize() first.');
    }
    return this.engine;
  }

  /**
   * Gets the automation adapter (throws if not initialized).
   */
  getAutomationAdapter(): AutomationAdapter {
    if (!this.automationAdapter) {
      throw new Error('Automation adapter not initialized.');
    }
    return this.automationAdapter;
  }

  // ========================================================================
  // Patch Operations
  // ========================================================================

  /**
   * Loads a patch from JSON string.
   * @returns Number of voices in the loaded patch
   */
  loadPatch(patchJson: string): number {
    const engine = this.requireEngine();

    try {
      const voiceCount = engine.initWithPatch(patchJson);

      if (!Number.isFinite(voiceCount) || voiceCount <= 0) {
        throw new Error(`Invalid voice count returned: ${voiceCount}`);
      }

      // Update voice count and recreate automation adapter
      this.numVoices = voiceCount;
      this.automationAdapter = new WasmAutomationAdapter(
        this.numVoices,
        this.macroCount,
        this.macroBufferSize
      );

      return voiceCount;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[WasmEngineAdapter] Failed to load patch:', errorMessage);
      throw new Error(`Patch loading failed: ${errorMessage}`);
    }
  }

  /**
   * Gets the current engine state (layout, nodes, connections).
   */
  getCurrentState(): WasmEngineState {
    const engine = this.requireEngine();
    return engine.get_current_state() as WasmEngineState;
  }

  // ========================================================================
  // Node Creation
  // ========================================================================

  createMixer(): string {
    return this.requireEngine().create_mixer() as string;
  }

  createFilter(): string {
    return this.requireEngine().create_filter();
  }

  createSampler(): string {
    return this.requireEngine().create_sampler();
  }

  createWavetableOscillator(): string {
    return this.requireEngine().create_wavetable_oscillator();
  }

  createOscillator(): string {
    return this.requireEngine().create_oscillator();
  }

  createEnvelope(): string {
    return this.requireEngine().create_envelope();
  }

  createLfo(): string {
    return this.requireEngine().create_lfo();
  }

  createNoise(): string {
    return this.requireEngine().create_noise();
  }

  createArpeggiator(): string {
    return this.requireEngine().create_arpeggiator();
  }

  // ========================================================================
  // Node Updates
  // ========================================================================

  updateOscillator(oscillatorId: string, state: AnalogOscillatorStateUpdate): void {
    const sanitized = sanitizeForWasm(state as Record<string, unknown>);
    this.requireEngine().update_oscillator(oscillatorId, sanitized as AnalogOscillatorStateUpdate);
  }

  updateWavetableOscillator(oscillatorId: string, state: AnalogOscillatorStateUpdate): void {
    const sanitized = sanitizeForWasm(state as Record<string, unknown>);
    this.requireEngine().update_wavetable_oscillator(oscillatorId, sanitized as AnalogOscillatorStateUpdate);
  }

  updateEnvelope(envelopeId: string, config: EnvelopeConfig): void {
    const params: EnvelopeUpdateParams = {
      attack: validateFiniteNumber(config.attack, 'attack'),
      decay: validateFiniteNumber(config.decay, 'decay'),
      sustain: validateFiniteNumber(config.sustain, 'sustain'),
      release: validateFiniteNumber(config.release, 'release'),
      active: Boolean(config.active),
    };
    this.requireEngine().update_envelope(envelopeId, params);
  }

  updateLfos(params: WasmLfoUpdateParams[]): void {
    this.requireEngine().update_lfos(params);
  }

  updateFilter(filterId: string, state: FilterState): void {
    // Note: This assumes the WASM interface matches FilterState
    // You may need to add a proper update_filter method to the WASM engine
    console.warn('[WasmEngineAdapter] updateFilter not yet implemented in WASM');
  }

  updateSampler(samplerId: string, state: Partial<{
    gain: number;
    frequency: number;
    loopMode: number;
    loopStart: number;
    loopEnd: number;
    triggerMode: number;
    rootNote: number;
    active: boolean;
  }>): void {
    const sanitized = sanitizeForWasm(state as Record<string, unknown>);
    this.requireEngine().update_sampler(samplerId, sanitized);
  }

  updateNoise(noiseId: string, params: { active: boolean; gain: number; noise_type: number }): void {
    this.requireEngine().update_noise(noiseId, params);
  }

  updateChorus(chorusId: string, params: {
    base_delay_ms: number;
    depth_ms: number;
    lfo_rate_hz: number;
    feedback: number;
    feedback_filter: number;
    mix: number;
    stereo_phase_offset_deg: number;
    active: boolean;
  }): void {
    this.requireEngine().update_chorus(chorusId, params);
  }

  updateReverb(reverbId: string, params: {
    room_size: number;
    damp: number;
    wet: number;
    dry: number;
    width: number;
    active: boolean;
  }): void {
    this.requireEngine().update_reverb(reverbId, params);
  }

  updateConvolver(convolverId: string, wetMix: number, active: boolean): void {
    this.requireEngine().update_convolver(convolverId, wetMix, active);
  }

  updateDelay(delayId: string, params: {
    delay_ms: number;
    feedback: number;
    wet_mix: number;
    active: boolean;
  }): void {
    this.requireEngine().update_delay(delayId, params);
  }

  updateVelocity(voiceIndex: number, velocity: number): void {
    this.requireEngine().update_velocity(voiceIndex, velocity);
  }

  // ========================================================================
  // Connection Management
  // ========================================================================

  connectNodes(
    fromId: string,
    fromPort: PortId,
    toId: string,
    toPort: PortId,
    amount: number,
    modulationType: WasmModulationType,
    modulationTransform: ModulationTransformation
  ): void {
    const validFromPort = validatePortId(fromPort);
    const validToPort = validatePortId(toPort);
    const validAmount = validateFiniteNumber(amount, 'amount');

    this.requireEngine().connect_nodes(
      fromId,
      validFromPort,
      toId,
      validToPort,
      validAmount,
      modulationType,
      modulationTransform
    );
  }

  removeConnection(fromId: string, toId: string, toPort: PortId): void {
    const validToPort = validatePortId(toPort);
    this.requireEngine().remove_specific_connection(fromId, toId, validToPort);
  }

  // ========================================================================
  // Audio Asset Management
  // ========================================================================

  importSample(nodeId: string, audioData: Uint8Array): void {
    this.requireEngine().import_sample(nodeId, audioData);
  }

  importImpulseResponse(effectId: string, audioData: Uint8Array): void {
    this.requireEngine().import_wave_impulse(effectId, audioData);
  }

  // ========================================================================
  // Data Export (for visualization)
  // ========================================================================

  getSamplerWaveform(samplerId: string, numPoints: number): Float32Array | null {
    try {
      const waveform = this.requireEngine().get_sampler_waveform(samplerId, numPoints);
      return waveform instanceof Float32Array ? waveform : null;
    } catch (error) {
      console.warn('[WasmEngineAdapter] Failed to get sampler waveform:', error);
      return null;
    }
  }

  getFilterIrWaveform(filterId: string, numPoints: number): Float32Array | null {
    try {
      const waveform = this.requireEngine().get_filter_ir_waveform(filterId, numPoints);
      return waveform instanceof Float32Array ? waveform : null;
    } catch (error) {
      console.warn('[WasmEngineAdapter] Failed to get filter IR waveform:', error);
      return null;
    }
  }

  getLfoWaveform(lfoId: string, numPoints: number, sampleRate: number): Float32Array | null {
    try {
      const waveform = this.requireEngine().get_lfo_waveform(lfoId, numPoints, sampleRate);
      return waveform instanceof Float32Array ? waveform : null;
    } catch (error) {
      console.warn('[WasmEngineAdapter] Failed to get LFO waveform:', error);
      return null;
    }
  }

  exportSampleData(samplerId: string): Uint8Array | null {
    try {
      const data = this.requireEngine().export_sample_data(samplerId);
      return data instanceof Uint8Array ? data : null;
    } catch (error) {
      console.warn('[WasmEngineAdapter] Failed to export sample data:', error);
      return null;
    }
  }

  exportConvolverData(convolverId: string): Uint8Array | null {
    try {
      const data = this.requireEngine().export_convolver_data(convolverId);
      return data instanceof Uint8Array ? data : null;
    } catch (error) {
      console.warn('[WasmEngineAdapter] Failed to export convolver data:', error);
      return null;
    }
  }

  // ========================================================================
  // Performance & Voice Management
  // ========================================================================

  getNumVoices(): number {
    return this.numVoices;
  }

  getSampleRate(): number {
    return this.sampleRate;
  }
}
