import AllPassFilter from './allpass-filter';
import CombFilter from './comb-filter';

export default class SchroederReverb {
    private combFilters: CombFilter[] = [];
    private allPassFilters: AllPassFilter[] = [];
    private sampleRate: number;

    constructor(sampleRate: number) {
        this.sampleRate = sampleRate;

        // Initialize comb filters with different delays and feedback coefficients
        this.combFilters = [
            new CombFilter(this.msToSamples(29.7), 0.805),
            new CombFilter(this.msToSamples(37.1), 0.827),
            new CombFilter(this.msToSamples(41.1), 0.783),
            new CombFilter(this.msToSamples(43.7), 0.764),
        ];

        // Initialize all-pass filters
        this.allPassFilters = [
            new AllPassFilter(this.msToSamples(5.0), 0.7),
            new AllPassFilter(this.msToSamples(1.7), 0.7),
        ];
    }

    private msToSamples(milliseconds: number): number {
        return (milliseconds / 1000) * this.sampleRate;
    }

    process(input: number): number {
        // Sum outputs of all comb filters
        let combSum = 0;
        for (const comb of this.combFilters) {
            combSum += comb.process(input);
        }
        combSum /= this.combFilters.length; // Average the comb outputs

        // Pass the sum through the all-pass filters
        let output = combSum;
        for (const allPass of this.allPassFilters) {
            output = allPass.process(output);
        }

        return output;
    }

    clear(): void {
        for (const comb of this.combFilters) {
            comb.clear();
        }
        for (const allPass of this.allPassFilters) {
            allPass.clear();
        }
    }
}
