// src/audio/instrument-v2.ts
/**
 * Refactored Instrument class using WorkletMessageHandler.
 *
 * IMPORTANT NOTE: This version is designed to work with the CURRENT worklet implementation.
 * Most operations are fire-and-forget because the worklet doesn't send operationResponse yet.
 * Only envelope updates and data exports are Promise-based (worklet supports these).
 *
 * When Phase 2 (worklet migration) is complete, more operations will become Promise-based.
 *
 * This is a drop-in replacement for the original Instrument class.
 */

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
  type VoiceNodeType,
  type LfoState,
  type NodeConnectionUpdate,
  type FilterState,
} from './types/synth-layout';
import { WorkletMessageHandler } from './adapters/message-handler';

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

    // Initialize message handler
    this.messageHandler = new WorkletMessageHandler({
      debug: false,
      defaultTimeout: 5000, // 5 seconds default
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
  // Patch Operations (fire-and-forget - worklet doesn't send response)
  // ========================================================================

  public loadPatch(patch: Patch): void {
    if (!this.workletNode) {
      console.error('[InstrumentV2] Worklet not initialized');
      return;
    }

    try {
      // Strip Vue reactivity and prepare patch for WASM
      const cleanPatch = JSON.parse(
        JSON.stringify(patch, (key, value) => {
          if (value === undefined) return null;
          if (typeof value === 'number' && !Number.isFinite(value)) {
            console.warn(`[loadPatch] Non-finite number at "${key}":`, value);
            return 0;
          }
          return value;
        })
      ) as Patch;

      // Remove audioAssets to reduce JSON size (loaded separately)
      const patchWithoutAssets = {
        ...cleanPatch,
        audioAssets: {},
      };

      const patchJson = JSON.stringify(patchWithoutAssets);
      console.log('[InstrumentV2] Patch JSON length:', patchJson.length);

      // Fire-and-forget - worklet doesn't send operationResponse for loadPatch
      this.messageHandler.sendFireAndForget({
        type: 'loadPatch',
        patchJson,
      });
    } catch (error) {
      console.error('[InstrumentV2] Failed to serialize patch:', error);
    }
  }

  // ========================================================================
  // Node Operations (fire-and-forget for now)
  // ========================================================================

  public deleteNode(nodeId: string): void {
    this.messageHandler.sendFireAndForget({
      type: 'deleteNode',
      nodeId,
    });
  }

  public createNode(node: VoiceNodeType): void {
    this.messageHandler.sendFireAndForget({
      type: 'createNode',
      nodeType: node,
    });
  }

  // ========================================================================
  // Node State Updates (fire-and-forget except envelope)
  // ========================================================================

  public updateReverbState(nodeId: string, state: ReverbState): void {
    this.messageHandler.sendFireAndForget({
      type: 'updateReverb',
      reverbId: nodeId,
      state,
    });
  }

  public updateChorusState(nodeId: string, state: ChorusState): void {
    this.messageHandler.sendFireAndForget({
      type: 'updateChorus',
      chorusId: nodeId,
      state,
    });
  }

  public updateVelocityState(nodeId: string, state: VelocityState): void {
    this.messageHandler.sendFireAndForget({
      type: 'updateVelocity',
      nodeId,
      config: {
        sensitivity: state.sensitivity,
        randomize: state.randomize,
        active: state.active,
      } as VelocityState,
    });
  }

  public updateNoiseState(nodeId: string, state: NoiseState): void {
    this.messageHandler.sendFireAndForget({
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

  public updateSamplerState(nodeId: string, state: SamplerUpdatePayload): void {
    this.messageHandler.sendFireAndForget({
      type: 'updateSampler',
      samplerId: nodeId,
      state,
    });
  }

  public updateWavetableOscillatorState(nodeId: string, newState: OscillatorState): void {
    this.messageHandler.sendFireAndForget({
      type: 'updateWavetableOscillator',
      oscillatorId: nodeId,
      state: newState,
    });
  }

  public updateOscillatorState(nodeId: string, newState: OscillatorState): void {
    this.messageHandler.sendFireAndForget({
      type: 'updateOscillator',
      oscillatorId: nodeId,
      state: newState,
    });
  }

  public updateLfoState(nodeId: string, state: LfoState): void {
    this.messageHandler.sendFireAndForget({
      type: 'updateLfo',
      lfoId: nodeId,
      state,
    });
  }

  public updateFilterState(nodeId: string, newState: FilterState): void {
    this.messageHandler.sendFireAndForget({
      type: 'updateFilter',
      filterId: nodeId,
      state: newState,
    });
  }

  public updateConvolverState(nodeId: string, state: ConvolverState): void {
    this.messageHandler.sendFireAndForget({
      type: 'updateConvolver',
      convolverId: nodeId,
      state,
    });
  }

  public updateDelayState(nodeId: string, state: DelayState): void {
    this.messageHandler.sendFireAndForget({
      type: 'updateDelay',
      delayId: nodeId,
      state,
    });
  }

  // PROMISE-BASED: Envelope updates - worklet sends updateEnvelopeProcessed
  public updateEnvelopeState(nodeId: string, newState: EnvelopeConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.workletNode) {
        resolve(); // Fail silently like original
        return;
      }

      const messageId = `${Date.now()}_${Math.random()}`;

      const listener = (event: MessageEvent) => {
        const data = event.data;
        if (data && data.type === 'updateEnvelopeProcessed' && data.messageId === messageId) {
          this.workletNode?.port.removeEventListener('message', listener);
          resolve();
        }
      };

      this.workletNode.port.addEventListener('message', listener);

      setTimeout(() => {
        this.workletNode?.port.removeEventListener('message', listener);
        reject(new Error('Timeout waiting for envelope update confirmation'));
      }, 2000);

      this.workletNode.port.postMessage({
        type: 'updateEnvelope',
        envelopeId: nodeId,
        config: newState,
        messageId: messageId,
      });
    });
  }

  // ========================================================================
  // Connection Operations (fire-and-forget)
  // ========================================================================

  public updateConnection(connection: NodeConnectionUpdate): void {
    this.messageHandler.sendFireAndForget({
      type: 'updateConnection',
      connection,
    });
  }

  public remove_specific_connection(from_node: string, to_node: string, to_port: number): void {
    this.messageHandler.sendFireAndForget({
      type: 'removeConnection',
      fromId: from_node,
      toId: to_node,
      targetPort: to_port,
    });
  }

  // ========================================================================
  // Arpeggiator Operations (fire-and-forget)
  // ========================================================================

  public updateArpeggiatorPattern(
    nodeId: string,
    pattern: { value: number; active: boolean }[]
  ): void {
    // Extract just the values for the pattern
    const numericPattern = pattern.map(p => p.value);
    this.messageHandler.sendFireAndForget({
      type: 'updateArpeggiatorPattern',
      pattern: numericPattern,
    });
  }

  public updateArpeggiatorStepDuration(nodeId: string, stepDurationMs: number): void {
    this.messageHandler.sendFireAndForget({
      type: 'updateArpeggiatorStepDuration',
      stepDuration: stepDurationMs,
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
    this.messageHandler.sendFireAndForget({
      type: 'importWavetable',
      nodeId,
      data: wavData,
      tableSize: wavData.length,
    });
  }

  public importImpulseWaveformData(nodeId: string, wavData: Uint8Array): void {
    this.messageHandler.sendFireAndForget({
      type: 'importImpulseWaveform',
      nodeId,
      data: wavData,
    });
  }

  public importSampleData(nodeId: string, wavData: Uint8Array): void {
    if (!this.workletNode) return;
    this.workletNode.port.postMessage(
      {
        type: 'importSample',
        nodeId,
        data: wavData.buffer,
      },
      [wavData.buffer]
    );
  }

  // ========================================================================
  // Data Export (Promise-based - worklet sends responses)
  // ========================================================================

  public async getSamplerWaveform(nodeId: string, maxLength = 512): Promise<Float32Array> {
    if (!this.workletNode) {
      throw new Error('Audio system not ready');
    }
    const port = this.workletNode.port;

    return new Promise<Float32Array>((resolve, reject) => {
      const messageId = `sampler-waveform-${nodeId}-${performance.now()}`;
      const handleMessage = (event: MessageEvent) => {
        if (event.data.type === 'samplerWaveform' && event.data.messageId === messageId) {
          port.removeEventListener('message', handleMessage);
          resolve(new Float32Array(event.data.waveform));
        } else if (event.data.type === 'error' && event.data.messageId === messageId) {
          port.removeEventListener('message', handleMessage);
          reject(new Error(event.data.message ?? 'Failed to fetch sampler waveform'));
        }
      };

      port.addEventListener('message', handleMessage);

      port.postMessage({
        type: 'getSamplerWaveform',
        samplerId: nodeId,
        maxLength,
        messageId,
      });

      setTimeout(() => {
        port.removeEventListener('message', handleMessage);
        reject(new Error('Timeout retrieving sampler waveform'));
      }, 2000);
    });
  }

  // FIXED: Use correct message type 'exportSampleData' not 'exportSamplerData'
  public async exportSamplerData(nodeId: string): Promise<{
    samples: Float32Array;
    sampleRate: number;
    channels: number;
    rootNote: number;
  }> {
    if (!this.workletNode) {
      throw new Error('Audio system not ready');
    }
    const port = this.workletNode.port;

    return new Promise((resolve, reject) => {
      const messageId = `export-sample-${nodeId}-${performance.now()}`;
      const handleMessage = (event: MessageEvent) => {
        if (event.data.type === 'sampleData' && event.data.messageId === messageId) {
          port.removeEventListener('message', handleMessage);
          const data = event.data.sampleData;
          resolve({
            samples: new Float32Array(data.samples),
            sampleRate: data.sampleRate,
            channels: data.channels,
            rootNote: data.rootNote,
          });
        } else if (event.data.type === 'error' && event.data.messageId === messageId) {
          port.removeEventListener('message', handleMessage);
          reject(new Error(event.data.message ?? 'Failed to export sample data'));
        }
      };

      port.addEventListener('message', handleMessage);

      // FIXED: Use 'exportSampleData' to match worklet expectations
      port.postMessage({
        type: 'exportSampleData',
        samplerId: nodeId,
        messageId,
      });

      setTimeout(() => {
        port.removeEventListener('message', handleMessage);
        reject(new Error('Timeout exporting sample data'));
      }, 2000);
    });
  }

  public async exportConvolverData(nodeId: string): Promise<{
    samples: Float32Array;
    sampleRate: number;
    channels: number;
  }> {
    if (!this.workletNode) {
      throw new Error('Audio system not ready');
    }
    const port = this.workletNode.port;

    return new Promise((resolve, reject) => {
      const messageId = `export-convolver-${nodeId}-${performance.now()}`;
      const handleMessage = (event: MessageEvent) => {
        if (event.data.type === 'convolverData' && event.data.messageId === messageId) {
          port.removeEventListener('message', handleMessage);
          const data = event.data.convolverData;
          resolve({
            samples: new Float32Array(data.samples),
            sampleRate: data.sampleRate,
            channels: data.channels,
          });
        } else if (event.data.type === 'error' && event.data.messageId === messageId) {
          port.removeEventListener('message', handleMessage);
          reject(new Error(event.data.message ?? 'Failed to export convolver data'));
        }
      };

      port.addEventListener('message', handleMessage);

      port.postMessage({
        type: 'exportConvolverData',
        convolverId: nodeId,
        messageId,
      });

      setTimeout(() => {
        port.removeEventListener('message', handleMessage);
        reject(new Error('Timeout exporting convolver data'));
      }, 2000);
    });
  }

  public async getFilterIRWaveform(nodeId: string, maxLength = 512): Promise<Float32Array> {
    if (!this.workletNode) {
      throw new Error('Audio system not ready');
    }
    const port = this.workletNode.port;

    return new Promise<Float32Array>((resolve, reject) => {
      const handleMessage = (e: MessageEvent) => {
        if (e.data.type === 'FilterIrWaveform') {
          port.removeEventListener('message', handleMessage);
          resolve(new Float32Array(e.data.waveform));
        } else if (e.data.type === 'error' && e.data.source === 'getFilterIRWaveform') {
          port.removeEventListener('message', handleMessage);
          reject(new Error(e.data.message));
        }
      };

      port.addEventListener('message', handleMessage);

      port.postMessage({
        type: 'getFilterIRWaveform',
        node_id: nodeId,
        length: maxLength,
      });

      setTimeout(() => {
        port.removeEventListener('message', handleMessage);
        reject(new Error('Timeout waiting for waveform data'));
      }, 5000);
    });
  }

  public async getLfoWaveform(
    waveform: number,
    phaseOffset: number,
    frequency: number,
    bufferSize: number,
    use_absolute: boolean,
    use_normalized: boolean,
  ): Promise<Float32Array> {
    if (!this.workletNode) {
      throw new Error('Audio system not ready');
    }

    return new Promise<Float32Array>((resolve, reject) => {
      const handleMessage = (e: MessageEvent) => {
        if (e.data.type === 'lfoWaveform') {
          this.workletNode?.port.removeEventListener('message', handleMessage);
          resolve(new Float32Array(e.data.waveform));
        } else if (e.data.type === 'error' && e.data.source === 'getLfoWaveform') {
          this.workletNode?.port.removeEventListener('message', handleMessage);
          reject(new Error(e.data.message));
        }
      };

      if (!this.workletNode) {
        reject(new Error('Worklet node not initialized'));
        return;
      }

      this.workletNode.port.addEventListener('message', handleMessage);

      this.workletNode.port.postMessage({
        type: 'getLfoWaveform',
        waveform,
        phaseOffset,
        frequency,
        bufferSize,
        use_absolute,
        use_normalized,
      });

      setTimeout(() => {
        this.workletNode?.port.removeEventListener('message', handleMessage);
        reject(new Error('Timeout waiting for waveform data'));
      }, 5000);
    });
  }

  public async getWasmNodeConnections(): Promise<string> {
    if (!this.workletNode) {
      throw new Error('Audio system not ready');
    }

    return new Promise<string>((resolve, reject) => {
      const messageId = Date.now().toString();
      let timeoutId = setTimeout(() => {}, 0);

      const handleMessage = (e: MessageEvent) => {
        if (e.data.type === 'nodeLayout' && e.data.messageId === messageId) {
          this.workletNode?.port.removeEventListener('message', handleMessage);
          clearTimeout(timeoutId);
          resolve(e.data.layout);
        } else if (e.data.type === 'error' && e.data.messageId === messageId) {
          this.workletNode?.port.removeEventListener('message', handleMessage);
          clearTimeout(timeoutId);
          reject(new Error(e.data.message));
        }
      };

      if (!this.workletNode) {
        clearTimeout(timeoutId);
        reject(new Error('Worklet node not initialized'));
        return;
      }

      this.workletNode.port.addEventListener('message', handleMessage);

      this.workletNode.port.postMessage({
        type: 'getNodeLayout',
        messageId: messageId,
      });

      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        this.workletNode?.port.removeEventListener('message', handleMessage);
        reject(new Error('Timeout waiting for node layout data'));
      }, 5000);
    });
  }

  public async getEnvelopePreview(
    config: EnvelopeConfig,
    previewDuration: number,
  ): Promise<Float32Array> {
    if (!this.workletNode) {
      throw new Error('Audio system not ready');
    }

    return new Promise<Float32Array>((resolve, reject) => {
      const handleMessage = (e: MessageEvent) => {
        if (e.data.type === 'envelopePreview' && e.data.source === 'getEnvelopePreview') {
          this.workletNode?.port.removeEventListener('message', handleMessage);
          resolve(new Float32Array(e.data.preview));
        } else if (e.data.type === 'error' && e.data.source === 'getEnvelopePreview') {
          this.workletNode?.port.removeEventListener('message', handleMessage);
          reject(new Error(e.data.message));
        }
      };

      if (!this.workletNode) {
        reject(new Error('Worklet node not initialized'));
        return;
      }

      this.workletNode.port.addEventListener('message', handleMessage);

      this.workletNode.port.postMessage({
        type: 'getEnvelopePreview',
        config: JSON.parse(JSON.stringify(config)),
        previewDuration,
      });

      setTimeout(() => {
        this.workletNode?.port.removeEventListener('message', handleMessage);
        reject(new Error('Timeout waiting for envelope preview'));
      }, 1000);
    });
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
    let oldestTime = this.voiceLastUsedTime[0] ?? 0;

    for (let i = 1; i < this.num_voices; i++) {
      const time = this.voiceLastUsedTime[i] ?? 0;
      if (time < oldestTime) {
        oldestTime = time;
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
