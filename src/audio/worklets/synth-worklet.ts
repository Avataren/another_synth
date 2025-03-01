import './textencoder.js';
import type { ConvolverState, EnvelopeConfig, RawConnection, RawVoice, WasmState } from '../types/synth-layout';
import {
  type SynthLayout,
  type VoiceLayout,
  VoiceNodeType,
  type NodeConnectionUpdate,
  type FilterState,
  convertRawModulationType,
} from '../types/synth-layout';
import { type NoiseUpdate } from '../types/noise.js';
import {
  AnalogOscillatorStateUpdate,
  AudioEngine,
  initSync,
  LfoUpdateParams,
  NoiseUpdateParams,
  PortId,
  WasmModulationType,
  WavetableOscillatorStateUpdate,
  type Waveform,
} from 'app/public/wasm/audio_processor.js';
import type OscillatorState from '../models/OscillatorState.js';
interface EnvelopeUpdate {
  config: EnvelopeConfig;
  envelopeId: number;
}

declare const sampleRate: number;

declare global {
  interface AudioWorkletNodeOptions {
    numberOfInputs?: number;
    numberOfOutputs?: number;
    outputChannelCount?: number[];
    parameterData?: Record<string, number>;
  }

  class AudioWorkletProcessor {
    constructor(options?: Partial<AudioWorkletNodeOptions>);
    readonly port: MessagePort;
    process(
      inputs: Float32Array[][],
      outputs: Float32Array[][],
      parameters: Record<string, Float32Array>,
    ): boolean;
  }

  function registerProcessor(
    name: string,
    processorCtor: typeof AudioWorkletProcessor,
  ): void;
}

export enum LfoTriggerMode {
  None = 0,
  Gate = 1,
  Envelope = 2,
}

export enum LFOWaveform {
  Sine = 0,
  Triangle = 1,
  Pulse = 2,
  Saw = 3,
}

export interface LfoUpdateData {
  lfoId: number;
  params: {
    lfoId: number;
    frequency: number;
    phaseOffset: number;
    waveform: number;
    useAbsolute: boolean;
    useNormalized: boolean;
    triggerMode: number;
    gain: number;
    active: boolean;
    loopMode: number,
    loopStart: number,
    loopEnd: number
  };
}

class SynthAudioProcessor extends AudioWorkletProcessor {
  private ready: boolean = false;
  private audioEngine: AudioEngine | null = null;
  private readonly numVoices: number = 8;
  private readonly maxOscillators: number = 2;
  private readonly maxEnvelopes: number = 2;
  private readonly maxLFOs: number = 2;
  private readonly maxFilters: number = 1;
  private voiceLayouts: VoiceLayout[] = [];
  private nextNodeId: number = 0;
  private stateVersion: number = 0;

