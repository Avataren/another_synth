export default class Oscillator {
    private phase: number = 0;
    private sampleRate: number;

    constructor(sampleRate: number) {
        this.sampleRate = sampleRate;
    }

    // Convert frequency and detune to actual frequency
    private getFrequency(baseFreq: number, detune: number): number {
        return baseFreq * Math.pow(2, detune / 1200);
    }

    // Generate one sample of a sine wave
    private getSine(phase: number): number {
        return Math.sin(2 * Math.PI * phase);
    }

    // Process one sample
    process(frequency: number, detune: number): number {
        const freq = this.getFrequency(frequency, detune);

        // Calculate phase increment for this sample
        const phaseIncrement = freq / this.sampleRate;

        // Get the current sample value
        const sample = this.getSine(this.phase);

        // Increment and wrap phase
        this.phase += phaseIncrement;
        if (this.phase >= 1) {
            this.phase -= 1;
        }

        return sample;
    }

    // Reset oscillator state
    reset() {
        this.phase = 0;
    }
}
