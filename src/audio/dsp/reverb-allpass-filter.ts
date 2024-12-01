// ReverbAllPassFilter.ts

export class ReverbAllPassFilter {
    private buffer: Float32Array;
    private bufferSize: number;
    private bufferIndex: number = 0;
    private feedback: number = 0;

    constructor(size: number, feedback: number) {
        this.bufferSize = size;
        this.buffer = new Float32Array(this.bufferSize);
        this.feedback = feedback;
    }

    setFeedback(value: number): void {
        this.feedback = value;
    }

    process(input: number): number {
        const bufOut = this.buffer[this.bufferIndex]!;
        const output = -input + bufOut;
        this.buffer[this.bufferIndex] = input + (bufOut * this.feedback);

        this.bufferIndex++;
        if (this.bufferIndex >= this.bufferSize) {
            this.bufferIndex = 0;
        }

        return output;
    }

    mute(): void {
        this.buffer.fill(0);
    }
}