  static get parameterDescriptors() {
    const parameters = [];
    const numVoices = 8;

    for (let i = 0; i < numVoices; i++) {
      parameters.push(
        {
          name: `gate_${i}`,
          defaultValue: 0,
          minValue: 0,
          maxValue: 1,
          automationRate: 'a-rate',
        },
        {
          name: `frequency_${i}`,
          defaultValue: 440,
          minValue: 20,
          maxValue: 20000,
          automationRate: 'a-rate',
        },
        {
          name: `gain_${i}`,
          defaultValue: 1,
          minValue: 0,
          maxValue: 1,
          automationRate: 'k-rate',
        },
      );

      // Macro parameters
      for (let m = 0; m < 4; m++) {
        parameters.push({
          name: `macro_${i}_${m}`,
          defaultValue: 0,
          minValue: 0,
          maxValue: 1,
          automationRate: 'a-rate',
        });
      }
    }

    parameters.push({
      name: 'master_gain',
      defaultValue: 1,
      minValue: 0,
      maxValue: 1,
      automationRate: 'k-rate',
    });

    return parameters;
  }

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent) => {
      this.handleMessage(event);
    };

    this.port.postMessage({ type: 'ready' });
  }

  private handleMessage(event: MessageEvent) {
    switch (event.data.type) {
      case 'wasm-binary':
        this.handleWasmInit(event.data);
        break;
      case 'updateModulation': // Add this case
        this.handleUpdateModulation(event.data);
        break;
      case 'updateNoise':
        this.handleNoiseUpdate(event.data);
        break;
      case 'updateFilter':
        this.handleUpdateFilter(event.data);
        break;
      case 'updateConnection':
        this.handleUpdateConnection(event.data);
        break;
      case 'updateWavetableOscillator':
        this.handleUpdateWavetableOscillator(event.data);
        break;
      case 'updateOscillator':
        this.handleUpdateOscillator(event.data);
        break;
      case 'getNodeLayout':
        this.handleGetNodeLayout(event.data);
        break;
      case 'getLfoWaveform':
        this.handleGetLfoWaveform(event.data);
        break;
      case 'updateLfo':
        this.handleUpdateLfo(event.data);
        break;
      case 'updateEnvelope':
        this.handleUpdateEnvelope(event.data);
        break;
      case 'requestSync':
        this.handleRequestSync();
        break;
      case 'getEnvelopePreview':
        this.handleGetEnvelopePreview(event.data);
        break;
      case 'importWavetable':
        this.handleImportWavetableData(event.data);
        break;
      case 'importImpulseWaveform':
        this.handleImportImpulseWaveformData(event.data);
        break;
      case 'updateConvolverState':
        this.handleUpdateConvolver(event.data);
        break;
    }
  }

  private handleImportImpulseWaveformData(data: {
    type: string;
    // Using wavData.buffer transfers the ArrayBuffer
    nodeId: number,
    data: Uint8Array;
  }) {
    const uint8Data = new Uint8Array(data.data);
    this.audioEngine!.import_wave_impulse(data.nodeId, uint8Data);
  }

  private handleImportWavetableData(data: {
    type: string;
    // Using wavData.buffer transfers the ArrayBuffer
    nodeId: number,
    data: Uint8Array;
  }) {
    const uint8Data = new Uint8Array(data.data);
    this.audioEngine!.import_wavetable(data.nodeId, uint8Data, 2048);
  }

  // Inside SynthAudioProcessor's handleMessage method:
  private handleGetEnvelopePreview(data: {
    config: EnvelopeConfig;
    previewDuration: number;
  }) {
    if (!this.audioEngine) return;
    try {
      // Call the wasm-bound function on the AudioEngine instance.
      // Ensure you pass the envelope config and preview duration.
      const envelopePreviewData = AudioEngine.get_envelope_preview(
        sampleRate,
        data.config, // The envelope configuration (should match EnvelopeConfig)
        data.previewDuration,
      );
      // Send the preview data (a Float32Array) back to the main thread.
      this.port.postMessage({
        type: 'envelopePreview',
        preview: envelopePreviewData, // This is already a Float32Array.
        source: 'getEnvelopePreview',
      });
    } catch (err) {
      console.error('Error generating envelope preview:', err);
      this.port.postMessage({
        type: 'error',
        source: 'getEnvelopePreview',
        message: 'Failed to generate envelope preview',
      });
    }
  }

  private handleWasmInit(data: { wasmBytes: ArrayBuffer }) {
    try {
      const { wasmBytes } = data;
      initSync({ module: new Uint8Array(wasmBytes) });
      console.log('SAMPLERATE: ', sampleRate);
      this.audioEngine = new AudioEngine(sampleRate);
      this.audioEngine.init(sampleRate, this.numVoices);

      // Initialize all voices first
      this.createNodesAndSetupConnections();
      this.initializeVoices();

      // Initialize state
      this.initializeState();

      this.ready = true;
    } catch (error) {
      console.error('Failed to initialize WASM audio engine:', error);
      this.port.postMessage({
        type: 'error',
        error: 'Failed to initialize audio engine',
      });
    }
  }

  private initializeState() {
    if (!this.audioEngine) return;

    const initialState = this.audioEngine.get_current_state();
    console.log('initialState:', initialState);
    this.stateVersion++;

    // Send both the initial state and state version
    this.port.postMessage({
      type: 'initialState',
      state: initialState,
      version: this.stateVersion,
    });

    // Send the initial layout
    const layout: SynthLayout = {
      voices: this.voiceLayouts,
      globalNodes: {
        masterGain: this.getNextNodeId(),
        effectsChain: [],
      },
      metadata: {
        maxVoices: this.numVoices,
        maxOscillators: this.maxOscillators,
        maxEnvelopes: this.maxEnvelopes,
        maxLFOs: this.maxLFOs,
        maxFilters: this.maxFilters,
        stateVersion: this.stateVersion,
      },
    };

    this.port.postMessage({
      type: 'synthLayout',
      layout,
    });
  }

  private getNextNodeId(): number {
    return this.nextNodeId++;
  }

  private createNodesAndSetupConnections(): void {
    if (!this.audioEngine) throw new Error('Audio engine not initialized');

    // Create noise generator.
    this.audioEngine.create_noise();
    // Create mixer.
    const mixerId = this.audioEngine.create_mixer();
    console.log('#mixerID:', mixerId);

    // Create filter.
    const filterId = this.audioEngine.create_filter();

    // Create oscillators.
    const oscIds: number[] = [];
    const wtoscId = this.audioEngine.create_wavetable_oscillator();
    oscIds.push(wtoscId);

    const oscId = this.audioEngine.create_oscillator();
    oscIds.push(oscId);

    // Create envelopes.
    const envelopeIds: number[] = [];
    for (let i = 0; i < this.maxEnvelopes; i++) {
      const result = this.audioEngine.create_envelope();
      console.log(`Created envelope ${i} with id ${result.envelopeId}`);
      envelopeIds.push(result.envelopeId);
    }

    // Create LFOs.
    const lfoIds: number[] = [];
    for (let i = 0; i < this.maxLFOs; i++) {
      const result = this.audioEngine.create_lfo();
      console.log(`Created LFO ${i} with id ${result.lfoId}`);
      lfoIds.push(result.lfoId);
    }

    // Global frequency node is assumed to have id 0.
    // (No creation method needed if it's fixed.)

    // --- Set up initial connections (as in your original code) ---
    if (envelopeIds.length > 0 && oscIds.length >= 2) {
      // Connect filter to mixer's audio input.
      this.audioEngine.connect_nodes(
        filterId,
        PortId.AudioOutput0,
        mixerId,
        PortId.AudioInput0,
        1.0,
        WasmModulationType.Additive
      );

      // Connect envelope to mixer's gain input.
      this.audioEngine.connect_nodes(
        envelopeIds[0]!,
        PortId.AudioOutput0,
        mixerId,
        PortId.GainMod,
        1.0,
        WasmModulationType.VCA
      );

      // Connect oscillator 1 to filter's audio input.
      this.audioEngine.connect_nodes(
        oscIds[0]!,
        PortId.AudioOutput0,
        filterId,
        PortId.AudioInput0,
        1.0,
        WasmModulationType.Additive
      );

      // Connect oscillator 2's output to oscillator 1's phase mod.
      this.audioEngine.connect_nodes(
        oscIds[1]!,
        PortId.AudioOutput0,
        oscIds[0]!,
        PortId.PhaseMod,
        1.0,
        WasmModulationType.Additive
      );

      // Request a state sync (if needed).
      this.handleRequestSync();
    } else {
      console.warn('Not enough nodes for initial connections');
    }
  }

  private initializeVoices(): void {
    if (!this.audioEngine) throw new Error('Audio engine not initialized');

    // Retrieve and cast the raw WASM state.
    const wasmState = this.audioEngine.get_current_state() as WasmState;
    console.log('Raw WASM state:', wasmState);

    if (!wasmState.voices || wasmState.voices.length === 0) {
      throw new Error('No voices available in WASM state');
    }

    // Use voice 0 as the canonical voice.
    const rawCanonicalVoice: RawVoice = wasmState.voices[0]!;

    // Convert the raw nodes array into an object keyed by VoiceNodeType.
    const nodesByType: { [key in VoiceNodeType]: { id: number; type: VoiceNodeType }[] } = {
      [VoiceNodeType.Oscillator]: [],
      [VoiceNodeType.WavetableOscillator]: [],
      [VoiceNodeType.Envelope]: [],
      [VoiceNodeType.LFO]: [],
      [VoiceNodeType.Filter]: [],
      [VoiceNodeType.Mixer]: [],
      [VoiceNodeType.Noise]: [],
      [VoiceNodeType.GlobalFrequency]: [],
      [VoiceNodeType.Convolver]: [],
    };

    for (const rawNode of rawCanonicalVoice.nodes) {
      let type: VoiceNodeType;
      console.log('## checking rawNode.node_type:', rawNode.node_type);
      switch (rawNode.node_type.trim()) {
        case 'analog_oscillator':
          type = VoiceNodeType.Oscillator;
          break;
        case 'lpfilter':
          type = VoiceNodeType.Filter;
          break;
        case 'envelope':
          type = VoiceNodeType.Envelope;
          break;
        case 'lfo':
          type = VoiceNodeType.LFO;
          break;
        case 'mixer':
          type = VoiceNodeType.Mixer;
          break;
        case 'noise_generator':
          type = VoiceNodeType.Noise;
          break;
        case 'global_frequency':
          type = VoiceNodeType.GlobalFrequency;
          break;
        case 'wavetable_oscillator':
          type = VoiceNodeType.WavetableOscillator;
        case 'convolver':
          type = VoiceNodeType.Convolver;
        default:
          console.warn('##### Unknown node type:', rawNode.node_type);
          type = rawNode.node_type as VoiceNodeType;
      }
      nodesByType[type].push({ id: rawNode.id, type });
    }

    // Convert the raw connections into the expected format.
    const connections = rawCanonicalVoice.connections.map((rawConn: RawConnection) => ({
      fromId: rawConn.from_id,
      toId: rawConn.to_id,
      target: rawConn.target as PortId,
      amount: rawConn.amount,
      modulationType: convertRawModulationType(rawConn.modulation_type),
    }));

    // Build the canonical VoiceLayout.
    const canonicalVoice: VoiceLayout = {
      id: rawCanonicalVoice.id,
      nodes: nodesByType,
      connections: connections,
    };

    // (Optional) Replicate the canonical voice across all voices.
    this.voiceLayouts = [];
    for (let i = 0; i < this.numVoices; i++) {
      this.voiceLayouts.push({ ...canonicalVoice, id: i });
    }
  }

  remove_specific_connection(
    from_node: number,
    to_node: number,
    to_port: PortId,
  ) {
    if (!this.audioEngine) return;
    this.audioEngine.remove_specific_connection(from_node, to_node, to_port);
  }

  /**
   * Port mapping check/verification:
   * PortId.PhaseMod = 12
   * PortId.ModIndex = 13
   * PortId.FrequencyMod = 11
   * PortId.GainMod = 16
   * PortId.CutoffMod = 14
   * PortId.ResonanceMod = 15
   * PortId.AudioOutput0 = 4
   */

  private handleUpdateConnection(data: { connection: NodeConnectionUpdate }) {
    const { connection } = data;
    if (!this.audioEngine) return;

    try {
      console.log('Worklet handling connection update:', {
        connection,
        type: connection.isRemoving ? 'remove' : 'update',
        targetPort: connection.target,
      });

      // Always use remove_specific_connection when removing
      if (connection.isRemoving) {
        this.audioEngine.remove_specific_connection(
          connection.fromId,
          connection.toId,
          connection.target,
        );

        console.log('Removed connection:', {
          from: connection.fromId,
          to: connection.toId,
          target: connection.target,
        });
        return; // Exit early after removal
      }

      // For updates/adds:
      // First remove any existing connection with the same target
      this.audioEngine.remove_specific_connection(
        connection.fromId,
        connection.toId,
        connection.target,
      );

      // Then add the new connection
      console.log('Adding new connection:', {
        from: connection.fromId,
        fromPort: PortId.AudioOutput0,
        to: connection.toId,
        target: connection.target,
        amount: connection.amount,
        modulationType: connection.modulationType,
      });

      this.audioEngine.connect_nodes(
        connection.fromId,
        PortId.AudioOutput0,
        connection.toId,
        connection.target,
        connection.amount,
        connection.modulationType,
      );

      // Verify connection was added
      this.handleRequestSync();
    } catch (err) {
      console.error('Connection update failed in worklet:', err, {
        data: connection,
      });
    }
  }

  private handleRequestSync() {
    if (this.audioEngine) {
      this.stateVersion++;
      this.port.postMessage({
        type: 'stateUpdated',
        version: this.stateVersion,
        state: this.audioEngine.get_current_state(),
      });
    }
  }

  private wasmTargetToPortId(wasmTarget: number): PortId {
    switch (wasmTarget) {
      case 11:
        return PortId.FrequencyMod;
      case 12:
        return PortId.PhaseMod;
      case 13:
        return PortId.ModIndex;
      case 14:
        return PortId.CutoffMod;
      case 15:
        return PortId.ResonanceMod;
      case 16:
        return PortId.GainMod;
      default:
        throw new Error(`Invalid WASM target: ${wasmTarget}`);
    }
  }

  private handleNoiseUpdate(data: { noiseId: number; config: NoiseUpdate }) {
    if (!this.audioEngine) return;
    console.log('noiseData:', data);

    const params = new NoiseUpdateParams(
      data.config.noise_type,
      data.config.cutoff,
      data.config.gain,
      data.config.enabled,
    );

    this.audioEngine.update_noise(data.noiseId, params);
  }

  private handleUpdateFilter(data: {
    type: string;
    filterId: number;
    config: FilterState;
  }) {
    console.log('handle filter update:', data);
    this.audioEngine!.update_filters(
      data.filterId,
      data.config.cutoff,
      data.config.resonance,
    );
  }

  private handleUpdateConvolver(data: {
    type: string;
    nodeId: number;
    state: ConvolverState;
  }) {
    if (!this.audioEngine) return;
    this.audioEngine.update_convolver(data.nodeId, data.state.wetMix);
  }

  private handleUpdateModulation(data: {
    connection: {
      fromId: number;
      toId: number;
      target: PortId;
      amount: number;
      isRemoving?: boolean;
    };
    messageId: string;
  }) {
    if (!this.audioEngine) return;

    try {
      if (data.connection.isRemoving) {
        this.audioEngine.remove_specific_connection(
          data.connection.fromId,
          data.connection.toId,
          data.connection.target,
        );
      } else {
        this.audioEngine.connect_nodes(
          data.connection.fromId,
          PortId.AudioOutput0,
          data.connection.toId,
          data.connection.target,
          data.connection.amount,
          WasmModulationType.VCA,
        );
      }
    } catch (err) {
      console.error('Error updating modulation:', err);
    }
  }

  private handleUpdateWavetableOscillator(data: {
    oscillatorId: number;
    newState: OscillatorState;
  }) {
    if (!this.audioEngine) return;

    const oscStateUpdate = new WavetableOscillatorStateUpdate(
      data.newState.phase_mod_amount,
      data.newState.detune,
      data.newState.hard_sync,
      data.newState.gain,
      data.newState.active,
      data.newState.feedback_amount,
      data.newState.unison_voices,
      data.newState.spread,
      data.newState.wave_index
    );

    try {
      this.audioEngine.update_wavetable_oscillator(data.oscillatorId, oscStateUpdate);
    } catch (err) {
      console.error('Failed to update oscillator:', err);
    }
  }

  private handleUpdateOscillator(data: {
    oscillatorId: number;
    newState: OscillatorState;
  }) {
    if (!this.audioEngine) return;

    const oscStateUpdate = new AnalogOscillatorStateUpdate(
      data.newState.phase_mod_amount,
      data.newState.detune,
      data.newState.hard_sync,
      data.newState.gain,
      data.newState.active,
      data.newState.feedback_amount,
      (data.newState.waveform >> 0) as unknown as Waveform,
      data.newState.unison_voices,
      data.newState.spread
    );

    try {
      this.audioEngine.update_oscillator(
        data.oscillatorId,
        oscStateUpdate,
      );
    } catch (err) {
      console.error('Failed to update oscillator:', err);
    }
  }

  private handleGetNodeLayout(data: { messageId: string }) {
    if (!this.audioEngine) {
      this.port.postMessage({
        type: 'error',
        messageId: data.messageId,
        message: 'Audio engine not initialized',
      });
      return;
    }

    try {
      const layout = this.audioEngine.get_current_state();

      console.log('synth-worklet::handleGetNodeLayer layout:', layout);
      this.port.postMessage({
        type: 'nodeLayout',
        messageId: data.messageId,
        layout: JSON.stringify(layout),
      });
    } catch (err) {
      this.port.postMessage({
        type: 'error',
        messageId: data.messageId,
        message:
          err instanceof Error ? err.message : 'Failed to get node layout',
      });
    }
  }

  private handleGetLfoWaveform(data: { waveform: number; phaseOffset: number, bufferSize: number }) {
    if (!this.audioEngine) return;

    try {
      const waveformData = this.audioEngine.get_lfo_waveform(
        data.waveform,
        data.phaseOffset,
        data.bufferSize,
      );

      this.port.postMessage({
        type: 'lfoWaveform',
        waveform: waveformData,
      });
    } catch (err) {
      console.error('Error generating LFO waveform:', err);
      this.port.postMessage({
        type: 'error',
        message: 'Failed to generate LFO waveform',
      });
    }
  }

  private handleUpdateEnvelope(data: EnvelopeUpdate) {
    if (!this.audioEngine) return;
    //console.log('handleUpdateEnvelope:', data);
    try {
      this.audioEngine.update_envelope(
        data.envelopeId,
        data.config.attack,
        data.config.decay,
        data.config.sustain,
        data.config.release,
        data.config.attackCurve,
        data.config.decayCurve,
        data.config.releaseCurve,
        data.config.active,
      );
    } catch (err) {
      console.error('Error updating LFO:', err);
    }
  }

  private handleUpdateLfo(data: LfoUpdateData) {
    if (!this.audioEngine) return;

    try {
      const lfoParams = new LfoUpdateParams(
        data.params.lfoId,
        data.params.frequency,
        data.params.phaseOffset,
        data.params.waveform,
        data.params.useAbsolute,
        data.params.useNormalized,
        data.params.triggerMode,
        data.params.gain,
        data.params.active,
        data.params.loopMode,
        data.params.loopStart,
        data.params.loopEnd
      );
      this.audioEngine.update_lfos(lfoParams);
    } catch (err) {
      console.error('Error updating LFO:', err);
    }
  }

  override process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    if (!this.ready || !this.audioEngine) return true;

    const output = outputs[0];
    if (!output) return true;

    const outputLeft = output[0];
    const outputRight = output[1];

    if (!outputLeft || !outputRight) return true;

    // Create parameter arrays
    const gateArray = new Float32Array(this.numVoices);
    const freqArray = new Float32Array(this.numVoices);
    const gainArray = new Float32Array(this.numVoices);
    const macroArray = new Float32Array(this.numVoices * 4 * 128);

    for (let i = 0; i < this.numVoices; i++) {
      gateArray[i] = parameters[`gate_${i}`]?.[0] ?? 0;
      freqArray[i] = parameters[`frequency_${i}`]?.[0] ?? 440;
      gainArray[i] = parameters[`gain_${i}`]?.[0] ?? 1;

      const voiceOffset = i * 4 * 128;
      for (let m = 0; m < 4; m++) {
        const macroOffset = voiceOffset + m * 128;
        const macroValue = parameters[`macro_${i}_${m}`]?.[0] ?? 0;
        for (let j = 0; j < 128; j++) {
          macroArray[macroOffset + j] = macroValue;
        }
      }
    }

    const masterGain = parameters.master_gain?.[0] ?? 1;

    this.audioEngine.process_audio(
      gateArray,
      freqArray,
      gainArray,
      macroArray,
      masterGain,
      outputLeft,
      outputRight,
    );

    return true;
  }
}

registerProcessor('synth-audio-processor', SynthAudioProcessor);
