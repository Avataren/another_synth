export enum NoiseType {
    White,
    Pink,
    Brownian
}

export default class NoiseGenerator {
    private static readonly PINK_NOISE_SCALE = 0.25;
    private static readonly BROWNIAN_NOISE_SCALE = 3.5;
    private static readonly CUTOFF_SMOOTHING = 0.1;
    private static readonly MIN_FREQUENCY = 20;

    // Random number generator state
    private state0 = 0;
    private state1 = 0;
    private state2 = 0;
    private state3 = 0;

    // Noise parameters
    private currentNoiseType: NoiseType;
    private dcOffset: number;

    // Filter parameters
    private targetCutoff: number;
    private currentCutoff: number;
    private previousOutput: number;
    private filterCoeff: number;
    private readonly sampleRate: number;
    private readonly maxFrequency: number;

    // Pink and Brownian noise state
    private readonly pinkNoiseState: Float32Array;
    private brownNoiseState: number;

    // Cached noise function
    private currentNoiseFunc: () => number;

    constructor(sampleRate: number) {
        this.sampleRate = sampleRate;
        this.maxFrequency = sampleRate / 2;
        this.currentNoiseType = NoiseType.White;
        this.setSeed(123); // Default seed
        this.targetCutoff = 1;
        this.currentCutoff = 1;
        this.previousOutput = 0;
        this.filterCoeff = 0;
        this.dcOffset = 0;
        this.pinkNoiseState = new Float32Array(7);
        this.brownNoiseState = 0;
        this.currentNoiseFunc = this.getWhiteNoise.bind(this);
        this.updateFilterCoefficient();
    }

    public setCutoff(value: number): void {
        this.targetCutoff = Math.max(0, Math.min(value, 1));
    }

    public setDCOffset(value: number): void {
        this.dcOffset = Math.max(-1, Math.min(value, 1));
    }

    public setSeed(seed: number): void {
        this.state0 = seed;
        this.state1 = 362436069;
        this.state2 = 521288629;
        this.state3 = 88675123;
    }

    public setNoiseType(noiseType: NoiseType): void {
        this.currentNoiseType = noiseType;
        // Update cached noise function
        switch (noiseType) {
            case NoiseType.White:
                this.currentNoiseFunc = this.getWhiteNoise.bind(this);
                break;
            case NoiseType.Pink:
                this.currentNoiseFunc = this.getPinkNoise.bind(this);
                break;
            case NoiseType.Brownian:
                this.currentNoiseFunc = this.getBrownianNoise.bind(this);
                break;
        }
    }

    private updateFilterCoefficient(cutoffMod: number = 1): void {
        this.currentCutoff += (this.targetCutoff * cutoffMod - this.currentCutoff) * NoiseGenerator.CUTOFF_SMOOTHING;

        // Exponential curve for cutoff frequency
        let cutoffFrequency = NoiseGenerator.MIN_FREQUENCY *
            Math.exp(Math.log(this.maxFrequency / NoiseGenerator.MIN_FREQUENCY) * this.currentCutoff);
        cutoffFrequency = Math.max(NoiseGenerator.MIN_FREQUENCY, Math.min(cutoffFrequency, this.maxFrequency));

        const rc = 1 / (2 * Math.PI * cutoffFrequency);
        const dt = 1 / this.sampleRate;
        this.filterCoeff = dt / (rc + dt);
    }

    private generateRandomNumber(): number {
        const result = ((this.state1 * 5) << 7 | (this.state1 * 5) >>> 25) * 9;
        const t = this.state1 << 9;

        this.state2 ^= this.state0;
        this.state3 ^= this.state1;
        this.state1 ^= this.state2;
        this.state0 ^= this.state3;
        this.state2 ^= t;
        this.state3 = (this.state3 << 11) | (this.state3 >>> 21);

        return result >>> 0;
    }

    private getWhiteNoise(): number {
        return (this.generateRandomNumber() / 4294967295) * 2 - 1;
    }

    private getPinkNoise(): number {
        const white = this.getWhiteNoise();

        this.pinkNoiseState[0] = 0.99886 * this.pinkNoiseState[0]! + white * 0.0555179;
        this.pinkNoiseState[1] = 0.99332 * this.pinkNoiseState[1]! + white * 0.0750759;
        this.pinkNoiseState[2] = 0.96900 * this.pinkNoiseState[2]! + white * 0.1538520;
        this.pinkNoiseState[3] = 0.86650 * this.pinkNoiseState[3]! + white * 0.3104856;
        this.pinkNoiseState[4] = 0.55000 * this.pinkNoiseState[4]! + white * 0.5329522;
        this.pinkNoiseState[5] = -0.7616 * this.pinkNoiseState[5]! - white * 0.0168980;

        const pink = this.pinkNoiseState[0] + this.pinkNoiseState[1] + this.pinkNoiseState[2] +
            this.pinkNoiseState[3] + this.pinkNoiseState[4] + this.pinkNoiseState[5] +
            this.pinkNoiseState[6]! + white * 0.5362;

        this.pinkNoiseState[6] = white * 0.115926;

        return pink * NoiseGenerator.PINK_NOISE_SCALE;
    }

    private getBrownianNoise(): number {
        const white = this.getWhiteNoise();
        this.brownNoiseState = (this.brownNoiseState + (0.02 * white)) / 1.02;
        return this.brownNoiseState * NoiseGenerator.BROWNIAN_NOISE_SCALE;
    }

    private applyFilter(inputNoise: number): number {
        const output = this.filterCoeff * inputNoise + (1 - this.filterCoeff) * this.previousOutput;
        this.previousOutput = output;
        return output;
    }

    public process(amplitude: number, gainParam: number, cutoffMod: number, output: Float32Array) {
        const gain = amplitude * gainParam;

        for (let i = 0; i < output.length; i++) {
            this.updateFilterCoefficient(cutoffMod);
            output[i] = this.applyFilter(this.currentNoiseFunc()) * gain + this.dcOffset;
        }

        return output;
    }
}