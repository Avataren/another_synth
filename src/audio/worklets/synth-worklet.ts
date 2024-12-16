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
        LFOWaveform.Sine,
        false,            // Not absolute
        false,            // Not normalized
        LfoTriggerMode.None,
        false
      );
      this.audioEngine.update_lfo(voiceIndex, lfoParams);
    }

    // Set up default connections
    //const [mainOsc] = voiceLayout.nodes[VoiceNodeType.Oscillator];
    //const [ampEnv] = voiceLayout.nodes[VoiceNodeType.Envelope];

    // if (mainOsc && ampEnv) {
    //   this.audioEngine.connect_voice_nodes(
    //     voiceIndex,
    //     ampEnv.id,
    //     PortId.AudioOutput0,
    //     mainOsc.id,
    //     PortId.GainMod,
    //     1.0
    //   );

    //   voiceLayout.connections.push({
    //     fromId: ampEnv.id,
    //     toId: mainOsc.id,
    //     target: ModulationTarget.Gain,
    //     amount: 1.0
    //   });
    // }
    // Set up default connections
    // Set up default connections
    // Set up default connections
    // Set up default connections
    // Set up default connections
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

  private getPortIdForTarget(target: ModulationTarget | ModulationTargetObject): PortId {
    // Use the type guard to safely handle both enum and object forms
    const targetValue = isModulationTargetObject(target) ? target.value : target;

    switch (targetValue) {
      case ModulationTarget.Frequency:
        return PortId.FrequencyMod;
      case ModulationTarget.Gain:
        return PortId.GainMod;
      case ModulationTarget.FilterCutoff:
        return PortId.CutoffMod;
      case ModulationTarget.FilterResonance:
        return PortId.ResonanceMod;
      case ModulationTarget.PhaseMod:
        return PortId.PhaseMod;
      case ModulationTarget.ModIndex:
        return PortId.ModIndex;
      default:
        console.warn(`No PortId mapping for target: ${targetValue}`);
        return PortId.GainMod;
    }
  }

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent) => {
      if (event.data.type === 'wasm-binary') {
        const { wasmBytes } = event.data;
        initSync({ module: new Uint8Array(wasmBytes) });
        this.audioEngine = new AudioEngine();
        this.audioEngine.init(sampleRate, this.numVoices);

        // Initialize all voices
        for (let i = 0; i < this.numVoices; i++) {
          const voiceLayout = this.initializeVoice(i);
          this.voiceLayouts.push(voiceLayout);
        }
        console.log('voiceLayouts:', this.voiceLayouts);

        // Send layout to main thread
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
            maxFilters: this.maxFilters
          }
        };

        this.port.postMessage({
          type: 'synthLayout',
          layout
        });

        this.ready = true;
      } else if (event.data.type === 'updateModulation') {
        this.updateModulationForAllVoices(event.data.connection);
      }
      else if (event.data.type === 'updateConnection') {
        const { voiceIndex, connection } = event.data;
        console.log('worklet:: got updateConnection:', voiceIndex, connection);
        this.updateConnection(voiceIndex, connection);
      }
      else if (event.data.type === 'updateOscillator') {
        if (this.audioEngine != null) {
          const { oscillatorId, newState } = event.data;
          this.oscHandler.UpdateOscillator(
            this.audioEngine,
            new OscillatorStateUpdate(
              newState.phase_mod_amount,
              newState.freq_mod_amount,
              newState.detune_oct,
              newState.detune_semi,
              newState.detune_cents,
              newState.detune,
              newState.hard_sync,
              newState.gain,
              newState.active,
            ),
            oscillatorId,
            this.numVoices
          );
        }
      }
      else if (event.data.type === 'getLfoWaveform') {
        if (this.audioEngine != null) {
          try {
            const waveformData = this.audioEngine.get_lfo_waveform(
              event.data.waveform,
              event.data.bufferSize
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
      }
      else if (event.data.type === 'updateLfo') {
        if (this.audioEngine != null) {
          const { voiceIndex, lfoId, params } = event.data;
          try {
            const lfoParams = new LfoUpdateParams(
              lfoId,
              params.frequency,
              params.waveform,
              params.useAbsolute,
              params.useNormalized,
              params.triggerMode,
              params.active
            );
            this.audioEngine.update_lfo(voiceIndex, lfoParams);
          } catch (err) {
            console.error('Error updating LFO:', err);
          }
        }
      }

    };

    this.port.postMessage({ type: 'ready' });
  }

  private updateConnection(voiceId: number, connection: NodeConnection) {
    if (!this.audioEngine || voiceId >= this.voiceLayouts.length) {
      console.warn('Invalid voice ID or audio engine not ready:', voiceId);
      return;
    }

    //const voice = this.voiceLayouts[voiceId]!;
    console.log(`Updating connection for voice ${voiceId}:`, connection);

    try {
      // Always update connection regardless of amount
      this.audioEngine.connect_voice_nodes(
        voiceId,
        connection.fromId,
        PortId.AudioOutput0,
        connection.toId,
        this.getPortIdForTarget(connection.target),
        connection.amount
      );
      console.log(`Connection updated for voice ${voiceId}`);
    } catch (err) {
      console.error(`Failed to update connection for voice ${voiceId}:`, err);
    }
  }

  private updateModulationForAllVoices(connection: NodeConnection) {
    if (!this.audioEngine) {
      console.warn('Audio engine not ready');
      return;
    }

    // Apply the modulation to all voices
    for (let voiceId = 0; voiceId < this.numVoices; voiceId++) {
      const voice = this.voiceLayouts[voiceId];
      if (!voice) continue;

      console.log(`Updating modulation for voice ${voiceId}:`, connection);

      try {
        const portId = this.getPortIdForTarget(connection.target);
        console.log('portId: ', portId);
        this.audioEngine.connect_voice_nodes(
          voiceId,
          connection.fromId,
          PortId.AudioOutput0,
          connection.toId,
          portId,
          connection.amount
        );
      } catch (err) {
        console.error(`Failed to update modulation for voice ${voiceId}:`, err);
      }
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