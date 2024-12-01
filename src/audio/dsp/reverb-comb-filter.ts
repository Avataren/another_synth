// ReverbCombFilter.ts

export class ReverbCombFilter {
    private buffer: Float32Array;
    private bufferSize: number;
    private bufferIndex: number = 0;
    private feedback: number = 0;
    private filterStore: number = 0;
    private damp1: number = 0;
    private damp2: number = 0;

    constructor(size: number) {
        this.bufferSize = size;
        this.buffer = new Float32Array(this.bufferSize);
    }

    setFeedback(value: number): void {
        this.feedback = value;
    }

    setDamp(value: number): void {
        this.damp1 = value;
        this.damp2 = 1 - value;
    }

    process(input: number): number {
        const output = this.buffer[this.bufferIndex]!;
        this.filterStore = (output * this.damp2) + (this.filterStore * this.damp1);
        this.buffer[this.bufferIndex] = input + (this.filterStore * this.feedback);

        this.bufferIndex++;
        if (this.bufferIndex >= this.bufferSize) {
            this.bufferIndex = 0;
        }

        return output;
    }

    mute(): void {
        this.buffer.fill(0);
        this.filterStore = 0;
    }
}
