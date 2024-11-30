export default class AllPassFilter {
    private buffer: Float32Array;
    private bufferSize: number;
    private writeIndex: number = 0;
    private feedback: number;

    constructor(delayInSamples: number, feedback: number) {
        this.bufferSize = Math.floor(delayInSamples);
        this.buffer = new Float32Array(this.bufferSize);
        this.feedback = feedback;
    }

    process(input: number): number {
        // Read from the buffer
        const bufferedSample = this.buffer[this.writeIndex]!;

        // Calculate the output
        const output = -input + bufferedSample;

        // Write to the buffer
        this.buffer[this.writeIndex] = input + bufferedSample * this.feedback;

        // Increment and wrap the write index
        this.writeIndex = (this.writeIndex + 1) % this.bufferSize;

        return output;
    }

    clear(): void {
        this.buffer.fill(0);
        this.writeIndex = 0;
    }
}
