/// <reference lib="webworker" />
import './textencoder.js';

import {
  AudioProcessor,
  initSync,
  PortId,
  NodeId,
} from '../../../rust-wasm/pkg/audio_processor.js';
declare const sampleRate: number;
declare global {
  interface AudioWorkletNodeOptions {
    numberOfInputs?: number;
    numberOfOutputs?: number;
    outputChannelCount?: number[];
    parameterData?: Record<string, number>;
    // processorOptions?: any;
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

class SynthAudioProcessor extends AudioWorkletProcessor {
  private ready: boolean = false;
  private emptyBuffer = new Float32Array(128);
  private processor: AudioProcessor | null = null;
  private oscillatorId: number | null = null;
  private envelopeId: number | null = null;

  static get parameterDescriptors() {
    return [
      {
        name: 'frequency',
        defaultValue: 440,
        minValue: 20,
        maxValue: 20000,
        automationRate: 'a-rate',
      },
      {
        name: 'gain',
        defaultValue: 0.5,
        minValue: 0,
        maxValue: 1,
        automationRate: 'k-rate',
      },
      {
        name: 'gate',
        defaultValue: 0.0,
        minValue: 0,
        maxValue: 1,
        automationRate: 'a-rate',
      },
    ];
  }

  constructor() {
    super();
    this.port.postMessage({ type: 'ready' });

    this.port.onmessage = (event: MessageEvent) => {
      if (event.data.type === 'wasm-binary') {
        const { wasmBytes } = event.data;
        const bytes = new Uint8Array(wasmBytes);
        initSync({ module: bytes });

        // Create processor and set up nodes
        this.processor = new AudioProcessor();
        this.processor.init(sampleRate);

        // Create nodes in correct order
        this.oscillatorId = this.processor.add_oscillator().as_number();
        this.envelopeId = this.processor.add_envelope().as_number();

        // Connect envelope to control oscillator's gain
        this.processor.connect_nodes(
          NodeId.from_number(this.envelopeId),
          PortId.AudioOutput0, // Envelope output
          NodeId.from_number(this.oscillatorId), // Goes to oscillator
          PortId.GainMod, // As gain modulation
          1.0, // Full amount
        );

        // Set up envelope
        // if (this.envelopeId !== null) {
        //   this.processor.update_envelope(
        //     this.envelopeId,
        //     0.01, // attack
        //     0.1, // decay
        //     0.6, // sustain
        //     0.4, // release
        //   );
        // }

        this.ready = true;
      }
    };
  }

  counter = 0;

  override process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    if (!this.ready) return true;

    const output = outputs[0];
    if (!output) return true;

    const outputLeft = output[0] || this.emptyBuffer;
    const outputRight = output[1] || new Float32Array(outputLeft.length);
    const gate = parameters.gate as Float32Array;
    const frequency = parameters.frequency as Float32Array;

    // Add debug logging
    // console.log('Processing:', {
    //   bufferSize: outputLeft.length,
    //   gateValue: gate[0],
    //   freqValue: frequency[0],
    //   oscillatorId: this.oscillatorId,
    //   envelopeId: this.envelopeId,
    // });

    try {
      this.processor?.process_audio(gate, frequency, outputLeft, outputRight);
    } catch (e) {
      console.error('Error in process_audio:', e);
      throw e;
    }

    return true;
  }
}

registerProcessor('synth-audio-processor', SynthAudioProcessor);
