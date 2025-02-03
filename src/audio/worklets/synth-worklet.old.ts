// /// <reference lib="webworker" />

// import { type FilterState } from 'src/audio/dsp/filter-state';

// import Envelope, { type EnvelopeMessage } from '../dsp/envelope';
// import { WaveTableBank } from '../wavetable/wavetable-bank';
// import {
//     type OscillatorState,
//     WaveTableOscillator,
// } from '../wavetable/wavetable-oscillator';
// import NoiseGenerator, { type NoiseState, NoiseType } from '../dsp/noise-generator';
// import FlangerCombFilter from '../dsp/flanger-comb-filter';
// import ResonatorBank from '../dsp/resonator-bank';

// declare const AudioWorkletProcessor: {
//     prototype: AudioWorkletProcessor;
//     new(): AudioWorkletProcessor;
// };

// declare const registerProcessor: (
//     name: string,
//     processorCtor: typeof AudioWorkletProcessor,
// ) => void;

// declare const sampleRate: number;

// interface AudioWorkletProcessor {
//     readonly port: MessagePort;
//     process(
//         inputs: Float32Array[][],
//         outputs: Float32Array[][],
//         parameters: Record<string, Float32Array>,
//     ): boolean;
// }

// interface AudioParamDescriptor {
//     name: string;
//     defaultValue?: number;
//     minValue?: number;
//     maxValue?: number;
//     automationRate?: 'a-rate' | 'k-rate';
// }

// class WasmAudioProcessor extends AudioWorkletProcessor {
//     private envelopes: Map<number, Envelope> = new Map();
//     private oscillators: Map<number, WaveTableOscillator> = new Map();
//     private resonatorBank = new ResonatorBank(sampleRate);
//     private lastGate: number = 0;
//     private combFilter = new FlangerCombFilter(sampleRate, 100);
//     private bank = new WaveTableBank();
//     private noise = new NoiseGenerator(sampleRate);
//     private noiseBuffer = new Float32Array(128);
//     static get parameterDescriptors(): AudioParamDescriptor[] {
//         return [
//             {
//                 name: 'frequency',
//                 defaultValue: 440,
//                 minValue: 20,
//                 maxValue: 20000,
//                 automationRate: 'a-rate',
//             },
//             {
//                 name: 'gain',
//                 defaultValue: 0.5,
//                 minValue: 0,
//                 maxValue: 1,
//                 automationRate: 'k-rate',
//             },
//             {
//                 name: 'detune',
//                 defaultValue: 0,
//                 minValue: -1200,
//                 maxValue: 1200,
//                 automationRate: 'k-rate',
//             },
//             {
//                 name: 'gate',
//                 defaultValue: 0,
//                 minValue: 0,
//                 maxValue: 1,
//                 automationRate: 'a-rate',
//             },
//         ];
//     }

//     constructor() {
//         super();
//         this.oscillators.set(
//             0,
//             new WaveTableOscillator(this.bank, 'sawtooth', sampleRate),
//         );
//         this.oscillators.set(
//             1,
//             new WaveTableOscillator(this.bank, 'square', sampleRate),
//         );
//         this.envelopes.set(0, new Envelope(sampleRate));
//         this.envelopes.set(1, new Envelope(sampleRate));
//         this.noise.setNoiseType(NoiseType.Brownian);
//         this.port.onmessage = async (event: MessageEvent) => {
//             if (event.data.type === 'initialize') {
//             }

//             if (event.data.type === 'updateEnvelope') {
//                 const msg = event.data as EnvelopeMessage;
//                 const envelope = this.envelopes.get(msg.id);
//                 if (envelope) {
//                     envelope.updateConfig(msg.config);
//                 } else {
//                     this.envelopes.set(msg.id, new Envelope(sampleRate, msg.config));
//                 }
//             }
//             else if (event.data.type === 'updateNoise') {
//                 const state = event.data.newState as NoiseState;
//                 this.noise.updateState(state);
//             }
//             else if (event.data.type === 'updateOscillator') {
//                 const state = event.data.newState as OscillatorState;
//                 const oscillator = this.oscillators.get(state.id);
//                 if (oscillator) {
//                     oscillator.updateState(state);
//                 } else {
//                     console.error('oscillator doesnt exist: ', state);
//                 }
//             } else if (event.data.type === 'updateFilter') {
//                 const state = event.data.newState as FilterState;
//                 //const oscillator = this.oscillators.get(state.id);
//                 if (this.resonatorBank) {
//                     //this.resonatorBank.updateState(state);
//                 } else {
//                     console.error('oscillator doesnt exist: ', state);
//                 }
//             }
//         };
//         this.resonatorBank.setPreset('marimba');
//         this.port.postMessage({ type: 'ready' });
//     }

