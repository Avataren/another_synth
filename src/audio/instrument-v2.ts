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
  CompressorState,
  SaturationState,
  BitcrusherState,
  ReverbState,
  SamplerLoopMode,
  SamplerTriggerMode,
  VelocityState,
  GlideState,
} from './types/synth-layout';
import {
  type VoiceNodeType,
  type LfoState,
  type NodeConnectionUpdate,
  type FilterState,
} from './types/synth-layout';
import type { PortId, WasmModulationType, ModulationTransformation } from 'app/public/wasm/audio_processor';
import { WorkletMessageHandler } from './adapters/message-handler';
import { toRaw } from 'vue';

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
  private activeNotes: Map<number, Set<number>> = new Map();
  private voiceToNote: (number | null)[] = [];
  private voiceRoundRobinIndex = 0;
  private voiceLastUsedTime: number[] = [];
  private messageHandler: WorkletMessageHandler;
  private voiceLimit: number;
  private glideStates: Map<string, GlideState> = new Map();
  private quantumFrames = 128;

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
    this.voiceLimit = this.num_voices;
    this.voiceToNote = new Array(this.num_voices).fill(null);
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

      // Listen for broadcast messages (e.g., worklet block size)
      this.workletNode.port.addEventListener('message', (event: MessageEvent) => {
        const data = event.data as { type?: string; blockSize?: unknown };
        if (data?.type === 'blockSize') {
          const frames = Number(data.blockSize);
          if (Number.isFinite(frames) && frames > 0) {
            this.quantumFrames = frames;
          }
        }
      });

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
    } catch (error) {
      console.error('[InstrumentV2] Failed to set up audio:', error);
      throw error;
    }
  }

  // ========================================================================
  // Patch Operations
  // ========================================================================

  public async loadPatch(patch: Patch): Promise<void> {
    if (!this.workletNode) {
      console.error('[InstrumentV2] Worklet not initialized');
      return;
    }

    try {
      this.refreshGlideStatesFromPatch(patch);

      // Track voice limit from patch layout (clamped to available params)
      const patchLayout = patch.synthState?.layout as
        | { voiceCount?: number; voices?: unknown[] }
        | undefined;
      const patchVoiceCount =
        patchLayout?.voiceCount ?? patchLayout?.voices?.length ?? this.num_voices;
      this.voiceLimit = Math.min(
        this.num_voices,
        Math.max(1, Number(patchVoiceCount) || this.num_voices),
      );

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

      // Set up a one-time listener for synthLayout response before sending the message
      const workletNode = this.workletNode; // Capture for closure
      await new Promise<void>((resolve, _reject) => {
        const timeoutMs = 5000;
        let cleanedUp = false;

        const handleSynthLayout = (event: MessageEvent) => {
          if (event.data.type === 'synthLayout') {
            cleanup();
            resolve();
          }
        };

        const handleTimeout = () => {
          cleanup();
          resolve(); // Continue rather than blocking initialization
        };

        const cleanup = () => {
          if (cleanedUp) return;
          cleanedUp = true;
          clearTimeout(timeoutHandle);
          workletNode.port.removeEventListener('message', handleSynthLayout);
        };

        const timeoutHandle = setTimeout(handleTimeout, timeoutMs);

        // Add listener BEFORE sending message to avoid race condition
        workletNode.port.addEventListener('message', handleSynthLayout);

        // Now send the loadPatch message
        this.messageHandler.sendFireAndForget({
          type: 'loadPatch',
          patchJson,
        });
      });
    } catch (error) {
      console.error('[InstrumentV2] Failed to load patch:', error);
      throw error;
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

  public setMacro(macroIndex: number, value: number, time?: number): void {
    if (!this.workletNode) {
      return;
    }

    const clampedValue = Math.min(1, Math.max(0, value));
    const when = typeof time === 'number' ? time : this.audioContext.currentTime;
    for (let voice = 0; voice < this.num_voices; voice++) {
      const param = this.workletNode.parameters.get(`macro_${voice}_${macroIndex}`);
      if (param) {
        param.setValueAtTime(clampedValue, when);
      }
    }
  }

  public connectMacroRoute(payload: { macroIndex: number; targetId: string; targetPort: PortId; amount: number; modulationType: WasmModulationType; modulationTransformation: ModulationTransformation }): void {
    if (!this.workletNode) {
      return;
    }
    this.messageHandler.sendFireAndForget({
      type: 'connectMacro',
      macroIndex: payload.macroIndex,
      targetId: payload.targetId,
      targetPort: payload.targetPort,
      amount: payload.amount,
      modulationType: payload.modulationType,
      modulationTransformation: payload.modulationTransformation,
    });
  }

  // ========================================================================
  // Node State Updates (fire-and-forget except envelope)
  // ========================================================================

  public updateReverbState(nodeId: string, state: ReverbState): void {
    this.messageHandler.sendFireAndForget({
      type: 'updateReverb',
      nodeId,
      state,
    });
  }

  public updateCompressorState(nodeId: string, state: CompressorState): void {
    this.messageHandler.sendFireAndForget({
      type: 'updateCompressor',
      nodeId,
      state,
    });
  }

  public updateSaturationState(nodeId: string, state: SaturationState): void {
    this.messageHandler.sendFireAndForget({
      type: 'updateSaturation',
      nodeId,
      state,
    });
  }

  public updateBitcrusherState(nodeId: string, state: BitcrusherState): void {
    this.messageHandler.sendFireAndForget({
      type: 'updateBitcrusher',
      nodeId,
      state,
    });
  }

  public updateChorusState(nodeId: string, state: ChorusState): void {
    this.messageHandler.sendFireAndForget({
      type: 'updateChorus',
      nodeId,
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

  public updateGlideState(nodeId: string, state: GlideState): void {
    const glideState = {
      ...state,
      id: state.id ?? nodeId,
      time: state.time ?? 0,
      active: !!state.active,
    };
    this.glideStates.set(nodeId, glideState);

    this.messageHandler.sendFireAndForget({
      type: 'updateGlide',
      glideId: nodeId,
      time: glideState.time,
      active: glideState.active,
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
      newState,
    });
  }

  public updateOscillatorState(nodeId: string, newState: OscillatorState): void {
    this.messageHandler.sendFireAndForget({
      type: 'updateOscillator',
      oscillatorId: nodeId,
      newState,
    });
  }

  public updateLfoState(nodeId: string, state: LfoState): void {
    const params = {
      lfoId: nodeId,
      frequency: state.frequency,
      phaseOffset: state.phaseOffset ?? 0,
      waveform: state.waveform,
      useAbsolute: state.useAbsolute,
      useNormalized: state.useNormalized,
      triggerMode: state.triggerMode,
      gain: state.gain,
      active: state.active,
      loopMode: state.loopMode,
      loopStart: state.loopStart,
      loopEnd: state.loopEnd,
    };

    this.messageHandler.sendFireAndForget({
      type: 'updateLfo',
      lfoId: nodeId,
      params,
    });
  }

  public updateFilterState(nodeId: string, newState: FilterState): void {
    this.messageHandler.sendFireAndForget({
      type: 'updateFilter',
      filterId: nodeId,
      config: newState,
    });
  }

  public updateConvolverState(nodeId: string, state: ConvolverState): void {
    const plainState = JSON.parse(
      JSON.stringify({
        id: nodeId,
        ...toRaw(state),
      }),
    ) as ConvolverState;

    this.messageHandler.sendFireAndForget({
      type: 'updateConvolver',
      nodeId,
      state: plainState,
    });
  }

  public updateDelayState(nodeId: string, state: DelayState): void {
    this.messageHandler.sendFireAndForget({
      type: 'updateDelay',
      nodeId,
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

  public async importWavetableData(nodeId: string, wavData: Uint8Array): Promise<void> {
    this.messageHandler.sendFireAndForget({
      type: 'importWavetable',
      nodeId,
      data: wavData,
      tableSize: wavData.length,
    });
    // Wavetable import is fire-and-forget (no WASM response), so we add a small delay
    // to ensure the message is processed before continuing. This prevents race conditions
    // where patches are played before their wavetable data is fully imported.
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  public importImpulseWaveformData(nodeId: string, wavData: Uint8Array): void {
    this.messageHandler.sendFireAndForget({
      type: 'importImpulseWaveform',
      nodeId,
      data: wavData,
    });
  }

  public generateHallReverb(nodeId: string, decayTime: number, roomSize: number): void {
    this.messageHandler.sendFireAndForget({
      type: 'generateHallReverb',
      nodeId,
      decayTime,
      roomSize,
      sampleRate: this.audioContext.sampleRate,
    });
  }

  public generatePlateReverb(nodeId: string, decayTime: number, diffusion: number): void {
    this.messageHandler.sendFireAndForget({
      type: 'generatePlateReverb',
      nodeId,
      decayTime,
      diffusion,
      sampleRate: this.audioContext.sampleRate,
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

  public noteOn(noteNumber: number, velocity: number, options?: { allowDuplicate?: boolean }): void {
    const allowDuplicate = options?.allowDuplicate ?? false;
    const { voiceIndex, stolenNote, isRetrigger } = this.allocateVoice(noteNumber, allowDuplicate);

    this.markVoiceActive(noteNumber, voiceIndex);

    const frequency = this.midiNoteToFrequency(noteNumber);

    if (!this.workletNode) return;

    const gateParam = this.workletNode.parameters.get(`gate_${voiceIndex}`);
    if (gateParam) {
      const retriggering = isRetrigger || stolenNote !== null;
      const portamentoEnabled = this.isPortamentoEnabled();
      const shouldPulseGate =
        retriggering && (this.voiceLimit > 1 || !portamentoEnabled);
      if (shouldPulseGate) {
        const gatePulseDuration = Math.max(
          0.005,
          this.quantumFrames / this.audioContext.sampleRate,
        );
        // Force envelope retrigger by creating a brief gate off-on pulse
        gateParam.setValueAtTime(0, this.audioContext.currentTime);
        gateParam.setValueAtTime(
          1,
          this.audioContext.currentTime + gatePulseDuration,
        );
      } else {
        // Monophonic/legato: keep gate high to avoid killing the stolen note
        gateParam.value = 1;
      }
    }

    const freqParam = this.workletNode.parameters.get(`frequency_${voiceIndex}`);
    if (freqParam) freqParam.value = frequency;

    const gainParam = this.workletNode.parameters.get(`gain_${voiceIndex}`);
    if (gainParam) gainParam.value = velocity / 127;
  }

  public noteOff(noteNumber: number, voiceIndex?: number): void {
    const voicesToRelease =
      voiceIndex !== undefined
        ? [voiceIndex]
        : Array.from(this.activeNotes.get(noteNumber) ?? []);

    if (voiceIndex === undefined) {
      this.activeNotes.delete(noteNumber);
    }

    for (const voice of voicesToRelease) {
      this.releaseVoice(voice);
      if (!this.workletNode) continue;
      const gateParam = this.workletNode.parameters.get(`gate_${voice}`);
      if (gateParam) gateParam.value = 0;
    }
  }

  /**
   * Schedule a note on at a specific audio context time.
   * Used for sample-accurate playback scheduling.
   */
  public noteOnAtTime(
    noteNumber: number,
    velocity: number,
    time: number,
    options?: { allowDuplicate?: boolean },
  ): number | undefined {
    const allowDuplicate = options?.allowDuplicate ?? false;
    const { voiceIndex, stolenNote, isRetrigger } = this.allocateVoice(noteNumber, allowDuplicate);

    this.markVoiceActive(noteNumber, voiceIndex);

    const frequency = this.midiNoteToFrequency(noteNumber);

    if (!this.workletNode) return;

    const gateParam = this.workletNode.parameters.get(`gate_${voiceIndex}`);
    if (gateParam) {
      const retriggering = isRetrigger || stolenNote !== null;
      const portamentoEnabled = this.isPortamentoEnabled();
      const shouldPulseGate =
        retriggering && (this.voiceLimit > 1 || !portamentoEnabled);
      if (shouldPulseGate) {
        const gatePulseDuration = Math.max(
          0.005,
          this.quantumFrames / this.audioContext.sampleRate,
        );
        gateParam.setValueAtTime(0, time);
        gateParam.setValueAtTime(1, time + gatePulseDuration);
      } else {
        gateParam.setValueAtTime(1, time);
      }
    }

    const freqParam = this.workletNode.parameters.get(`frequency_${voiceIndex}`);
    if (freqParam) freqParam.setValueAtTime(frequency, time);

    const gainParam = this.workletNode.parameters.get(`gain_${voiceIndex}`);
    if (gainParam) gainParam.setValueAtTime(velocity / 127, time);

    return voiceIndex;
  }

  /**
   * Schedule a note off at a specific audio context time.
   * Used for sample-accurate playback scheduling.
   */
  public noteOffAtTime(noteNumber: number, time: number, voiceIndex?: number): void {
    const voicesToRelease =
      voiceIndex !== undefined
        ? [voiceIndex]
        : Array.from(this.activeNotes.get(noteNumber) ?? []);

    if (voiceIndex === undefined) {
      this.activeNotes.delete(noteNumber);
    }

    for (const voice of voicesToRelease) {
      this.releaseVoice(voice);
      if (!this.workletNode) continue;
      const gateParam = this.workletNode.parameters.get(`gate_${voice}`);
      if (gateParam) gateParam.setValueAtTime(0, time);
    }
  }

  public gateOffVoiceAtTime(voiceIndex: number, time: number): void {
    this.releaseVoice(voiceIndex);
    if (!this.workletNode) return;
    const gateParam = this.workletNode.parameters.get(`gate_${voiceIndex}`);
    if (gateParam) gateParam.setValueAtTime(0, time);
  }

  /**
   * Cancel all scheduled parameter changes (for stopping playback).
   */
  public cancelScheduledNotes(): void {
    const now = this.audioContext.currentTime;
    if (this.workletNode) {
      for (let i = 0; i < this.voiceLimit; i++) {
        const gateParam = this.workletNode.parameters.get(`gate_${i}`);
        if (gateParam) {
          gateParam.cancelScheduledValues(now);
          gateParam.setValueAtTime(0, now);
        }
        const freqParam = this.workletNode.parameters.get(`frequency_${i}`);
        if (freqParam) freqParam.cancelScheduledValues(now);
        const gainParam = this.workletNode.parameters.get(`gain_${i}`);
        if (gainParam) gainParam.cancelScheduledValues(now);
      }
    }
    this.activeNotes.clear();
    this.voiceToNote.fill(null);
  }

  public setGainForAllVoices(gain: number, time?: number): void {
    if (!this.workletNode) return;
    const clamped = Math.max(0, Math.min(1, gain));
    const when = time ?? this.audioContext.currentTime;
    for (let i = 0; i < this.voiceLimit; i++) {
      const gainParam = this.workletNode.parameters.get(`gain_${i}`);
      if (gainParam) {
        gainParam.setValueAtTime(clamped, when);
      }
    }
  }

  public allNotesOff(): void {
    for (const noteNumber of Array.from(this.activeNotes.keys())) {
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

  private markVoiceActive(noteNumber: number, voiceIndex: number): void {
    if (voiceIndex < 0 || voiceIndex >= this.voiceToNote.length) return;

    let voices = this.activeNotes.get(noteNumber);
    if (!voices) {
      voices = new Set<number>();
      this.activeNotes.set(noteNumber, voices);
    }
    voices.add(voiceIndex);
    this.voiceToNote[voiceIndex] = noteNumber;
    this.voiceLastUsedTime[voiceIndex] = Date.now();
  }

  private releaseVoice(voiceIndex: number): number | null {
    if (voiceIndex < 0 || voiceIndex >= this.voiceToNote.length) return null;

    const noteNumber = this.voiceToNote[voiceIndex];
    if (noteNumber !== null && noteNumber !== undefined) {
      const voices = this.activeNotes.get(noteNumber);
      if (voices) {
        voices.delete(voiceIndex);
        if (voices.size === 0) {
          this.activeNotes.delete(noteNumber);
        }
      }
    }

    this.voiceToNote[voiceIndex] = null;
    return noteNumber ?? null;
  }

  private findNextFreeVoice(): number | null {
    for (let offset = 0; offset < this.voiceLimit; offset++) {
      const candidate = (this.voiceRoundRobinIndex + offset) % this.voiceLimit;
      if (this.voiceToNote[candidate] === null) {
        this.voiceRoundRobinIndex = (candidate + 1) % this.voiceLimit;
        return candidate;
      }
    }
    return null;
  }

  private allocateVoice(
    noteNumber: number,
    allowDuplicate: boolean,
  ): { voiceIndex: number; stolenNote: number | null; isRetrigger: boolean } {
    const existingVoices = this.activeNotes.get(noteNumber);
    if (!allowDuplicate && existingVoices && existingVoices.size > 0) {
      const voiceIndex = existingVoices.values().next().value as number;
      return { voiceIndex, stolenNote: null, isRetrigger: true };
    }

    const freeVoice = this.findNextFreeVoice();
    if (freeVoice !== null) {
      return {
        voiceIndex: freeVoice,
        stolenNote: null,
        isRetrigger: existingVoices?.has(freeVoice) ?? false,
      };
    }

    let oldestVoice = 0;
    let oldestTime = this.voiceLastUsedTime[0] ?? Number.POSITIVE_INFINITY;

    for (let i = 1; i < this.voiceLimit; i++) {
      const time = this.voiceLastUsedTime[i] ?? Number.POSITIVE_INFINITY;
      if (time < oldestTime) {
        oldestTime = time;
        oldestVoice = i;
      }
    }

    const stolenNote = this.releaseVoice(oldestVoice);

    return {
      voiceIndex: oldestVoice,
      stolenNote,
      isRetrigger: stolenNote === noteNumber,
    };
  }

  private isPortamentoEnabled(): boolean {
    for (const glide of this.glideStates.values()) {
      if (glide && glide.active && (glide.time ?? 0) > 0) {
        return true;
      }
    }
    return false;
  }

  public getVoiceLimit(): number {
    return this.voiceLimit;
  }

  private refreshGlideStatesFromPatch(patch: Patch): void {
    this.glideStates.clear();
    const patchGlides = patch?.synthState?.glides;
    if (!patchGlides) return;

    Object.entries(patchGlides).forEach(([id, glide]) => {
      if (!glide) return;
      this.glideStates.set(id, {
        ...glide,
        id: glide.id ?? id,
        time: glide.time ?? 0,
        active: !!glide.active,
      });
    });
  }

  private midiNoteToFrequency(note: number): number {
    return 440 * Math.pow(2, (note - 69) / 12);
  }

  public getQuantumDurationSeconds(): number {
    const frames = this.quantumFrames || 128;
    const sr = this.audioContext.sampleRate || 48000;
    return frames / sr;
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
