/// <reference lib="webworker" />

import Envelope, { type EnvelopeMessage } from './dsp/envelope';
import KarplusStrong from './dsp/karplus-strong';
import { WaveTableBank } from './wavetable/wavetable-bank';
import { WaveTableOscillator } from './wavetable/wavetable-oscillator';

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
    private envelopes: Map<number, Envelope> = new Map();
    private string: KarplusStrong;
    private lastGate: number = 0;

    private bank = new WaveTableBank();
    private osc = new WaveTableOscillator(this.bank, 'sine', sampleRate);

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

    constructor() {
        super();
        this.envelopes.set(0, new Envelope(sampleRate));
        this.string = new KarplusStrong(sampleRate);

        this.port.onmessage = async (event: MessageEvent) => {
            if (event.data.type === 'initialize') {
            }
        };
        this.port.onmessage = (event: MessageEvent) => {
            if (event.data.type === 'updateEnvelope') {
                const msg = event.data as EnvelopeMessage;
                const envelope = this.envelopes.get(msg.id);
                if (envelope) {
                    envelope.updateConfig(msg.config);
                } else {
                    this.envelopes.set(msg.id, new Envelope(sampleRate, msg.config));
                }
            }
        };
        this.port.postMessage({ type: 'ready' });
    }

    private getFrequency(baseFreq: number, detune: number): number {
        return baseFreq * Math.pow(2, detune / 1200);
    }

    override process(
        _inputs: Float32Array[][],
        outputs: Float32Array[][],
        parameters: Record<string, Float32Array>,
    ): boolean {
        const output = outputs[0]! as Float32Array[];
        const frequency = parameters.frequency as Float32Array;
        const gain = parameters.gain as Float32Array;
        const detune = parameters.detune as Float32Array;
        const gate = parameters.gate as Float32Array;

        const bufferSize = output[0]!.length;
        const gainValue = gain[0] as number;
        const detuneValue = detune[0] as number;

        for (let i = 0; i < bufferSize; ++i) {
            const freq = frequency[i] ?? frequency[0] as number;
            const gateValue = gate[i] ?? gate[0] as number;

            // Reset string on new note
            if (gateValue > 0 && this.lastGate <= 0) {
                this.string.clear();
                this.string.setFrequency(freq);
            }

            // Get envelope value
            const envelopeValue = this.envelopes.get(0)!.process(gateValue);

            // Generate oscillator signal with envelope applied
            const oscillatorSample = this.osc.process(this.getFrequency(freq, detuneValue)) * envelopeValue;

            // Process through string model
            const sample = this.string.process(oscillatorSample) * gainValue;

            // Copy to all channels
            for (let channel = 0; channel < output.length; ++channel) {
                output[channel]![i] = sample;
            }

            this.lastGate = gateValue;
        }

        return true;
    }
}

registerProcessor('synth-audio-processor', WasmAudioProcessor);