export default class KarplusStrong {
    private delayLine: Float32Array;
    private writeIndex: number = 0;
    private readonly sampleRate: number;
    private delayLength: number;
    private readonly maxDelay: number;
    private readonly feedback = 0.992;
    private exciterPhase: number = 0;

    // Two-pole lowpass for better damping characteristics
    private lastSample1: number = 0;
    private lastSample2: number = 0;
    private readonly damping: number = 0.2;  // Reduced damping coefficient
    private readonly inputScale: number = 0.1; // Scale factor for input signal

    constructor(sampleRate: number) {
        this.sampleRate = sampleRate;
        this.maxDelay = Math.ceil(sampleRate / 20);
        this.delayLine = new Float32Array(this.maxDelay);
        this.delayLength = this.maxDelay;
    }

    setFrequency(frequency: number) {
        this.delayLength = Math.min(Math.round(this.sampleRate / frequency), this.maxDelay);
    }

    process(input: number): number {
        // Read from delay line with linear interpolation
        const readPos = this.writeIndex - this.delayLength;
        const readIndex = (readPos + this.delayLine.length) % this.delayLine.length;
        const frac = readPos - Math.floor(readPos);
        const nextIndex = (readIndex + 1) % this.delayLine.length;

        const sample1 = this.delayLine[readIndex]!;
        const sample2 = this.delayLine[nextIndex]!;
        const delayedSample = sample1 + frac * (sample2 - sample1);

        // Two-pole lowpass filter
        const filtered = delayedSample +
            this.damping * (this.lastSample1 - delayedSample) +
            this.damping * 0.5 * (this.lastSample2 - this.lastSample1);

        this.lastSample2 = this.lastSample1;
        this.lastSample1 = filtered;

        // Scale input and add to filtered feedback
        const output = (input * this.inputScale) + (filtered * this.feedback);

        // Write to delay line
        this.delayLine[this.writeIndex] = output;
        this.writeIndex = (this.writeIndex + 1) % this.delayLine.length;

        return output;
    }

    clear() {
        this.delayLine.fill(0);
        this.writeIndex = 0;
        this.lastSample1 = 0;
        this.lastSample2 = 0;
        this.exciterPhase = 0;
    }
}