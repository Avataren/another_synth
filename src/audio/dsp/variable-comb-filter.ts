// import { type FilterState } from './filter-state';

// export default class VariableCombFilter {
//     private buffer: Float32Array;
//     private bufferSize: number;
//     private writeIndex: number = 0;
//     private delaySamples: number = 0;
//     private sampleRate: number;

//     private _cut: number = 10000;     // Default cutoff frequency in Hz
//     private _resonance: number = 0.5; // Default resonance value

//     private is_enabled = false;

//     // Filter coefficients and state
//     private filterAlpha: number = 0;
//     private filterState: number = 0;

//     constructor(sampleRate: number, maxDelayMs: number = 100) {
//         this.sampleRate = sampleRate;
//         this.bufferSize = Math.floor((maxDelayMs / 1000) * sampleRate);
//         this.buffer = new Float32Array(this.bufferSize);
//         this.clear();
//         this.delaySamples = Math.floor(this.bufferSize / 2);

//         // Initialize filter coefficient
//         this.cut = this._cut;
//     }

//     /**
//      * Sets the frequency for keytracking, adjusting the delay length.
//      */
//     setFrequency(frequency: number): void {
//         const delayTimeSec = 1 / frequency;
//         this.delaySamples = delayTimeSec * this.sampleRate;

//         // Ensure the delay does not exceed buffer size
//         if (this.delaySamples >= this.bufferSize) {
//             this.delaySamples = this.bufferSize - 1;
//         }
//     }

//     updateState(state: FilterState) {
//         this.cut = state.cut;
//         this.is_enabled = state.is_enabled;
//         this.resonance = state.resonance;
//     }

//     /**
//      * Sets the cutoff frequency for the filter in the feedback loop.
//      * @param cut Cutoff frequency in Hz.
//      */
//     set cut(cut: number) {
//         this._cut = Math.max(20, Math.min(cut, this.sampleRate / 2));
//         const omega = 2 * Math.PI * this._cut / this.sampleRate;
//         this.filterAlpha = Math.exp(-omega);
//     }

//     /**
//      * Gets the current cutoff frequency.
//      */
//     get cut(): number {
//         return this._cut;
//     }

//     /**
//      * Sets the resonance parameter.
//      * @param resonance Value between 0 (no resonance) and 1 (maximum resonance).
//      */
//     set resonance(resonance: number) {
//         this._resonance = Math.max(0, Math.min(resonance, 1)); // Clamp to [0, 1]
//     }

//     /**
//      * Gets the current resonance value.
//      */
//     get resonance(): number {
//         return this._resonance;
//     }

//     /**
//      * Processes an input sample through the comb filter.
//      * @param input The input sample.
//      * @returns The output sample.
//      */
//     process(input: number): number {
//         if (!this.is_enabled) {
//             return input;
//         }

//         const delayInt = Math.floor(this.delaySamples);
//         const frac = this.delaySamples - delayInt;

//         const readIndex1 = (this.writeIndex - delayInt + this.bufferSize) % this.bufferSize;
//         const readIndex2 = (readIndex1 - 1 + this.bufferSize) % this.bufferSize;

//         const delayedSample1 = this.buffer[readIndex1]!;
//         const delayedSample2 = this.buffer[readIndex2]!;

//         // Linear interpolation for fractional delay
//         const delayedSample = delayedSample1 * (1 - frac) + delayedSample2 * frac;

//         // Apply the filter in the feedback loop
//         this.filterState = (1 - this.filterAlpha) * delayedSample + this.filterAlpha * this.filterState;

//         // Apply resonance and ensure stability
//         const maxFeedbackGain = 0.999; // Maximum safe feedback gain
//         const feedbackSample = this.filterState * maxFeedbackGain * this._resonance;

//         // Compute output
//         const output = input + feedbackSample;

//         // Write to buffer
//         this.buffer[this.writeIndex] = output;

//         // Increment and wrap the write index
//         this.writeIndex = (this.writeIndex + 1) % this.bufferSize;

//         return output;
//     }

//     /**
//      * Clears the internal buffer and resets indices.
//      */
//     clear(): void {
//         this.buffer.fill(0);
//         this.writeIndex = 0;
//         this.filterState = 0;
//     }
// }
