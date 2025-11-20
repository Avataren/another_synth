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
  PortId,
  WasmModulationType,
  ModulationTransformation,
  Waveform,
  WasmNoiseType,
} from 'app/public/wasm/audio_processor';
import {
  initSync,
  AutomationAdapter as WasmAutomationAdapter,
  AnalogOscillatorStateUpdate,
  WavetableOscillatorStateUpdate,
  WasmLfoUpdateParams,
  NoiseUpdateParams,
} from 'app/public/wasm/audio_processor';
import { AudioEngine as WasmAudioEngine } from 'app/public/wasm/audio_processor';
import type { EnvelopeConfig, FilterState } from '../types/synth-layout';
import {
  validateFiniteNumber,
  validatePortId,
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

  updateOscillator(oscillatorId: string, state: {
    phase_mod_amount?: number;
    detune?: number;
    hard_sync?: boolean;
    gain: number;
    active: boolean;
    feedback_amount?: number;
    waveform: number;
    unison_voices?: number;
    spread?: number;
  }): void {
    // Create WASM AnalogOscillatorStateUpdate instance
    const oscUpdate = new AnalogOscillatorStateUpdate(
      state.phase_mod_amount ?? 0,
      state.detune ?? 0,
      state.hard_sync ?? false,
      validateFiniteNumber(state.gain, 'gain'),
      Boolean(state.active),
      state.feedback_amount ?? 0,
      state.waveform as Waveform,
      state.unison_voices ?? 1,
      state.spread ?? 0
    );
    this.requireEngine().update_oscillator(oscillatorId, oscUpdate);
  }

  updateWavetableOscillator(oscillatorId: string, state: {
    phase_mod_amount?: number;
    detune?: number;
    hard_sync?: boolean;
    gain: number;
    active: boolean;
    feedback_amount?: number;
    waveform: number;
    unison_voices?: number;
    spread?: number;
    wave_index?: number;
  }): void {
    // Create WASM WavetableOscillatorStateUpdate instance
    const oscUpdate = new WavetableOscillatorStateUpdate(
      state.phase_mod_amount ?? 0,
      state.detune ?? 0,
      state.hard_sync ?? false,
      validateFiniteNumber(state.gain, 'gain'),
      Boolean(state.active),
      state.feedback_amount ?? 0,
      state.unison_voices ?? 1,
      state.spread ?? 0,
      state.wave_index ?? 0  // wavetable_index parameter
    );
    this.requireEngine().update_wavetable_oscillator(oscillatorId, oscUpdate);
  }

  updateEnvelope(envelopeId: string, config: EnvelopeConfig): void {
    // WASM API takes 8 positional arguments
    this.requireEngine().update_envelope(
      envelopeId,
      validateFiniteNumber(config.attack, 'attack'),
      validateFiniteNumber(config.decay, 'decay'),
      validateFiniteNumber(config.sustain, 'sustain'),
      validateFiniteNumber(config.release, 'release'),
      config.attackCurve ?? 0,
      config.decayCurve ?? 0,
      config.releaseCurve ?? 0,
      Boolean(config.active)
    );
  }

  updateLfos(lfoId: string, params: {
    frequency: number;
    phaseOffset?: number;
    waveform: number;
    useAbsolute?: boolean;
    useNormalized?: boolean;
    triggerMode?: number;
    gain: number;
    active: boolean;
    loopMode?: number;
    loopStart?: number;
    loopEnd?: number;
  }): void {
    // Create WASM WasmLfoUpdateParams instance
    const lfoParams = new WasmLfoUpdateParams(
      lfoId,
      validateFiniteNumber(params.frequency, 'frequency'),
      params.phaseOffset ?? 0,
      params.waveform,
      params.useAbsolute ?? false,
      params.useNormalized ?? false,
      params.triggerMode ?? 0,
      validateFiniteNumber(params.gain, 'gain'),
      Boolean(params.active),
      params.loopMode ?? 0,
      params.loopStart ?? 0,
      params.loopEnd ?? 1
    );
    this.requireEngine().update_lfos(lfoParams);
  }

  updateFilter(_filterId: string, _state: FilterState): void {
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
    // WASM API expects 9 positional parameters
    this.requireEngine().update_sampler(
      samplerId,
      state.frequency ?? 440,
      validateFiniteNumber(state.gain ?? 1, 'gain'),
      state.loopMode ?? 0,
      state.loopStart ?? 0,
      state.loopEnd ?? 1,
      state.rootNote ?? 60,
      state.triggerMode ?? 0,
      Boolean(state.active ?? true)
    );
  }

  updateNoise(noiseId: string, params: {
    noise_type: number;
    cutoff?: number;
    gain: number;
    enabled: boolean;
  }): void {
    // Create WASM NoiseUpdateParams instance
    const noiseParams = new NoiseUpdateParams(
      params.noise_type as WasmNoiseType,
      params.cutoff ?? 20000,
      validateFiniteNumber(params.gain, 'gain'),
      Boolean(params.enabled)
    );
    this.requireEngine().update_noise(noiseId, noiseParams);
  }

  updateChorus(chorusId: string | number, params: {
    base_delay_ms: number;
    depth_ms: number;
    lfo_rate_hz: number;
    feedback: number;
    feedback_filter: number;
    mix: number;
    stereo_phase_offset_deg: number;
    active: boolean;
  }): void {
    // WASM API takes positional arguments
    const nodeId = typeof chorusId === 'string' ? Number(chorusId) : chorusId;
    if (!Number.isFinite(nodeId)) {
      throw new Error(`Invalid chorus node ID: ${chorusId}`);
    }

    this.requireEngine().update_chorus(
      nodeId,
      Boolean(params.active),
      validateFiniteNumber(params.base_delay_ms, 'base_delay_ms'),
      validateFiniteNumber(params.depth_ms, 'depth_ms'),
      validateFiniteNumber(params.lfo_rate_hz, 'lfo_rate_hz'),
      validateFiniteNumber(params.feedback, 'feedback'),
      validateFiniteNumber(params.feedback_filter, 'feedback_filter'),
      validateFiniteNumber(params.mix, 'mix'),
      validateFiniteNumber(params.stereo_phase_offset_deg, 'stereo_phase_offset_deg')
    );
  }

  updateReverb(reverbId: string | number, params: {
    room_size: number;
    damp: number;
    wet: number;
    dry: number;
    width: number;
    active: boolean;
  }): void {
    // WASM API takes positional arguments
    const nodeId = typeof reverbId === 'string' ? Number(reverbId) : reverbId;
    if (!Number.isFinite(nodeId)) {
      throw new Error(`Invalid reverb node ID: ${reverbId}`);
    }

    this.requireEngine().update_reverb(
      nodeId,
      Boolean(params.active),
      validateFiniteNumber(params.room_size, 'room_size'),
      validateFiniteNumber(params.damp, 'damp'),
      validateFiniteNumber(params.wet, 'wet'),
      validateFiniteNumber(params.dry, 'dry'),
      validateFiniteNumber(params.width, 'width')
    );
  }

  updateConvolver(convolverId: string, wetMix: number, active: boolean): void {
    // WASM API expects numeric node ID
    const nodeId = Number(convolverId);
    if (!Number.isFinite(nodeId)) {
      throw new Error(`Invalid convolver node ID: ${convolverId}`);
    }
    this.requireEngine().update_convolver(nodeId, wetMix, active);
  }

  updateDelay(delayId: string | number, params: {
    delay_ms: number;
    feedback: number;
    wet_mix: number;
    active: boolean;
  }): void {
    // WASM API takes positional arguments
    const nodeId = typeof delayId === 'string' ? Number(delayId) : delayId;
    if (!Number.isFinite(nodeId)) {
      throw new Error(`Invalid delay node ID: ${delayId}`);
    }

    this.requireEngine().update_delay(
      nodeId,
      validateFiniteNumber(params.delay_ms, 'delay_ms'),
      validateFiniteNumber(params.feedback, 'feedback'),
      validateFiniteNumber(params.wet_mix, 'wet_mix'),
      Boolean(params.active)
    );
  }

  updateVelocity(nodeId: string, sensitivity: number, randomize: number): void {
    // WASM API expects node_id (string), sensitivity, randomize
    this.requireEngine().update_velocity(nodeId, sensitivity, randomize);
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

  importImpulseResponse(effectId: string | number, audioData: Uint8Array): void {
    // WASM API expects numeric effect ID
    const id = typeof effectId === 'number' ? effectId : Number(effectId);
    if (!Number.isFinite(id)) {
      throw new Error(`Invalid effect ID: ${effectId}`);
    }
    this.requireEngine().import_wave_impulse(id, audioData);
  }

  importWavetable(nodeId: string, audioData: Uint8Array, tableSize: number): void {
    this.requireEngine().import_wavetable(nodeId, audioData, tableSize);
  }

  // ========================================================================
  // Node Management
  // ========================================================================

  deleteNode(nodeId: string): void {
    this.requireEngine().delete_node(nodeId);
  }

  // ========================================================================
  // Performance Monitoring
  // ========================================================================

  getCpuUsage(): number {
    try {
      return this.requireEngine().get_cpu_usage();
    } catch (error) {
      console.warn('[WasmEngineAdapter] Failed to get CPU usage:', error);
      return 0;
    }
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

  getLfoWaveform(waveform: number, phaseOffset: number, frequency: number, bufferSize: number, useAbsolute: boolean, useNormalized: boolean): Float32Array | null {
    try {
      // WASM API expects 6 arguments: waveform, phase_offset, frequency, buffer_size, use_absolute, use_normalized
      const result = this.requireEngine().get_lfo_waveform(waveform, phaseOffset, frequency, bufferSize, useAbsolute, useNormalized);
      return result instanceof Float32Array ? result : null;
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
