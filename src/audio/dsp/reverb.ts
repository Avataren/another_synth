export default class Reverb {
    private delays: Float32Array[];
    private writeIndexes: number[];
    private readonly sampleRate: number;
    private readonly delayLengths: number[];
    private readonly feedbackGains: number[];
    private readonly mix: number;

    constructor(sampleRate: number) {
        this.sampleRate = sampleRate;

        // Create significantly longer delays - between 50ms to 150ms
        // These delays will be clearly audible
        this.delayLengths = [
            Math.floor(0.050 * sampleRate),
            Math.floor(0.077 * sampleRate),
            Math.floor(0.103 * sampleRate),
            Math.floor(0.151 * sampleRate),
        ];

        // Set fairly high feedback for each delay line
        this.feedbackGains = [0.84, 0.82, 0.80, 0.78];

        // Strong wet signal for obvious effect
        this.mix = 0.9;

        // Initialize delay lines
        this.delays = this.delayLengths.map(length => new Float32Array(length));
        this.writeIndexes = this.delayLengths.map(() => 0);
    }

    process(input: number): number {
        let output = 0;

        // Process each delay line
        for (let i = 0; i < this.delays.length; i++) {
            const delay = this.delays[i]!;
            const length = this.delayLengths[i]!;
            const feedback = this.feedbackGains[i]!;

            // Get the delayed sample
            const readIndex = (this.writeIndexes[i]! - length + delay.length) % delay.length;
            const delayedSample = delay[readIndex]!;

            // Add delayed sample to output
            output += delayedSample;

            // Write new sample = input + feedback * delayed sample
            delay[this.writeIndexes[i]!] = input + feedback * delayedSample;

            // Update write index
            this.writeIndexes[i] = (this.writeIndexes[i]! + 1) % delay.length;
        }

        // Mix dry and wet signals
        // Scale the output down to prevent clipping
        output *= 0.25; // Divide by number of delay lines
        return input * (1 - this.mix) + output * this.mix;
    }
}