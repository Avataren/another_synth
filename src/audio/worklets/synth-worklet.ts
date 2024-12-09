/// <reference lib="webworker" />

import { AudioProcessor, initSync } from '../../../rust-wasm/pkg/audio_processor.js';
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
            parameters: Record<string, Float32Array>
        ): boolean;
    }

    function registerProcessor(
        name: string,
        processorCtor: typeof AudioWorkletProcessor
    ): void;
}

class SynthAudioProcessor extends AudioWorkletProcessor {
    private ready: boolean = false;
    private emptyBuffer = new Float32Array(128);
    private processor: AudioProcessor | null = null;

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
                automationRate: 'k-rate'
            },
            {
                name: 'gate',
                defaultValue: 0.0,
                minValue: 0,
                maxValue: 1,
                automationRate: 'a-rate'
            }
        ];
    }

    constructor() {
        super();
        // Signal that we're ready to receive the wasm binary
        this.port.postMessage({ type: 'ready' });

        this.port.onmessage = (event: MessageEvent) => {
            if (event.data.type === 'wasm-binary') {
                const { wasmBytes } = event.data;
                const bytes = new Uint8Array(wasmBytes);
                initSync({ module: bytes });
                // Create our own processor instance
                this.processor = new AudioProcessor();
                this.processor.init(sampleRate);
                this.processor.update_envelope(0.1, 0.2, 0.7, 0.3);
                this.ready = true;
            }
        };
    }

    counter = 0;

    override process(
        inputs: Float32Array[][],
        outputs: Float32Array[][],
        parameters: Record<string, Float32Array>
    ): boolean {
        if (!this.ready) return true;

        const output = outputs[0];
        const input = inputs[0];
        if (!output) return true;

        const outputLeft = output[0] || this.emptyBuffer;
        const outputRight = output[1] || new Float32Array(outputLeft.length);
        const inputLeft = input?.[0] || this.emptyBuffer;
        const inputRight = input?.[1] || this.emptyBuffer;
        const gate = parameters.gate as Float32Array;
        const frequency = parameters.frequency as Float32Array;

        this.counter++;
        if (!(this.counter % 1000)) {
            //console.log(gate);
        }

        this.processor?.process_audio(
            inputLeft,
            inputRight,
            gate,
            frequency,
            outputLeft,
            outputRight
        );

        return true;
    }
}

registerProcessor('synth-audio-processor', SynthAudioProcessor);
