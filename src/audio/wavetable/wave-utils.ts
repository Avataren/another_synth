// /**
//  * Core wavetable types and utilities
//  */
// export interface WaveTable {
//     topFreq: number;
//     waveTableLen: number;
//     waveTable: Float32Array;
// }

// export type WaveformType = 'sine' | 'triangle' | 'sawtooth' | 'square';

// /**
//  * FFT implementation for wavetable generation
//  */
// export function fft(N: number, ar: Float64Array, ai: Float64Array): void {
//     const NV2 = N >> 1;
//     const NM1 = N - 1;
//     let M = 0;
//     let TEMP = N;

//     while (TEMP >>= 1) ++M;

//     // Shuffle
//     let j = 1;
//     for (let i = 1; i <= NM1; i++) {
//         if (i < j) {
//             // Swap a[i] and a[j]
//             const t = ar[j - 1]!;
//             ar[j - 1] = ar[i - 1]!;
//             ar[i - 1] = t;
//             const u = ai[j - 1]!;
//             ai[j - 1] = ai[i - 1]!;
//             ai[i - 1] = u;
//         }

//         let k = NV2;
//         while (k < j) {
//             j -= k;
//             k /= 2;
//         }
//         j += k;
//     }

//     let LE = 1;
//     for (let L = 1; L <= M; L++) {
//         const LE1 = LE;
//         LE *= 2;
//         let Ur = 1.0;
//         let Ui = 0.0;
//         const Wr = Math.cos(Math.PI / LE1);
//         const Wi = -Math.sin(Math.PI / LE1);

//         for (let j = 1; j <= LE1; j++) {
//             for (let i = j; i <= N; i += LE) {
//                 const ip = i + LE1;
//                 const Tr = ar[ip - 1]! * Ur - ai[ip - 1]! * Ui;
//                 const Ti = ar[ip - 1]! * Ui + ai[ip - 1]! * Ur;
//                 ar[ip - 1] = ar[i - 1]! - Tr;
//                 ai[ip - 1] = ai[i - 1]! - Ti;
//                 ar[i - 1] = ar[i - 1]! + Tr;
//                 ai[i - 1] = ai[i - 1]! + Ti;
//             }
//             const Ur_old = Ur;
//             Ur = Ur_old * Wr - Ui * Wi;
//             Ui = Ur_old * Wi + Ui * Wr;
//         }
//     }
// }

// /**
//  * Helper class for generating wavetables from frequency domain data
//  */
// export class WaveTableGenerator {
//     /**
//      * Create wavetables for different frequency ranges from frequency domain data
//      */
//     static generateWaveTables(
//         freqWaveRe: Float64Array,
//         freqWaveIm: Float64Array,
//         tableLength: number
//     ): WaveTable[] {
//         // Ensure DC and Nyquist are zeroed
//         freqWaveRe[0] = freqWaveIm[0] = 0.0;
//         freqWaveRe[tableLength >> 1] = freqWaveIm[tableLength >> 1] = 0.0;

//         const tables: WaveTable[] = [];
//         let maxHarmonic = tableLength >> 1;

//         // Find highest non-zero harmonic
//         const minVal = 0.000001; // -120 dB
//         while ((Math.abs(freqWaveRe[maxHarmonic]!) + Math.abs(freqWaveIm[maxHarmonic]!) < minVal) && maxHarmonic) {
//             --maxHarmonic;
//         }

//         if (maxHarmonic === 0) {
//             throw new Error('No harmonics found in input data');
//         }

//         let topFreq = 2.0 / 3.0 / maxHarmonic;
//         const ar = new Float64Array(tableLength);
//         const ai = new Float64Array(tableLength);
//         let scale = 0.0;

//         while (maxHarmonic) {
//             ar.fill(0.0);
//             ai.fill(0.0);

//             // Fill harmonics
//             for (let idx = 1; idx <= maxHarmonic; idx++) {
//                 ar[idx] = freqWaveRe[idx]!;
//                 ai[idx] = freqWaveIm[idx]!;
//                 ar[tableLength - idx] = freqWaveRe[tableLength - idx]!;
//                 ai[tableLength - idx] = freqWaveIm[tableLength - idx]!;
//             }

//             // Transform to time domain
//             fft(tableLength, ar, ai);

//             // Calculate scaling for first table
//             if (scale === 0.0) {
//                 let max = 0;
//                 for (let idx = 0; idx < tableLength; idx++) {
//                     const temp = Math.abs(ai[idx]!);
//                     if (max < temp) max = temp;
//                 }
//                 scale = 1.0 / max * 0.999;
//             }

//             // Create the wavetable
//             const wave = new Float32Array(tableLength + 1);
//             for (let idx = 0; idx < tableLength; idx++) {
//                 wave[idx] = ai[idx]! * scale;
//             }
//             wave[tableLength] = wave[0]!;  // For interpolation wraparound

//             tables.push({
//                 waveTableLen: tableLength,
//                 topFreq,
//                 waveTable: wave
//             });

//             // Prepare for next table
//             topFreq *= 2;
//             maxHarmonic >>= 1;
//         }

//         return tables;
//     }

//     /**
//      * Generate frequency domain data for a custom waveform
//      */
//     static generateCustomWaveform(
//         harmonicAmplitudes: number[],
//         harmonicPhases: number[],
//         tableLength: number
//     ): { real: Float64Array, imag: Float64Array } {
//         const freqWaveRe = new Float64Array(tableLength);
//         const freqWaveIm = new Float64Array(tableLength);

//         const numHarmonics = Math.min(
//             harmonicAmplitudes.length,
//             harmonicPhases.length,
//             tableLength >> 1
//         );

//         for (let i = 1; i <= numHarmonics; i++) {
//             const amplitude = harmonicAmplitudes[i - 1]!;
//             const phase = harmonicPhases[i - 1]!;

//             freqWaveRe[i] = amplitude * Math.cos(phase);
//             freqWaveIm[i] = amplitude * Math.sin(phase);

//             // Mirror for negative frequencies
//             freqWaveRe[tableLength - i] = freqWaveRe[i]!;
//             freqWaveIm[tableLength - i] = -freqWaveIm[i]!;
//         }

//         return { real: freqWaveRe, imag: freqWaveIm };
//     }

//     /**
//      * Helper to convert frequency to normalized frequency
//      */
//     static freqToNormalized(frequency: number, sampleRate: number): number {
//         return frequency / sampleRate;
//     }

//     /**
//      * Helper to convert MIDI note to frequency
//      */
//     static noteToFrequency(note: number, detune: number = 0): number {
//         return 440 * Math.pow(2, (note - 69 + detune / 100) / 12);
//     }
// }