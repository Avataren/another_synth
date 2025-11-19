// src/audio/instrument-v2.ts
/**
 * Refactored Instrument class using WorkletMessageHandler.
 *
 * This version replaces the original Instrument class with:
 * - Promise-based operations (no more fire-and-forget)
 * - WorkletMessageHandler for all message passing
 * - No duplicate state storage
 * - Comprehensive error handling
 * - Proper async/await patterns
 *
 * This is a drop-in replacement for the original Instrument class.
 */

import { type Wavetable } from 'src/components/WaveTable/WavetableUtils';
import { createStandardAudioWorklet } from './audio-processor-loader';
import type OscillatorState from './models/OscillatorState';
import { type NoiseState, type NoiseUpdate } from './types/noise';
import type { Patch } from './types/preset-types';
import type {
  ChorusState,
  ConvolverState,
  DelayState,
  EnvelopeConfig,
  ReverbState,
  SamplerLoopMode,
  SamplerTriggerMode,
  VelocityState,
} from './types/synth-layout';
import {
  type SynthLayout,
  VoiceNodeType,
  type LfoState,
  type NodeConnectionUpdate,
  type FilterState,
} from './types/synth-layout';
import { WorkletMessageHandler } from './adapters/message-handler';
import { WorkletMessageBuilder } from './types/worklet-messages';

interface SamplerUpdatePayload {
  frequency: number;
  gain: number;
  loopMode: SamplerLoopMode;
  loopStart: number;
  loopEnd: number;
  rootNote: number;
  triggerMode: SamplerTriggerMode;
  active: boolean;
}

export default class InstrumentV2 {
  readonly num_voices = 8;
  outputNode: AudioNode;
  workletNode: AudioWorkletNode | null = null;
  private activeNotes: Map<number, number> = new Map();
  private voiceLastUsedTime: number[] = [];
  private messageHandler: WorkletMessageHandler;

  public get isReady(): boolean {
    return this.messageHandler.isInitialized();
  }

  constructor(
    destination: AudioNode,
    private audioContext: AudioContext,
    memory: WebAssembly.Memory,
  ) {
    this.outputNode = audioContext.createGain();
    (this.outputNode as GainNode).gain.value = 0.5;
    this.outputNode.connect(destination);
    this.voiceLastUsedTime = new Array(this.num_voices).fill(0);

    // Initialize message handler with debug logging
    this.messageHandler = new WorkletMessageHandler({
      debug: false, // Set to true for debugging
      defaultTimeout: 10000, // 10 seconds for large operations like patch loading
      maxQueueSize: 200,
    });

    this.setupAudio(memory);
  }

  private async setupAudio(_memory: WebAssembly.Memory) {
    try {
      this.workletNode = await createStandardAudioWorklet(this.audioContext);

      // Attach message handler to worklet
      this.messageHandler.attachToWorklet(this.workletNode);

      // Set up parameters for each voice
      for (let i = 0; i < this.num_voices; i++) {
        const gateParam = this.workletNode.parameters.get(`gate_${i}`);
        if (gateParam) gateParam.value = 0;

        const freqParam = this.workletNode.parameters.get(`frequency_${i}`);
        if (freqParam) freqParam.value = 440;

        const gainParam = this.workletNode.parameters.get(`gain_${i}`);
        if (gainParam) gainParam.value = 1;
      }

      this.workletNode.connect(this.outputNode);
      console.log('[InstrumentV2] Audio setup completed successfully');
    } catch (error) {
      console.error('[InstrumentV2] Failed to set up audio:', error);
      throw error;
    }
  }

  // ========================================================================
  // Patch Operations
  // ========================================================================