//     private getFrequency(baseFreq: number, detune: number): number {
//         return baseFreq * Math.pow(2, detune / 1200);
//     }

//     private softClip(sample: number): number {
//         const threshold = 0.95; // Threshold before clipping starts
//         if (sample > threshold) {
//             return (
//                 threshold +
//                 (sample - threshold) /
//                 (1 + Math.pow((sample - threshold) / (1 - threshold), 2))
//             );
//         } else if (sample < -threshold) {
//             return (
//                 -threshold +
//                 (sample + threshold) /
//                 (1 + Math.pow((sample + threshold) / (1 - threshold), 2))
//             );
//         } else {
//             return sample;
//         }
//     }

//     override process(
//         _inputs: Float32Array[][],
//         outputs: Float32Array[][],
//         parameters: Record<string, Float32Array>,
//     ): boolean {
//         const output = outputs[0]! as Float32Array[];
//         const frequency = parameters.frequency as Float32Array;
//         //const gain = parameters.gain as Float32Array;
//         //const detune = parameters.detune as Float32Array;
//         const gate = parameters.gate as Float32Array;

//         const bufferSize = output[0]!.length;
//         //const gainValue = gain[0] as number;
//         //const detuneValue = detune[0] as number;

//         this.noise.process(1.0, 1.0, 1.0, this.noiseBuffer);
//         this.resonatorBank.setFrequency(frequency[0]!);
//         for (let i = 0; i < bufferSize; ++i) {
//             const freq = frequency[i] ?? (frequency[0] as number);
//             const gateValue = gate[i] ?? (gate[0] as number);

//             // Reset string on new note
//             if (gateValue > 0 && this.lastGate <= 0) {
//                 this.combFilter.clear(); // Clear buffer for new note
//                 this.combFilter.setFrequency(freq);
//                 // this.combFilter.feedback = 0.999;
//                 // this.combFilter.dampingFactor = 0.4;
//                 this.oscillators.forEach((oscillator, _id) => {
//                     if (oscillator.hardSync) {
//                         oscillator.reset();
//                     }
//                 });
//             }
//             // Get envelope value
//             const envelope0Value = this.envelopes.get(0)!.process(gateValue);
//             //const envelope1Value = this.envelopes.get(1)!.process(gateValue);
//             // let oscillatorSample = 0.0;
//             // this.oscillators.forEach((oscillator, _id) => {
//             //     oscillatorSample += oscillator.process(
//             //         this.getFrequency(freq, detuneValue),
//             //     );
//             // });
//             //
//             //oscillatorSample *= envelope0Value;
//             // oscillatorSample = this.noiseBuffer[i]! * envelope0Value;
//             // this.resonatorBank.setFrequency(freq);
//             // let sample = this.resonatorBank.process(oscillatorSample);
//             // sample = this.softClip(sample);
//             // // Copy to all channels


//             this.noiseBuffer[i]! *= envelope0Value;

//             // for (let channel = 0; channel < output.length; ++channel) {
//             //     output[channel]![i] = sample * envelope1Value;
//             // }

//             this.lastGate = gateValue;
//         }
//         const outputBuf = this.resonatorBank.process(this.noiseBuffer);
//         for (let i = 0; i < bufferSize; ++i) {
//             outputBuf[i]! *= 0.25;
//         }
//         for (let channel = 0; channel < output.length; ++channel) {
//             output[channel]!.set(outputBuf);
//         }


//         return true;
//     }
// }

// registerProcessor('synth-audio-processor', WasmAudioProcessor);
