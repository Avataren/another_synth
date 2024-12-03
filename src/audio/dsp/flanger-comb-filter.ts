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

    // DC blocker state
    private prevInput: number = 0;
    private prevOutput: number = 0;
    private readonly DC_POLE = 0.995; // Pole for DC blocking filter

    // Hardcoded flanger parameters
    private readonly FLANGER_RATE = 0.2;    // LFO rate in Hz
    private readonly FLANGER_DEPTH = 0.7;   // Modulation depth
    private readonly FLANGER_MIX = 0.5;     // Wet/dry mix

    private _cut: number = 10000;     // Cutoff frequency in Hz
    private _resonance: number = 0.5; // Resonance value
    private is_enabled = false;

    // Filter coefficients and state
    private filterAlpha: number = 0;
    private filterState: number = 0;

    constructor(sampleRate: number, maxDelayMs: number = 100) {
        this.sampleRate = sampleRate;
        this.bufferSize = Math.floor((maxDelayMs / 1000) * sampleRate);
        this.buffer = new Float32Array(this.bufferSize);
        this.clear();

        // Initialize filter coefficient
        this.cut = this._cut;
    }

    /**
     * DC blocking filter implementation
     */
    private removeDC(input: number): number {
        // First order DC blocking filter: y[n] = x[n] - x[n-1] + R * y[n-1]
        const output = input - this.prevInput + this.DC_POLE * this.prevOutput;

        this.prevInput = input;
        this.prevOutput = output;

        return output;
    }

    setFrequency(frequency: number): void {
        const delayTimeSec = 1 / frequency;
        this.delaySamples = delayTimeSec * this.sampleRate;

        // Ensure the delay doesn't exceed buffer size
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
        // Generate LFO value using sine wave
        const lfoValue = Math.sin(this.phase);

        // Calculate modulated delay time
        const modDepth = this.delaySamples * this.FLANGER_DEPTH;
        return this.delaySamples + (lfoValue * modDepth);
    }

    process(input: number): number {
        if (!this.is_enabled) {
            return input;
        }

        // Update LFO phase
        this.phase += (2 * Math.PI * this.FLANGER_RATE) / this.sampleRate;
        if (this.phase >= 2 * Math.PI) {
            this.phase -= 2 * Math.PI;
        }

        // Get base delay sample for self-oscillation
        const delayInt = Math.floor(this.delaySamples);
        const frac = this.delaySamples - delayInt;

        const readIndex1 = (this.writeIndex - delayInt + this.bufferSize) % this.bufferSize;
        const readIndex2 = (readIndex1 - 1 + this.bufferSize) % this.bufferSize;

        const delayedSample1 = this.buffer[readIndex1]!;
        const delayedSample2 = this.buffer[readIndex2]!;

        // Linear interpolation for base delay
        const delayedSample = delayedSample1 * (1 - frac) + delayedSample2 * frac;

        // Apply the filter in the feedback loop
        this.filterState = (1 - this.filterAlpha) * delayedSample +
            this.filterAlpha * this.filterState;

        // Apply resonance with stability limit
        const maxFeedbackGain = 0.999;
        const feedbackSample = this.filterState * maxFeedbackGain * this._resonance;

        // Compute feedback signal (for self-oscillation)
        const feedbackSignal = input + feedbackSample;

        // Get modulated delay sample for flanging effect
        const modDelay = this.getModulatedDelay();
        const modDelayInt = Math.floor(modDelay);
        const modFrac = modDelay - modDelayInt;

        const modReadIndex1 = (this.writeIndex - modDelayInt + this.bufferSize) % this.bufferSize;
        const modReadIndex2 = (modReadIndex1 - 1 + this.bufferSize) % this.bufferSize;

        const modDelayedSample1 = this.buffer[modReadIndex1]!;
        const modDelayedSample2 = this.buffer[modReadIndex2]!;

        // Linear interpolation for modulated delay
        const modDelayedSample = modDelayedSample1 * (1 - modFrac) + modDelayedSample2 * modFrac;

        // Write feedback signal to buffer
        this.buffer[this.writeIndex] = feedbackSignal;
        this.writeIndex = (this.writeIndex + 1) % this.bufferSize;

        // Mix original feedback signal with modulated signal
        const output = feedbackSignal * (1 - this.FLANGER_MIX) + modDelayedSample * this.FLANGER_MIX;

        // Apply DC blocking filter
        return this.removeDC(output);
    }

    clear(): void {
        this.buffer.fill(0);
        this.writeIndex = 0;
        this.filterState = 0;
        this.phase = 0;
        this.prevInput = 0;
        this.prevOutput = 0;
    }
}