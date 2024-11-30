import BiQuadFilter, { FilterType } from './biquad-filter';

export default class BandPass {
    private lpFilter = new BiQuadFilter();
    private hpFilter = new BiQuadFilter();
    private readonly Q_BUTTERWORTH = 0.7071067811865475; // 1/Math.sqrt(2)

    constructor(lowFreq: number, highFreq: number, sampleRate: number) {
        this.updateFrequencies(lowFreq, highFreq, sampleRate);
    }

    updateFrequencies(lowFreq: number, highFreq: number, sampleRate: number): void {
        this.lpFilter.updateCoefficients(FilterType.LowPass, sampleRate, highFreq, this.Q_BUTTERWORTH);
        this.hpFilter.updateCoefficients(FilterType.HighPass, sampleRate, lowFreq, this.Q_BUTTERWORTH);
    }

    process(sample: number): number {
        return this.lpFilter.process(this.hpFilter.process(sample));
    }

    clearBuffers(): void {
        this.hpFilter.clearBuffers();
        this.lpFilter.clearBuffers();
    }
}