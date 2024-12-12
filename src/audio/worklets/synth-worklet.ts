/// <reference lib="webworker" />
import './textencoder.js';

import {
    AudioProcessor,
    initSync,
} from '../../../rust-wasm/pkg/audio_processor.js';
import { PortId } from 'app/public/wasm/audio_processor.js';

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

class SynthAudioProcessor extends AudioWorkletProcessor {
    private ready: boolean = false;
    private processor: AudioProcessor | null = null;
    private numVoices: number = 8;
    private macroPhase: number = 0;

    static get parameterDescriptors() {
        const parameters = [];
        const numVoices = 8; // Must match the number in constructor

        // Create parameters for each voice
        for (let i = 0; i < numVoices; i++) {
            // Standard voice parameters
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

            // Add macro parameters for each voice
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
            if (event.data.type === 'wasm-binary') {
                const { wasmBytes } = event.data;
                initSync({ module: new Uint8Array(wasmBytes) });
                this.processor = new AudioProcessor();
                this.processor.init(sampleRate, this.numVoices);

                for (let i = 0; i < this.numVoices; i++) {
                    this.setupFMVoice(i);
                }

                this.ready = true;

            }
        };
        this.port.postMessage({ type: 'ready' });
    }

    setupFMVoice(voiceIndex: number) {
        // Create nodes and get their IDs
        const { carrierId, modulatorId, envelopeId } =
            this.processor!.create_fm_voice(voiceIndex);

        // Set up envelope parameters
        this.processor!.update_envelope(
            voiceIndex,
            envelopeId,
            0.01,  // attack
            0.2,   // decay
            0.5,   // sustain
            0.5    // release
        );

        // Connect envelope to carrier's gain
        this.processor!.connect_voice_nodes(
            voiceIndex,
            envelopeId,
            PortId.AudioOutput0,
            carrierId,
            PortId.GainMod,
            1.0
        );

        // Connect envelope to carrier's gain
        // this.processor!.connect_voice_nodes(
        //     voiceIndex,
        //     envelopeId,
        //     PortId.AudioOutput0,
        //     carrierId,
        //     PortId.GainMod,
        //     1.0
        // );

        // Connect modulator to carrier's phase mod
        this.processor!.connect_voice_nodes(
            voiceIndex,
            modulatorId,
            PortId.AudioOutput0,
            carrierId,
            PortId.PhaseMod,
            1.0
        );

        // Set up mod index macro
        this.processor!.connect_macro(
            voiceIndex,
            0,  // first macro
            carrierId,
            PortId.ModIndex,
            30.0
        );

        return { carrierId, modulatorId, envelopeId };
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

        // Fill arrays with current parameter values
        for (let i = 0; i < this.numVoices; i++) {
            gateArray[i] = parameters[`gate_${i}`]?.[0] ?? 0;
            freqArray[i] = parameters[`frequency_${i}`]?.[0] ?? 440;
            gainArray[i] = parameters[`gain_${i}`]?.[0] ?? 1;

            // Calculate base offset for this voice's macros
            const voiceOffset = i * 4 * 128;

            // Fill macro values
            for (let m = 0; m < 4; m++) {
                const macroOffset = voiceOffset + m * 128;

                // For first voice, first macro, generate LFO pattern
                if (i === 0 && m === 0) {
                    for (let j = 0; j < 128; j++) {
                        //const phase = (j + this.macroPhase) * 2 * Math.PI / 12800;  // Full cycle over 128 samples
                        //const value = (Math.sin(phase) + 1) * 0.5;  // Normalized to 0-1 range
                        macroArray[macroOffset + j] = 0.1;
                    }
                }
            }
        }

        //this.macroPhase = (this.macroPhase + 1) % 12800;

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
