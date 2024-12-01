export interface FilterState {
    id: number,
    feedback: number;
    damping: number;
    is_enabled: boolean;
}


export default class VariableCombFilter {
    private buffer: Float32Array;
    private bufferSize: number;
    private writeIndex: number = 0;
    private delaySamples: number = 0;
    private sampleRate: number;

    private _feedback: number = 0.7;      // Default feedback coefficient
    private _dampingFactor: number = 0.5; // Default damping factor

    private lastFeedbackOutput: number = 0;
    private is_enabled = false;
    constructor(sampleRate: number, maxDelayMs: number = 100) {
        this.sampleRate = sampleRate;
        this.bufferSize = Math.floor((maxDelayMs / 1000) * sampleRate);
        this.buffer = new Float32Array(this.bufferSize);
    }

    /**
     * Sets the frequency for keytracking, adjusting the delay length.
     */
    setFrequency(frequency: number): void {
        const delayTimeSec = 1 / frequency;
        this.delaySamples = delayTimeSec * this.sampleRate;

        // Ensure the delay does not exceed buffer size
        if (this.delaySamples >= this.bufferSize) {
            this.delaySamples = this.bufferSize - 1;
        }
    }

    updateState(state: FilterState) {
        this.feedback = state.feedback;
        this.dampingFactor = state.damping;
        this.is_enabled = state.is_enabled;
    }

    /**
     * Sets the feedback coefficient.
     * @param feedback Value between 0 (no feedback) and less than 1 (full feedback).
     */
    set feedback(feedback: number) {
        this._feedback = Math.max(0, Math.min(feedback, 0.99)); // Clamp to [0, 0.99]
    }

    /**
     * Gets the current feedback coefficient.
     */
    get feedback(): number {
        return this._feedback;
    }

    /**
     * Sets the damping factor.
     * @param dampingFactor Value between 0 (no damping) and 1 (full damping).
     */
    set dampingFactor(dampingFactor: number) {
        this._dampingFactor = Math.max(0, Math.min(dampingFactor, 1)); // Clamp to [0, 1]
    }

    /**
     * Gets the current damping factor.
     */
    get dampingFactor(): number {
        return this._dampingFactor;
    }

    /**
     * Processes an input sample through the comb filter.
     * @param input The input sample.
     * @returns The output sample.
     */
    process(input: number): number {
        if (!this.is_enabled) {
            return input;
        }
        const delayInt = Math.floor(this.delaySamples);
        const frac = this.delaySamples - delayInt;

        const readIndex1 = (this.writeIndex - delayInt + this.bufferSize) % this.bufferSize;
        const readIndex2 = (readIndex1 - 1 + this.bufferSize) % this.bufferSize;

        const delayedSample1 = this.buffer[readIndex1]!;
        const delayedSample2 = this.buffer[readIndex2]!;

        // Linear interpolation for fractional delay
        const delayedSample = delayedSample1 * (1 - frac) + delayedSample2 * frac;

        // Apply damping (low-pass filter in feedback loop)
        const dampedFeedback = (1 - this._dampingFactor) * delayedSample + this._dampingFactor * this.lastFeedbackOutput;
        this.lastFeedbackOutput = dampedFeedback;

        const output = dampedFeedback + input;

        // Write to buffer with feedback
        this.buffer[this.writeIndex] = input + dampedFeedback * this._feedback;

        // Increment and wrap the write index
        this.writeIndex = (this.writeIndex + 1) % this.bufferSize;

        return output;
    }

    /**
     * Clears the internal buffer and resets indices.
     */
    clear(): void {
        this.buffer.fill(0);
        this.writeIndex = 0;
        this.lastFeedbackOutput = 0;
    }
}