  public async loadPatch(patch: Patch): Promise<void> {
    try {
      // CRITICAL: Strip Vue reactivity by doing a deep clone
      const cleanPatch = JSON.parse(JSON.stringify(patch, (key, value) => {
        if (value === undefined) return null;
        return value;
      })) as Patch;

      // CRITICAL: Remove audioAssets to reduce JSON size
      const patchWithoutAssets = {
        ...cleanPatch,
        audioAssets: {},
      };

      // Check for NaN/Infinity/undefined before stringifying
      const patchJson = JSON.stringify(patchWithoutAssets, (key, value) => {
        if (value === undefined) {
          console.warn(`[loadPatch] Found undefined at key "${key}", using null`);
          return null;
        }
        if (typeof value === 'number' && !Number.isFinite(value)) {
          console.warn(`[loadPatch] Found non-finite number at key "${key}":`, value);
          return 0;
        }
        return value;
      });

      // Verify JSON is valid
      JSON.parse(patchJson);

      console.log('[InstrumentV2] Loading patch, JSON length:', patchJson.length);

      // Use message handler with extended timeout for large patches
      await this.messageHandler.sendMessage(
        WorkletMessageBuilder.loadPatch(patchJson),
        30000 // 30 second timeout for large patches
      );

      console.log('[InstrumentV2] Patch loaded successfully');
    } catch (error) {
      console.error('[InstrumentV2] Failed to load patch:', error);
      throw new Error(`Failed to load patch: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ========================================================================
  // Node Operations (now all return Promises)
  // ========================================================================

  public async deleteNode(nodeId: string): Promise<void> {
    await this.messageHandler.sendMessage(
      WorkletMessageBuilder.deleteNode(nodeId)
    );
  }

  public async createNode(node: VoiceNodeType): Promise<{ nodeId: string; nodeType: string }> {
    return await this.messageHandler.sendMessage(
      WorkletMessageBuilder.createNode(node)
    );
  }

  // ========================================================================
  // Node State Updates (all now return Promises)
  // ========================================================================

  public async updateReverbState(nodeId: string, state: ReverbState): Promise<void> {
    await this.messageHandler.sendMessage(
      {
        type: 'updateReverb',
        messageId: this.messageHandler['generateMessageId']?.() || `${Date.now()}_${Math.random()}`,
        reverbId: nodeId,
        state,
      }
    );
  }

  public async updateChorusState(nodeId: string, state: ChorusState): Promise<void> {
    await this.messageHandler.sendMessage({
      type: 'updateChorus',
      messageId: this.messageHandler['generateMessageId']?.() || `${Date.now()}_${Math.random()}`,
      chorusId: nodeId,
      state,
    });
  }

  public async updateVelocityState(nodeId: string, state: VelocityState): Promise<void> {
    await this.messageHandler.sendMessage({
      type: 'updateVelocity',
      nodeId,
      config: {
        sensitivity: state.sensitivity,
        randomize: state.randomize,
        active: state.active,
      } as VelocityState,
    });
  }

  public async updateNoiseState(nodeId: string, state: NoiseState): Promise<void> {
    await this.messageHandler.sendMessage({
      type: 'updateNoise',
      noiseId: nodeId,
      config: {
        noise_type: state.noiseType,
        cutoff: state.cutoff,
        gain: state.gain || 1.0,
        enabled: state.is_enabled,
      } as NoiseUpdate,
    });
  }

  public async updateSamplerState(nodeId: string, state: SamplerUpdatePayload): Promise<void> {
    await this.messageHandler.sendMessage({
      type: 'updateSampler',
      samplerId: nodeId,
      state,
    });
  }

  public async updateEnvelopeState(nodeId: string, newState: EnvelopeConfig): Promise<void> {
    await this.messageHandler.sendMessage(
      {
        type: 'updateEnvelope',
        envelopeId: nodeId,
        state: newState,
      }
    );
  }

  public async updateLfoState(nodeId: string, state: LfoState): Promise<void> {
    await this.messageHandler.sendMessage({
      type: 'updateLfo',
      lfoId: nodeId,
      state,
    });
  }

  public async updateFilterState(nodeId: string, config: FilterState): Promise<void> {
    await this.messageHandler.sendMessage({
      type: 'updateFilter',
      filterId: nodeId,
      state: config,
    });
  }

  public async updateOscillatorState(nodeId: string, newState: OscillatorState): Promise<void> {
    await this.messageHandler.sendMessage({
      type: 'updateOscillator',
      oscillatorId: nodeId,
      state: newState,
    });
  }

  public async updateWavetableOscillatorState(nodeId: string, newState: OscillatorState): Promise<void> {
    await this.messageHandler.sendMessage({
      type: 'updateWavetableOscillator',
      oscillatorId: nodeId,
      state: newState,
    });
  }

  public async updateConvolverState(nodeId: string, state: ConvolverState): Promise<void> {
    await this.messageHandler.sendMessage({
      type: 'updateConvolver',
      convolverId: nodeId,
      state,
    });
  }

  public async updateDelayState(nodeId: string, state: DelayState): Promise<void> {
    await this.messageHandler.sendMessage({
      type: 'updateDelay',
      delayId: nodeId,
      state,
    });
  }

  // ========================================================================
  // Connection Operations
  // ========================================================================

  public async updateConnection(connection: NodeConnectionUpdate): Promise<void> {
    await this.messageHandler.sendMessage(
      WorkletMessageBuilder.updateConnection(connection)
    );
  }

  public remove_specific_connection(from_node: string, to_node: string, to_port: number): void {
    this.messageHandler.sendFireAndForget({
      type: 'removeConnection',
      fromNode: from_node,
      toNode: to_node,
      toPort: to_port,
    });
  }

  // ========================================================================
  // Arpeggiator Operations (fire-and-forget)
  // ========================================================================

  public updateArpeggiatorPattern(
    nodeId: string,
    pattern: { value: number; active: boolean }[]
  ): void {
    this.messageHandler.sendFireAndForget({
      type: 'updateArpeggiatorPattern',
      nodeId,
      pattern,
    });
  }

  public updateArpeggiatorStepDuration(nodeId: string, stepDurationMs: number): void {
    this.messageHandler.sendFireAndForget({
      type: 'updateArpeggiatorStepDuration',
      nodeId,
      stepDurationMs,
    });
  }

  // ========================================================================
  // Wavetable Operations (no-op for compatibility)
  // ========================================================================

  public updateWavetable(_nodeId: string, _newWavetable: unknown): void {
    // No-op: Wavetable updates are handled via importWavetableData
    console.log('[InstrumentV2] updateWavetable is deprecated, use importWavetableData instead');
  }

  // ========================================================================
  // Layout Operations (no-op for compatibility)
  // ========================================================================

  public updateLayout(_layout: unknown): void {
    // No-op: InstrumentV2 doesn't store layout locally (WASM is the single source of truth)
    // This method exists for backward compatibility only
  }

  // ========================================================================
  // Asset Import (fire-and-forget for large transfers)
  // ========================================================================

  public importWavetableData(nodeId: string, wavData: Uint8Array): void {
    // Asset imports don't need confirmation - they're fire-and-forget
    this.messageHandler.sendFireAndForget({
      type: 'importWavetable',
      nodeId,
      data: wavData.buffer,
    });
    console.log('[InstrumentV2] Sent wavetable data to worklet');
  }

  public importImpulseWaveformData(nodeId: string, wavData: Uint8Array): void {
    this.messageHandler.sendFireAndForget({
      type: 'importImpulseWaveform',
      nodeId,
      data: wavData.buffer,
    });
    console.log('[InstrumentV2] Sent impulse response data to worklet');
  }

  public importSampleData(nodeId: string, wavData: Uint8Array): void {
    this.messageHandler.sendFireAndForget({
      type: 'importSample',
      nodeId,
      data: wavData.buffer,
    });
    console.log('[InstrumentV2] Sent sample data to worklet');
  }

  // ========================================================================
  // Data Export (already Promise-based, now cleaner)
  // ========================================================================

  public async getSamplerWaveform(nodeId: string, maxLength = 512): Promise<Float32Array> {
    const response = await this.messageHandler.sendMessage<{ waveform: Float32Array }>({
      type: 'getSamplerWaveform',
      samplerId: nodeId,
      maxLength,
    });

    if (!response || !(response.waveform instanceof Float32Array)) {
      throw new Error('Invalid waveform response from worklet');
    }

    return response.waveform;
  }

  public async exportSamplerData(nodeId: string): Promise<{
    samples: Float32Array;
    sampleRate: number;
    channels: number;
    rootNote: number;
  }> {
    const response = await this.messageHandler.sendMessage<{
      samples: Float32Array;
      sampleRate: number;
      channels: number;
      rootNote: number;
    }>({
      type: 'exportSamplerData',
      samplerId: nodeId,
    });

    if (!response || !(response.samples instanceof Float32Array)) {
      throw new Error('Invalid sample data response from worklet');
    }

    return response;
  }

  public async exportConvolverData(nodeId: string): Promise<{
    samples: Float32Array;
    sampleRate: number;
    channels: number;
  }> {
    const response = await this.messageHandler.sendMessage<{
      samples: Float32Array;
      sampleRate: number;
      channels: number;
    }>({
      type: 'exportConvolverData',
      convolverId: nodeId,
    });

    if (!response || !(response.samples instanceof Float32Array)) {
      throw new Error('Invalid convolver data response from worklet');
    }

    return response;
  }

  public async getFilterIRWaveform(nodeId: string, maxLength = 512): Promise<Float32Array> {
    const response = await this.messageHandler.sendMessage<{ waveform: Float32Array }>({
      type: 'getFilterIRWaveform',
      filterId: nodeId,
      maxLength,
    });

    if (!response || !(response.waveform instanceof Float32Array)) {
      throw new Error('Invalid filter IR response from worklet');
    }

    return response.waveform;
  }

  public async getLfoWaveform(
    waveform: number,
    phaseOffset: number,
    frequency: number,
    bufferSize: number,
    use_absolute: boolean,
    use_normalized: boolean,
  ): Promise<Float32Array> {
    const response = await this.messageHandler.sendMessage<{ waveform: Float32Array }>({
      type: 'getLfoWaveform',
      waveform,
      phaseOffset,
      frequency,
      bufferSize,
      use_absolute,
      use_normalized,
    });

    if (!response || !(response.waveform instanceof Float32Array)) {
      throw new Error('Invalid LFO waveform response from worklet');
    }

    return response.waveform;
  }

  public async getWasmNodeConnections(): Promise<string> {
    const response = await this.messageHandler.sendMessage<{ layout: string }>({
      type: 'getNodeLayout',
    }, 5000);

    if (!response || typeof response.layout !== 'string') {
      throw new Error('Invalid node layout response from worklet');
    }

    return response.layout;
  }

  public async getEnvelopePreview(
    config: EnvelopeConfig,
    previewDuration: number,
  ): Promise<Float32Array> {
    const response = await this.messageHandler.sendMessage<{ preview: Float32Array }>({
      type: 'getEnvelopePreview',
      config: JSON.parse(JSON.stringify(config)),
      previewDuration,
    }, 1000);

    if (!response || !(response.preview instanceof Float32Array)) {
      throw new Error('Invalid envelope preview response from worklet');
    }

    return response.preview;
  }

  public async getFilterResponse(node_id: string, length: number): Promise<Float32Array> {
    return this.getFilterIRWaveform(node_id, length);
  }

  // ========================================================================
  // MIDI / Performance (fire-and-forget for low latency)
  // ========================================================================

  public noteOn(noteNumber: number, velocity: number): void {
    const voiceIndex = this.allocateVoice(noteNumber);
    this.activeNotes.set(noteNumber, voiceIndex);
    this.voiceLastUsedTime[voiceIndex] = Date.now();

    const frequency = this.midiNoteToFrequency(noteNumber);

    if (!this.workletNode) return;

    // Set gate, frequency, and velocity parameters
    const gateParam = this.workletNode.parameters.get(`gate_${voiceIndex}`);
    if (gateParam) gateParam.value = 1;

    const freqParam = this.workletNode.parameters.get(`frequency_${voiceIndex}`);
    if (freqParam) freqParam.value = frequency;

    const gainParam = this.workletNode.parameters.get(`gain_${voiceIndex}`);
    if (gainParam) gainParam.value = velocity / 127;
  }

  public noteOff(noteNumber: number): void {
    const voiceIndex = this.activeNotes.get(noteNumber);
    if (voiceIndex === undefined) return;

    this.activeNotes.delete(noteNumber);

    if (!this.workletNode) return;

    const gateParam = this.workletNode.parameters.get(`gate_${voiceIndex}`);
    if (gateParam) gateParam.value = 0;
  }

  public allNotesOff(): void {
    for (const noteNumber of this.activeNotes.keys()) {
      this.noteOff(noteNumber);
    }
  }

  // Compatibility aliases for old naming convention
  public note_on(midi_note: number, velocity: number): void {
    this.noteOn(midi_note, velocity);
  }

  public note_off(midi_note: number): void {
    this.noteOff(midi_note);
  }

  // ========================================================================
  // Voice Allocation
  // ========================================================================

  private allocateVoice(noteNumber: number): number {
    // Check if this note is already playing
    const existingVoice = this.activeNotes.get(noteNumber);
    if (existingVoice !== undefined) {
      return existingVoice;
    }

    // Find first free voice
    for (let i = 0; i < this.num_voices; i++) {
      if (!Array.from(this.activeNotes.values()).includes(i)) {
        return i;
      }
    }

    // No free voice - steal the oldest one
    let oldestVoice = 0;
    let oldestTime = this.voiceLastUsedTime[0];

    for (let i = 1; i < this.num_voices; i++) {
      if (this.voiceLastUsedTime[i] < oldestTime) {
        oldestTime = this.voiceLastUsedTime[i];
        oldestVoice = i;
      }
    }

    // Remove the stolen voice from activeNotes
    for (const [note, voice] of this.activeNotes.entries()) {
      if (voice === oldestVoice) {
        this.activeNotes.delete(note);
        break;
      }
    }

    return oldestVoice;
  }

  private midiNoteToFrequency(note: number): number {
    return 440 * Math.pow(2, (note - 69) / 12);
  }

  // ========================================================================
  // Cleanup
  // ========================================================================

  public dispose(): void {
    this.allNotesOff();
    this.messageHandler.clear();
    this.messageHandler.detach();

    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }

    this.outputNode.disconnect();
  }
}
