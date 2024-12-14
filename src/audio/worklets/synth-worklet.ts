/// <reference lib="webworker" />
import './textencoder.js';

import {
  AudioEngine,
  initSync,
  LfoUpdateParams,
  OscillatorUpdateParams,
  PortId
} from '../../../rust-wasm/pkg/audio_processor.js';


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

interface SynthVoice {
  oscillators: number[];  // Array of oscillator IDs
  envelope: number;
  vibratoLfo?: number;
  modLfo?: number;
}

class SynthAudioProcessor extends AudioWorkletProcessor {
  private ready: boolean = false;
  private processor: AudioEngine | null = null;
  private readonly numVoices: number = 8;
  private readonly oscillatorsPerVoice: number = 2;  // Can be increased later
  private voices: SynthVoice[] = [];

  static get parameterDescriptors() {
    const parameters = [];
    const numVoices = 8; // Must match the number in constructor
    const oscillatorsPerVoice = 2;  // Must match class property

    for (let i = 0; i < numVoices; i++) {
      // Voice-level parameters
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

      // Per-oscillator parameters
      for (let osc = 0; osc < oscillatorsPerVoice; osc++) {
        parameters.push({
          name: `osc${osc}_detune_${i}`,
          defaultValue: 0,
          minValue: -100,  // ±100 cents = ±1 semitone
          maxValue: 100,
          automationRate: 'a-rate',
        });
      }

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

  initialize_synth(voiceIndex: number) {
    // Initialize voice with oscillators
    const result = this.processor!.initialize_voice(voiceIndex, this.oscillatorsPerVoice);

    // We need to convert from JsValue correctly
    const oscillatorIds = result.oscillatorIds;
    const envelopeId = result.envelopeId;

    // Create modulation sources
    const { lfoId: vibratoLfoId } = this.processor!.create_lfo(voiceIndex);
    const { lfoId: modLfoId } = this.processor!.create_lfo(voiceIndex);

    // Store voice structure
    this.voices[voiceIndex] = {
      oscillators: oscillatorIds,
      envelope: envelopeId,
      vibratoLfo: vibratoLfoId,
      modLfo: modLfoId
    };

    // Configure LFOs
    const vibratoLfoParams = new LfoUpdateParams(
      vibratoLfoId,
      5.0,                  // 5 Hz - typical vibrato rate
      LFOWaveform.Sine,     // smooth sine wave
      false,                // bipolar modulation
      false,                // full -1 to 1 range
      LfoTriggerMode.None   // free-running
    );
    this.processor!.update_lfo(voiceIndex, vibratoLfoParams);

    const modLfoParams = new LfoUpdateParams(
      modLfoId,
      0.5,                  // 0.5 Hz - slow modulation
      LFOWaveform.Sine,
      true,                 // unipolar modulation
      true,                 // normalized range
      LfoTriggerMode.None
    );
    this.processor!.update_lfo(voiceIndex, modLfoParams);

    // Set up envelope
    this.processor!.update_envelope(
      voiceIndex,
      envelopeId,
      0.001,  // attack
      0.2,   // decay
      0.2,   // sustain
      0.5    // release
    );

    // Basic routing: envelope → oscillator gains
    for (const oscId of oscillatorIds) {
      this.processor!.connect_voice_nodes(
        voiceIndex,
        envelopeId,
        PortId.AudioOutput0,
        oscId,
        PortId.GainMod,
        1.0
      );
    }

    // Set up default macro connections
    // Macro 0: Vibrato Amount
    this.processor!.connect_macro(
      voiceIndex,
      0,
      vibratoLfoId,
      PortId.ModIndex,
      0.1  // Max 10% frequency variation
    );

    // Connect vibrato to all oscillator frequencies
    for (const oscId of oscillatorIds) {
      this.processor!.connect_voice_nodes(
        voiceIndex,
        vibratoLfoId,
        PortId.AudioOutput0,
        oscId,
        PortId.FrequencyMod,
        0.0  // Initial amount - controlled by macro
      );
    }
  }

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent) => {
      if (event.data.type === 'wasm-binary') {
        const { wasmBytes } = event.data;
        initSync({ module: new Uint8Array(wasmBytes) });
        this.processor = new AudioEngine();
        this.processor.init(sampleRate, this.numVoices);

        for (let i = 0; i < this.numVoices; i++) {
          this.initialize_synth(i);
        }

        this.ready = true;
      }
    };
    this.port.postMessage({ type: 'ready' });
  }

  override process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    if (!this.ready || !this.processor) return true;

    const output = outputs[0];
    if (!output) return true;

    const outputLeft = output[0];
    const outputRight = output[1] || output[0];

    // Create parameter arrays
    const gateArray = new Float32Array(this.numVoices);
    const freqArray = new Float32Array(this.numVoices);
    const gainArray = new Float32Array(this.numVoices);
    const macroArray = new Float32Array(this.numVoices * 4 * 128);

    // Fill basic parameters and macro values
    for (let i = 0; i < this.numVoices; i++) {
      gateArray[i] = parameters[`gate_${i}`]?.[0] ?? 0;
      freqArray[i] = parameters[`frequency_${i}`]?.[0] ?? 440;
      gainArray[i] = parameters[`gain_${i}`]?.[0] ?? 1;

      // Update oscillator detune values
      const voice = this.voices[i]!;
      for (let osc = 0; osc < this.oscillatorsPerVoice; osc++) {
        const oscId = voice.oscillators[osc]!;
        const detuneValue = parameters[`osc${osc}_detune_${i}`]?.[0] ?? 0;

        const params = new OscillatorUpdateParams(
          freqArray[i]!,
          1.0,    // phase_mod_amount
          1.0,    // freq_mod_amount
          detuneValue
        );
        this.processor.update_oscillator(i, oscId, params);
      }

      // Handle macro automation
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

    this.processor.process_audio(
      gateArray,
      freqArray,
      gainArray,
      macroArray,
      masterGain,
      outputLeft!,
      outputRight!,
    );

    return true;
  }
}

registerProcessor('synth-audio-processor', SynthAudioProcessor);