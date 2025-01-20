/// <reference lib="webworker" />
import './textencoder.js';

import {
  AudioEngine,
  initSync,
  LfoUpdateParams,
  OscillatorStateUpdate,
  PortId
} from 'app/public/wasm/audio_processor.js';
import OscillatorUpdateHandler from './handlers/oscillator-update-handler.js';
import {
  type SynthLayout,
  type VoiceLayout,
  VoiceNodeType,
  type NodeConnectionUpdate
} from '../types/synth-layout';

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
  Saw = 3
}

export interface LfoUpdateData {
  lfoId: number;
  params: {
    lfoId: number;
    frequency: number;
    waveform: number;
    useAbsolute: boolean;
    useNormalized: boolean;
    triggerMode: number;
    active: boolean;
  }
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
  private oscHandler = new OscillatorUpdateHandler();

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
        }
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
      case 'updateModulation':  // Add this case
        this.handleUpdateModulation(event.data);
        break;
      case 'updateConnection':
        this.handleUpdateConnection(event.data);
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
      case 'requestSync':
        this.handleRequestSync();
        break;
    }
  }

  private handleWasmInit(data: { wasmBytes: ArrayBuffer }) {
    try {
      const { wasmBytes } = data;
      initSync({ module: new Uint8Array(wasmBytes) });
      this.audioEngine = new AudioEngine();
      this.audioEngine.init(sampleRate, this.numVoices);

      // Initialize all voices first
      for (let i = 0; i < this.numVoices; i++) {
        const voiceLayout = this.initializeVoice(i);
        this.voiceLayouts.push(voiceLayout);
      }

      // Initialize state
      this.initializeState();

      this.ready = true;
    } catch (error) {
      console.error('Failed to initialize WASM audio engine:', error);
      this.port.postMessage({
        type: 'error',
        error: 'Failed to initialize audio engine'
      });
    }
  }

  private initializeState() {
    if (!this.audioEngine) return;

    const initialState = this.audioEngine.get_current_state();
    this.stateVersion++;

    // Send both the initial state and state version
    this.port.postMessage({
      type: 'initialState',
      state: initialState,
      version: this.stateVersion
    });

    // Send the initial layout
    const layout: SynthLayout = {
      voices: this.voiceLayouts,
      globalNodes: {
        masterGain: this.getNextNodeId(),
        effectsChain: []
      },
      metadata: {
        maxVoices: this.numVoices,
        maxOscillators: this.maxOscillators,
        maxEnvelopes: this.maxEnvelopes,
        maxLFOs: this.maxLFOs,
        maxFilters: this.maxFilters,
        stateVersion: this.stateVersion
      }
    };

    this.port.postMessage({
      type: 'synthLayout',
      layout
    });
  }

  private getNextNodeId(): number {
    return this.nextNodeId++;
  }

  private initializeVoice(voiceIndex: number): VoiceLayout {
    if (!this.audioEngine) {
      throw new Error('Audio engine not initialized');
    }

    console.log('Initializing voice:', voiceIndex);

    const voiceLayout: VoiceLayout = {
      id: voiceIndex,
      nodes: {
        [VoiceNodeType.Oscillator]: [],
        [VoiceNodeType.Envelope]: [],
        [VoiceNodeType.LFO]: [],
        [VoiceNodeType.Filter]: [],
        [VoiceNodeType.Mixer]: []
      },
      connections: []
    };

    // Create mixer
    const mixerId = this.audioEngine.create_mixer(voiceIndex);
    voiceLayout.nodes[VoiceNodeType.Mixer].push({
      id: mixerId,
      type: VoiceNodeType.Mixer
    });

    // Create oscillators
    for (let i = 0; i < this.maxOscillators; i++) {
      const oscId = this.audioEngine.add_oscillator(voiceIndex);
      console.log(`Created oscillator ${i} with id ${oscId}`);
      voiceLayout.nodes[VoiceNodeType.Oscillator].push({
        id: oscId,
        type: VoiceNodeType.Oscillator
      });
    }

    // Create envelopes
    for (let i = 0; i < this.maxEnvelopes; i++) {
      const result = this.audioEngine.create_envelope(voiceIndex);
      console.log(`Created envelope ${i} with id ${result.envelopeId}`);
      voiceLayout.nodes[VoiceNodeType.Envelope].push({
        id: result.envelopeId,
        type: VoiceNodeType.Envelope
      });
    }

    // Create LFOs
    for (let i = 0; i < this.maxLFOs; i++) {
      const result = this.audioEngine.create_lfo(voiceIndex);
      console.log(`Created LFO ${i} with id ${result.lfoId}`);
      voiceLayout.nodes[VoiceNodeType.LFO].push({
        id: result.lfoId,
        type: VoiceNodeType.LFO
      });
    }

    // Set up initial connections
    const oscillators = voiceLayout.nodes[VoiceNodeType.Oscillator];
    const [ampEnv] = voiceLayout.nodes[VoiceNodeType.Envelope];

    if (ampEnv && oscillators.length >= 2) {
      const [osc1, osc2] = oscillators;

      console.log('Setting up initial connections:', {
        ampEnv,
        osc1,
        osc2
      });

      // Connect envelope to mixer's gain input
      this.audioEngine.connect_voice_nodes(
        voiceIndex,
        ampEnv.id,
        PortId.AudioOutput0,
        mixerId.id,
        PortId.GainMod,
        1.0
      );

      // Connect oscillator 1 to mixer audio input
      this.audioEngine.connect_voice_nodes(
        voiceIndex,
        osc1!.id,
        PortId.AudioOutput0,
        mixerId.id,
        PortId.AudioInput0,
        1.0
      );

      // Connect oscillator 2's output to oscillator 1's phase mod
      this.audioEngine.connect_voice_nodes(
        voiceIndex,
        osc2!.id,
        PortId.AudioOutput0,
        osc1!.id,
        PortId.PhaseMod,
        1.0
      );

      // Add connections to layout
      voiceLayout.connections = [
        {
          fromId: ampEnv.id,
          toId: mixerId.id,
          target: PortId.GainMod,
          amount: 1.0
        },
        {
          fromId: osc1!.id,
          toId: mixerId.id,
          target: PortId.AudioInput0,
          amount: 1.0
        },
        {
          fromId: osc2!.id,
          toId: osc1!.id,
          target: PortId.PhaseMod,
          amount: 1.0
        }
      ];

      console.log('Voice layout after setup:', voiceLayout);
    } else {
      console.warn('Not enough nodes for initial connections:', {
        ampEnv,
        oscillatorsLength: oscillators.length
      });
    }

    return voiceLayout;
  }

  remove_specific_connection(
    voice_index: number,
    from_node: number,
    to_node: number,
    to_port: PortId,
  ) {
    if (!this.audioEngine) return;
    this.audioEngine.remove_specific_connection(
      voice_index,
      from_node,
      to_node,
      to_port
    );
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

  private handleUpdateConnection(data: {
    voiceIndex: number;
    connection: NodeConnectionUpdate;
  }) {
    const { voiceIndex, connection } = data;
    if (!this.audioEngine) return;

    try {
      console.log('Worklet handling connection update:', {
        voiceIndex,
        connection,
        type: connection.isRemoving ? 'remove' : 'update',
        targetPort: connection.target
      });

      if (connection.isRemoving) {
        // Make sure we're using the correct port for removal
        const targetPort = connection.target;
        if (typeof targetPort !== 'number' || isNaN(targetPort)) {
          console.error('Invalid target port:', targetPort);
          return;
        }

        this.audioEngine.remove_specific_connection(
          voiceIndex,
          connection.fromId,
          connection.toId,
          targetPort
        );

        console.log('Removed connection:', {
          voice: voiceIndex,
          from: connection.fromId,
          to: connection.toId,
          target: targetPort
        });
      } else {
        // Clean up ALL possible old connections first
        const modTargets = [
          PortId.PhaseMod,
          PortId.FrequencyMod,
          PortId.GainMod,
          PortId.ModIndex,
          PortId.CutoffMod,
          PortId.ResonanceMod
        ];

        for (const target of modTargets) {
          console.log(`Cleaning up potential connection to ${target}`);
          this.audioEngine.remove_specific_connection(
            voiceIndex,
            connection.fromId,
            connection.toId,
            target
          );
        }

        // Add new connection
        console.log('Adding new connection:', {
          voice: voiceIndex,
          from: connection.fromId,
          fromPort: PortId.AudioOutput0,
          to: connection.toId,
          target: connection.target,
          amount: connection.amount
        });

        this.audioEngine.connect_voice_nodes(
          voiceIndex,
          connection.fromId,
          PortId.AudioOutput0,
          connection.toId,
          connection.target,
          connection.amount
        );

        // Verify connection was added
        const state = this.audioEngine.get_current_state();
        console.log('State after adding connection:', state);
      }
    } catch (err) {
      console.error('Connection update failed in worklet:', err, {
        data: connection
      });
    }
  }
  private handleRequestSync() {
    if (this.audioEngine) {
      this.stateVersion++;
      this.port.postMessage({
        type: 'stateUpdated',
        version: this.stateVersion,
        state: this.audioEngine.get_current_state()
      });
    }
  }

  private wasmTargetToPortId(wasmTarget: number): PortId {
    switch (wasmTarget) {
      case 11: return PortId.FrequencyMod;
      case 12: return PortId.PhaseMod;
      case 13: return PortId.ModIndex;
      case 14: return PortId.CutoffMod;
      case 15: return PortId.ResonanceMod;
      case 16: return PortId.GainMod;
      default:
        throw new Error(`Invalid WASM target: ${wasmTarget}`);
    }
  }

  private handleUpdateModulation(data: {
    connection: {
      fromId: number;
      toId: number;
      target: PortId;
      amount: number;
      isRemoving?: boolean;
    },
    messageId: string
  }) {
    if (!this.audioEngine) return;

    try {
      for (let voiceIndex = 0; voiceIndex < this.numVoices; voiceIndex++) {
        if (data.connection.isRemoving) {
          this.audioEngine.remove_specific_connection(
            voiceIndex,
            data.connection.fromId,
            data.connection.toId,
            data.connection.target
          );
        } else {
          this.audioEngine.connect_voice_nodes(
            voiceIndex,
            data.connection.fromId,
            PortId.AudioOutput0,
            data.connection.toId,
            data.connection.target,
            data.connection.amount
          );
        }
      }
    } catch (err) {
      console.error('Error updating modulation:', err);
    }
  }

  private handleUpdateOscillator(data: { oscillatorId: number; newState: OscillatorStateUpdate }) {
    if (!this.audioEngine) return;

    try {
      this.oscHandler.UpdateOscillator(
        this.audioEngine,
        new OscillatorStateUpdate(
          data.newState.phase_mod_amount,
          data.newState.freq_mod_amount,
          data.newState.detune_oct,
          data.newState.detune_semi,
          data.newState.detune_cents,
          data.newState.detune,
          data.newState.hard_sync,
          data.newState.gain,
          data.newState.active,
        ),
        data.oscillatorId,
        this.numVoices
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
        message: 'Audio engine not initialized'
      });
      return;
    }

    try {
      const layout = this.audioEngine.get_current_state();
      this.port.postMessage({
        type: 'nodeLayout',
        messageId: data.messageId,
        layout: JSON.stringify(layout)
      });
    } catch (err) {
      this.port.postMessage({
        type: 'error',
        messageId: data.messageId,
        message: err instanceof Error ? err.message : 'Failed to get node layout'
      });
    }
  }

  private handleGetLfoWaveform(data: { waveform: number; bufferSize: number }) {
    if (!this.audioEngine) return;

    try {
      const waveformData = this.audioEngine.get_lfo_waveform(
        data.waveform,
        data.bufferSize
      );

      this.port.postMessage({
        type: 'lfoWaveform',
        waveform: waveformData
      });
    } catch (err) {
      console.error('Error generating LFO waveform:', err);
      this.port.postMessage({
        type: 'error',
        message: 'Failed to generate LFO waveform'
      });
    }
  }


  private handleUpdateLfo(data: LfoUpdateData) {
    if (!this.audioEngine) return;

    try {
      for (let i = 0; i < this.numVoices; i++) {
        const lfoParams = new LfoUpdateParams(
          data.params.lfoId,
          data.params.frequency,
          data.params.waveform,
          data.params.useAbsolute,
          data.params.useNormalized,
          data.params.triggerMode,
          data.params.active
        );
        this.audioEngine.update_lfo(i, lfoParams);
      }
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