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
  type ModulationTargetObject,
  type NodeConnection,
  VoiceNodeType,
  ModulationTarget,
  isModulationTargetObject
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

// interface WasmVoiceConnection {
//   from_id: number;
//   to_id: number;
//   target: number;
//   amount: number;
// }

// interface WasmVoice {
//   id: number;
//   connections: WasmVoiceConnection[];
//   nodes: Array<{
//     id: number;
//     node_type: string;
//   }>;
// }

// interface WasmState {
//   voices: WasmVoice[];
// }

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

    const voiceLayout: VoiceLayout = {
      id: voiceIndex,
      nodes: {
        [VoiceNodeType.Oscillator]: [],
        [VoiceNodeType.Envelope]: [],
        [VoiceNodeType.LFO]: [],
        [VoiceNodeType.Filter]: []
      },
      connections: []
    };

    // Create oscillators
    for (let i = 0; i < this.maxOscillators; i++) {
      const oscId = this.audioEngine.add_oscillator(voiceIndex);
      voiceLayout.nodes[VoiceNodeType.Oscillator].push({
        id: oscId,
        type: VoiceNodeType.Oscillator
      });
    }

    // Create envelopes
    for (let i = 0; i < this.maxEnvelopes; i++) {
      const result = this.audioEngine.create_envelope(voiceIndex);
      voiceLayout.nodes[VoiceNodeType.Envelope].push({
        id: result.envelopeId,
        type: VoiceNodeType.Envelope
      });
    }

    // Create LFOs
    for (let i = 0; i < this.maxLFOs; i++) {
      const result = this.audioEngine.create_lfo(voiceIndex);
      const lfoId = result.lfoId;
      voiceLayout.nodes[VoiceNodeType.LFO].push({
        id: lfoId,
        type: VoiceNodeType.LFO
      });

      // Initialize LFO with default settings
      const lfoParams = new LfoUpdateParams(
        lfoId,
        2.0,              // Default frequency
        LFOWaveform.Sine, // Default waveform
        false,            // Not absolute
        false,            // Not normalized
        LfoTriggerMode.None, // Default trigger mode
        false             // Not active
      );
      this.audioEngine.update_lfo(voiceIndex, lfoParams);
    }

    // Set up default connections for oscillators
    const oscillators = voiceLayout.nodes[VoiceNodeType.Oscillator];
    const [ampEnv] = voiceLayout.nodes[VoiceNodeType.Envelope];

    if (ampEnv && oscillators.length >= 2) {
      const [osc1, osc2] = oscillators;

      this.audioEngine.connect_voice_nodes(
        voiceIndex,
        ampEnv.id,
        PortId.AudioOutput0,
        osc1!.id,
        PortId.GainMod,
        1.0
      );

      voiceLayout.connections.push({
        fromId: ampEnv.id,
        toId: osc1!.id,
        target: ModulationTarget.Gain,
        amount: 1.0
      });

      // Oscillator 2 phase modulates Oscillator 1
      this.audioEngine.connect_voice_nodes(
        voiceIndex,
        osc2!.id,
        PortId.AudioOutput0,
        osc1!.id,
        PortId.PhaseMod,
        1.0
      );

      voiceLayout.connections.push({
        fromId: osc2!.id,
        toId: osc1!.id,
        target: ModulationTarget.PhaseMod,
        amount: 1.0
      });
    }

    return voiceLayout;
  }

  private handleUpdateConnection(data: { voiceIndex: number; connection: NodeConnection }) {
    // Keep the existing handleUpdateConnection logic
    const { voiceIndex, connection } = data;
    if (!this.audioEngine) return;

    try {
      const portId = this.getPortIdForTarget(connection.target);
      console.log('Handling connection update:', {
        voiceIndex,
        fromId: connection.fromId,
        toId: connection.toId,
        target: connection.target,
        portId,
        isRemoving: connection.isRemoving,
        amount: connection.amount
      });

      if (connection.isRemoving) {
        this.audioEngine.remove_voice_connection(
          voiceIndex,
          connection.fromId,
          PortId.AudioOutput0,
          connection.toId,
          portId
        );
      } else {
        this.audioEngine.connect_voice_nodes(
          voiceIndex,
          connection.fromId,
          PortId.AudioOutput0,
          connection.toId,
          portId,
          connection.amount
        );
      }

      this.stateVersion++;
      const newState = this.audioEngine.get_current_state();

      console.log('Connection update completed:', {
        connection,
        newState: newState.voices[voiceIndex].connections
      });

      this.port.postMessage({
        type: 'stateUpdated',
        version: this.stateVersion,
        state: newState
      });

    } catch (err) {
      console.error('Failed to update connection:', err);
    }
  }

  private handleUpdateModulation(data: {
    connection: { fromId: number; toId: number; target: ModulationTarget; amount: number },
    messageId: string
  }) {
    if (!this.audioEngine) return;

    try {
      // Get initial state for validation
      const initialState = this.audioEngine.get_current_state();

      // Convert the ModulationTarget to PortId
      const targetPortId = this.getPortIdForTarget(data.connection.target);

      // Remove if amount is 0
      if (data.connection.amount === 0) {
        // Remove for all voices
        for (let voiceIndex = 0; voiceIndex < this.numVoices; voiceIndex++) {
          console.log(`Removing connection for voice ${voiceIndex}:`, {
            fromId: data.connection.fromId,
            toId: data.connection.toId,
            target: targetPortId
          });

          this.audioEngine.remove_voice_connection(
            voiceIndex,
            data.connection.fromId,
            PortId.AudioOutput0,
            data.connection.toId,
            targetPortId
          );
        }
      } else {
        // Add for all voices
        for (let voiceIndex = 0; voiceIndex < this.numVoices; voiceIndex++) {
          this.audioEngine.connect_voice_nodes(
            voiceIndex,
            data.connection.fromId,
            PortId.AudioOutput0,
            data.connection.toId,
            targetPortId,
            data.connection.amount
          );
        }
      }

      // Get updated state
      const newState = this.audioEngine.get_current_state();

      // Send response back
      this.port.postMessage({
        type: 'modulationUpdated',
        messageId: data.messageId,
        previousState: initialState,
        newState
      });

    } catch (err) {
      console.error('Error updating modulation:', err);
      this.port.postMessage({
        type: 'error',
        messageId: data.messageId,
        error: err instanceof Error ? err.message : String(err)
      });
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

  private isValidModulationTarget(target: ModulationTarget | ModulationTargetObject): boolean {
    const targetValue = isModulationTargetObject(target)
      ? target.value
      : typeof target === 'number'
        ? target
        : null;

    if (targetValue === null) return false;
    return Object.values(ModulationTarget).includes(targetValue);
  }

  private getPortIdForTarget(target: ModulationTarget | ModulationTargetObject): PortId {
    const normalizedTarget = isModulationTargetObject(target) ? target.value : target;

    console.log('Converting ModulationTarget to PortId:', {
      input: target,
      normalized: normalizedTarget,
      inputType: typeof target,
      targetEnum: ModulationTarget[normalizedTarget]
    });

    switch (normalizedTarget) {
      case ModulationTarget.Frequency:  // 0
        return PortId.FrequencyMod;   // 11
      case ModulationTarget.Gain:       // 1
        return PortId.GainMod;        // 16
      case ModulationTarget.FilterCutoff: // 2
        return PortId.CutoffMod;      // 14
      case ModulationTarget.FilterResonance: // 3
        return PortId.ResonanceMod;   // 15
      case ModulationTarget.PhaseMod:   // 4
        return PortId.PhaseMod;       // 12
      case ModulationTarget.ModIndex:   // 5
        return PortId.ModIndex;       // 13
      default:
        console.warn('Unknown ModulationTarget:', {
          target,
          normalized: normalizedTarget,
          ModulationTarget
        });
        return PortId.GainMod;
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

  override process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    if (!this.ready || !this.audioEngine) return true;

    const output = outputs[0];
    if (!output) return true;

    const outputLeft = output[0];
    const outputRight = output[1] || output[0];

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