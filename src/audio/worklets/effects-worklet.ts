/// <reference lib="webworker" />

import { ReverbModel } from '../dsp/reverb-model';

declare const AudioWorkletProcessor: {
    prototype: AudioWorkletProcessor;
    new(): AudioWorkletProcessor;
};

declare const registerProcessor: (
    name: string,
    processorCtor: typeof AudioWorkletProcessor,
) => void;

declare const sampleRate: number;

interface AudioWorkletProcessor {
    readonly port: MessagePort;
    process(
        inputs: Float32Array[][],
        outputs: Float32Array[][],
        parameters: Record<string, Float32Array>,
    ): boolean;
}

interface AudioParamDescriptor {
    name: string;
    defaultValue?: number;
    minValue?: number;
    maxValue?: number;
    automationRate?: 'a-rate' | 'k-rate';
}

class WasmAudioProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors(): AudioParamDescriptor[] {
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
                name: 'detune',
                defaultValue: 0,
                minValue: -1200,
                maxValue: 1200,
                automationRate: 'k-rate',
            },
            {
                name: 'gate',
                defaultValue: 0,
                minValue: 0,
                maxValue: 1,
                automationRate: 'a-rate',
            }
        ];
    }

    private reverb = new ReverbModel(sampleRate);

    constructor() {
        super();

        this.port.onmessage = async (event: MessageEvent) => {
            if (event.data.type === 'initialize') {
            }
        };
        this.port.postMessage({ type: 'ready' });
    }


    override process(
        inputs: Float32Array[][],
        outputs: Float32Array[][],
        _parameters: Record<string, Float32Array>,
    ): boolean {
        const bufferSize = 128;
        const input = inputs[0]! as Float32Array[];
        const output = outputs[0]! as Float32Array[];
        // Prepare output buffers
        const inputL = input[0] || new Float32Array(bufferSize);
        const inputR = input[1] || new Float32Array(bufferSize);
        const outputL = output[0] || new Float32Array(bufferSize);
        const outputR = output[1] || new Float32Array(bufferSize);

        // Apply reverb
        this.reverb.processReplace(inputL, inputR, outputL, outputR, bufferSize, 1);

        return true;
    }
}

registerProcessor('effects-audio-processor', WasmAudioProcessor);