
export default class KarplusStrong {
    private delayLine: Float32Array;
    private writeIndex: number = 0;
    private readonly sampleRate: number;
    private delayLength: number;
    private readonly maxDelay: number;
    private readonly feedback = 0.99;

    // Simple one-pole lowpass for feedback path
    private lastSample: number = 0;
    private readonly damping: number = 0.5;  // Adjusts string brightness

    constructor(sampleRate: number) {
        this.sampleRate = sampleRate;
        this.maxDelay = Math.ceil(sampleRate / 20); // For 20Hz minimum frequency
        this.delayLine = new Float32Array(this.maxDelay);
        this.delayLength = this.maxDelay;
    }

    setFrequency(frequency: number) {
        // Round to nearest integer for tuning stability
        this.delayLength = Math.min(Math.round(this.sampleRate / frequency), this.maxDelay);
    }

    process(input: number): number {
        // Read from delay line
        const readIndex = (this.writeIndex - this.delayLength + this.delayLine.length) % this.delayLine.length;
        const delayedSample = this.delayLine[readIndex]!;

        // One-pole lowpass filter in feedback path
        this.lastSample = this.lastSample + this.damping * (delayedSample - this.lastSample);

        // Mix input with filtered feedback
        const output = input + (this.lastSample * this.feedback);

        // Write to delay line
        this.delayLine[this.writeIndex] = output;
        this.writeIndex = (this.writeIndex + 1) % this.delayLine.length;

        return output;
    }

    clear() {
        this.delayLine.fill(0);
        this.writeIndex = 0;
        this.lastSample = 0;
    }
}