// import { type WaveTable, type WaveformType, WaveTableGenerator } from './wave-utils';
// import { type WaveTableBank } from './wavetable-bank';

// //used for ui sync
// export interface OscillatorState {
//     id: number;
//     gain: number;
//     detune_oct: number;
//     detune_semi: number;
//     detune_cents: number;
//     detune: number;
//     hardsync: boolean;
//     waveform: WaveformType;
//     is_active: boolean;
// }

// export class WaveTableOscillator {
//     private phasor = 0.0;
//     private phaseInc = 0.0;
//     private gain = 1.0;
//     private detune = 0.0;
//     private curWaveTable = 0;
//     private currentWaveTables: WaveTable[] = [];
//     private currentType: WaveformType;
//     private sampleRate: number;
//     private hardSyncEnabled = false;
//     private is_active = true;

//     constructor(
//         private bank: WaveTableBank,
//         initialType: WaveformType = 'sine',
//         sampleRate = 44100
//     ) {
//         this.currentType = initialType;
//         this.sampleRate = sampleRate;
//         this.setWaveform(initialType);
//     }

//     public updateState(state: OscillatorState) {
//         this.hardSync = state.hardsync;
//         this.detune = state.detune;
//         this.gain = state.gain;
//         this.setWaveform(state.waveform);
//         this.is_active = state.is_active;
//     }

//     public get hardSync() {
//         return this.hardSyncEnabled;
//     }

//     public set hardSync(val) {
//         this.hardSyncEnabled = val;
//     }

//     public reset() {
//         this.phasor = 0.0;
//     }

//     setWaveform(type: WaveformType): void {
//         this.currentWaveTables = this.bank.getWaveform(type);
//         this.currentType = type;
//         this.updateWaveTableSelector();
//     }

//     private setFrequency(frequency: number): void {
//         this.phaseInc = WaveTableGenerator.freqToNormalized(frequency, this.sampleRate);
//         this.updateWaveTableSelector();
//     }

//     setNote(note: number, detune: number = 0): void {
//         const frequency = WaveTableGenerator.noteToFrequency(note, detune);
//         this.setFrequency(frequency);
//     }

//     setSampleRate(sampleRate: number): void {
//         this.sampleRate = sampleRate;
//         // Recalculate phase increment for new sample rate
//         if (this.phaseInc > 0) {
//             const frequency = this.phaseInc * this.sampleRate;
//             this.setFrequency(frequency);
//         }
//     }

//     private getFrequency(baseFreq: number, detune: number): number {
//         return baseFreq * Math.pow(2, detune / 1200);
//     }

//     private updateWaveTableSelector(): void {
//         let curWaveTable = 0;
//         while (
//             curWaveTable < this.currentWaveTables.length - 1 &&
//             this.phaseInc >= this.currentWaveTables[curWaveTable]!.topFreq
//         ) {
//             ++curWaveTable;
//         }
//         this.curWaveTable = curWaveTable;
//     }

//     process(frequency: number): number {
//         if (!this.is_active) {
//             return 0;
//         }

//         const tunedFrequency = this.getFrequency(frequency, this.detune);
//         this.setFrequency(tunedFrequency);
//         this.phasor += this.phaseInc;
//         if (this.phasor >= 1.0) {
//             this.phasor -= 1.0;
//         }

//         const waveTable = this.currentWaveTables[this.curWaveTable];
//         const temp = this.phasor * waveTable!.waveTableLen;
//         const intPart = Math.floor(temp);
//         const fracPart = temp - intPart;
//         const samp0 = waveTable!.waveTable[intPart];
//         const samp1 = waveTable!.waveTable[intPart + 1];

//         return (samp0! + (samp1! - samp0!) * fracPart) * this.gain;
//     }

//     getWaveform(): WaveformType {
//         return this.currentType;
//     }

//     getCurrentFrequency(): number {
//         return this.phaseInc * this.sampleRate;
//     }

// }