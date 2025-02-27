// import { type WaveTable, type WaveformType, WaveTableGenerator } from './wave-utils';

// export class WaveTableBank {
//     private readonly tableLength = 2048;
//     private waveforms: Map<WaveformType, WaveTable[]> = new Map();

//     constructor() {
//         this.initializeWaveforms();
//     }

//     private initializeWaveforms() {
//         this.generateSineWaveTables();
//         this.generateTriangleWaveTables();
//         this.generateSawtoothWaveTables();
//         this.generateSquareWaveTables();
//     }

//     private generateSineWaveTables() {
//         const freqWaveRe = new Float64Array(this.tableLength);
//         const freqWaveIm = new Float64Array(this.tableLength);

//         // Single frequency at fundamental
//         freqWaveRe[1] = 1.0;
//         freqWaveRe[this.tableLength - 1] = -1.0;

//         const tables = WaveTableGenerator.generateWaveTables(
//             freqWaveRe,
//             freqWaveIm,
//             this.tableLength
//         );
//         this.waveforms.set('sine', tables);
//     }

//     private generateTriangleWaveTables() {
//         const freqWaveRe = new Float64Array(this.tableLength);
//         const freqWaveIm = new Float64Array(this.tableLength);

//         for (let n = 1; n < (this.tableLength >> 1); n += 2) {
//             const amplitude = 1.0 / (n * n);
//             if (((n - 1) >> 1) % 2 === 0) {
//                 freqWaveRe[n] = amplitude;
//                 freqWaveRe[this.tableLength - n] = -amplitude;
//             } else {
//                 freqWaveRe[n] = -amplitude;
//                 freqWaveRe[this.tableLength - n] = amplitude;
//             }
//         }

//         const tables = WaveTableGenerator.generateWaveTables(
//             freqWaveRe,
//             freqWaveIm,
//             this.tableLength
//         );
//         this.waveforms.set('triangle', tables);
//     }

//     private generateSawtoothWaveTables() {
//         const freqWaveRe = new Float64Array(this.tableLength);
//         const freqWaveIm = new Float64Array(this.tableLength);

//         for (let n = 1; n < (this.tableLength >> 1); n++) {
//             const amplitude = 1.0 / n;
//             freqWaveRe[n] = amplitude;
//             freqWaveRe[this.tableLength - n] = -amplitude;
//         }

//         const tables = WaveTableGenerator.generateWaveTables(
//             freqWaveRe,
//             freqWaveIm,
//             this.tableLength
//         );
//         this.waveforms.set('sawtooth', tables);
//     }

//     private generateSquareWaveTables() {
//         const freqWaveRe = new Float64Array(this.tableLength);
//         const freqWaveIm = new Float64Array(this.tableLength);

//         for (let n = 1; n < (this.tableLength >> 1); n += 2) {
//             const amplitude = 1.0 / n;
//             freqWaveRe[n] = amplitude;
//             freqWaveRe[this.tableLength - n] = -amplitude;
//         }

//         const tables = WaveTableGenerator.generateWaveTables(
//             freqWaveRe,
//             freqWaveIm,
//             this.tableLength
//         );
//         this.waveforms.set('square', tables);
//     }

//     getWaveform(type: WaveformType): WaveTable[] {
//         const tables = this.waveforms.get(type);
//         if (!tables) {
//             throw new Error(`Waveform type ${type} not found in bank`);
//         }
//         return tables;
//     }

//     addCustomWaveform(
//         name: string,
//         harmonicAmplitudes: number[],
//         harmonicPhases: number[]
//     ): void {
//         const { real, imag } = WaveTableGenerator.generateCustomWaveform(
//             harmonicAmplitudes,
//             harmonicPhases,
//             this.tableLength
//         );

//         const tables = WaveTableGenerator.generateWaveTables(
//             real,
//             imag,
//             this.tableLength
//         );

//         this.waveforms.set(name as WaveformType, tables);
//     }
// }