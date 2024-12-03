export interface FilterState {
    id: number;
    cut: number;
    is_enabled: boolean;
    resonance: number;
}

export default class FlangerCombFilter {
    private buffer: Float32Array;
    private bufferSize: number;
    private writeIndex: number = 0;
    private delaySamples: number = 0;
    private sampleRate: number;
    private phase: number = 0;

    // Enhanced DC blocker state
    private x1: number = 0;
    private x2: number = 0;
    private y1: number = 0;
    private y2: number = 0;
    private readonly R = 0.999;  // Pole radius
    private readonly SQRT2 = Math.sqrt(2);

    // Original flanger parameters
    private readonly FLANGER_RATE = 0.2;
    private readonly FLANGER_DEPTH = 0.7;
    private readonly FLANGER_MIX = 0.5;

    private _cut: number = 10000;
    private _resonance: number = 0.5;
    private is_enabled = false;

    private filterAlpha: number = 0;
    private filterState: number = 0;

    constructor(sampleRate: number, maxDelayMs: number = 100) {
        this.sampleRate = sampleRate;
        this.bufferSize = Math.floor((maxDelayMs / 1000) * sampleRate);
        this.buffer = new Float32Array(this.bufferSize);
        this.clear();
        this.cut = this._cut;
    }

    private removeDC(input: number): number {
        // Second-order DC blocking filter
        // Transfer function: H(z) = (1 - 2z^-1 + z^-2) / (1 - 2Rz^-1 + R^2z^-2)
        const output = input - 2 * this.x1 + this.x2 +
            2 * this.R * this.y1 - this.R * this.R * this.y2;

        // Update state variables
        this.x2 = this.x1;
        this.x1 = input;
        this.y2 = this.y1;
        this.y1 = output;

        return output / (1 + 2 * this.R + this.R * this.R); // Normalize gain
    }

    setFrequency(frequency: number): void {
        const delayTimeSec = 1 / frequency;
        this.delaySamples = delayTimeSec * this.sampleRate;

        if (this.delaySamples >= this.bufferSize) {
            this.delaySamples = this.bufferSize - 1;
        }
    }

    updateState(state: FilterState) {
        this.cut = state.cut;
        this.is_enabled = state.is_enabled;
        this.resonance = state.resonance;
    }

    set cut(cut: number) {
        this._cut = Math.max(20, Math.min(cut, this.sampleRate / 2));
        const omega = 2 * Math.PI * this._cut / this.sampleRate;
        this.filterAlpha = Math.exp(-omega);
    }

    get cut(): number {
        return this._cut;
    }

    set resonance(resonance: number) {
        this._resonance = Math.max(0, Math.min(resonance, 1));
    }

    get resonance(): number {
        return this._resonance;
    }

    private getModulatedDelay(): number {
        const lfoValue = Math.sin(this.phase);
        const modDepth = this.delaySamples * this.FLANGER_DEPTH;
        return this.delaySamples + (lfoValue * modDepth);
    }

    process(input: number): number {
        if (!this.is_enabled) {
            return input;
        }

        this.phase += (2 * Math.PI * this.FLANGER_RATE) / this.sampleRate;
        if (this.phase >= 2 * Math.PI) {
            this.phase -= 2 * Math.PI;
        }

        const delayInt = Math.floor(this.delaySamples);
        const frac = this.delaySamples - delayInt;

        const readIndex1 = (this.writeIndex - delayInt + this.bufferSize) % this.bufferSize;
        const readIndex2 = (readIndex1 - 1 + this.bufferSize) % this.bufferSize;

        const delayedSample1 = this.buffer[readIndex1]!;
        const delayedSample2 = this.buffer[readIndex2]!;

        const delayedSample = delayedSample1 * (1 - frac) + delayedSample2 * frac;

        this.filterState = (1 - this.filterAlpha) * delayedSample +
            this.filterAlpha * this.filterState;

        const maxFeedbackGain = 0.999;
        const feedbackSample = this.filterState * maxFeedbackGain * this._resonance;

        const feedbackSignal = input + feedbackSample;

        const modDelay = this.getModulatedDelay();
        const modDelayInt = Math.floor(modDelay);
        const modFrac = modDelay - modDelayInt;

        const modReadIndex1 = (this.writeIndex - modDelayInt + this.bufferSize) % this.bufferSize;
        const modReadIndex2 = (modReadIndex1 - 1 + this.bufferSize) % this.bufferSize;

        const modDelayedSample1 = this.buffer[modReadIndex1]!;
        const modDelayedSample2 = this.buffer[modReadIndex2]!;

        const modDelayedSample = modDelayedSample1 * (1 - modFrac) + modDelayedSample2 * modFrac;

        this.buffer[this.writeIndex] = feedbackSignal;
        this.writeIndex = (this.writeIndex + 1) % this.bufferSize;

        const output = feedbackSignal * (1 - this.FLANGER_MIX) + modDelayedSample * this.FLANGER_MIX;

        return this.removeDC(output);
    }

    clear(): void {
        this.buffer.fill(0);
        this.writeIndex = 0;
        this.filterState = 0;
        this.phase = 0;
        this.x1 = 0;
        this.x2 = 0;
        this.y1 = 0;
        this.y2 = 0;
    }
}