export interface FilterState {
    id: number;
    cut: number;
    is_enabled: boolean;
    resonance: number;
}

interface Resonator {
    ratio: number;
    level: number;
    enabled: boolean;
    delaySamples: number;
    buffer: Float32Array;
    writeIndex: number;
    filterState: number;
    allpass: AllPassFilter;
}

interface Preset {
    name: string;
    resonators: {
        ratio: number;
        level: number;
        enabled?: boolean;
    }[];
    cut?: number;
    resonance?: number;
    allpassDelay?: number;
    allpassFeedback?: number;
}

// An allpass filter that can adjust its delay length without reallocation.
// delayLength sets the effective length used. The underlying buffer is fixed-size.
// feedback controls how strong the allpass effect is.
class AllPassFilter {
    private buffer: Float32Array;
    private bufferSize: number;
    private writeIndex = 0;
    private feedback: number;
    private delayLength: number;


    constructor(maxDelaySamples: number, initialDelay: number, feedback: number) {
        // Pre-allocate a large buffer for the maximum possible delay.
        // The actual delay used is controlled by delayLength.
        this.bufferSize = Math.max(1, Math.floor(maxDelaySamples));
        this.buffer = new Float32Array(this.bufferSize);
        this.feedback = feedback;
        this.delayLength = Math.min(this.bufferSize, Math.floor(initialDelay));
    }

    setDelayLength(samples: number): void {
        // Just change the effective delay, don't reallocate.
        this.delayLength = Math.min(this.bufferSize, Math.max(1, Math.floor(samples)));
        // If current writeIndex is out of range, wrap it.
        this.writeIndex = this.writeIndex % this.delayLength;
    }

    setFeedback(value: number): void {
        this.feedback = Math.max(-0.999, Math.min(0.999, value));
    }

    process(input: number): number {
        // Using Schroeder allpass structure:
        // y[n] = -x[n] + x[n - M] + g * y[n - M]
        const readIndex = (this.writeIndex - this.delayLength + this.bufferSize) % this.bufferSize;
        const bufSample = this.buffer[readIndex]!;
        const output = -input + bufSample;
        this.buffer[this.writeIndex] = input + (bufSample * this.feedback);
        this.writeIndex = (this.writeIndex + 1) % this.delayLength;
        return output;
    }

    clear(): void {
        this.buffer.fill(0);
        this.writeIndex = 0;
    }
}

export default class ResonatorBank {
    private sampleRate: number;
    private resonators: Resonator[] = [];

    // DC blocker state
    private x1 = 0;
    private x2 = 0;
    private y1 = 0;
    private y2 = 0;
    private readonly R = 0.999; // Pole radius for DC blocking

    private _cut = 10000;
    private _resonance = 1.0;
    private is_enabled = true;

    private filterAlpha = 0;
    private bufferSize: number;

    private readonly MAX_RESONATORS = 3;
    // Slightly less than 1.0 to prevent runaway feedback
    private readonly maxFeedbackGain = 0.999;
    private readonly resonatorOutputs: Float32Array[];
    private readonly outputBuffer: Float32Array;
    private readonly blockSize: number;

    // We provide a wide variety of presets with different resonances and dispersion.
    private presets: Preset[] = [
        {
            name: 'string',
            resonators: [
                { ratio: 1.0, level: 1.0 },
                { ratio: 2.0, level: 0.4 },
                { ratio: 3.0, level: 0.3 }
            ],
            cut: 8000,
            resonance: 1.0,
            allpassDelay: 50,
            allpassFeedback: 0.5
        },
        {
            name: 'simple-string',
            resonators: [
                { ratio: 1.0, level: 1.0 }
            ],
            cut: 8000,
            resonance: 1.0,
            allpassDelay: 40,
            allpassFeedback: 0.4
        },
        {
            name: 'piano-like',
            resonators: [
                { ratio: 1.0, level: 1.0 },
                { ratio: 2.0, level: 0.5 }
            ],
            cut: 9000,
            resonance: 1.0,
            allpassDelay: 60,
            allpassFeedback: 0.3
        },
        {
            name: 'bell',
            resonators: [
                { ratio: 1.0, level: 1.0 },
                { ratio: 2.5, level: 0.7 },
                { ratio: 5.1, level: 0.3 }
            ],
            cut: 10000,
            resonance: 1.0,
            allpassDelay: 100,
            allpassFeedback: 0.6
        },
        {
            name: 'harp',
            resonators: [
                { ratio: 1.0, level: 1.0 },
                { ratio: 2.04, level: 0.6 },
                { ratio: 3.1, level: 0.3 }
            ],
            cut: 7000,
            resonance: 1.0,
            allpassDelay: 45,
            allpassFeedback: 0.45
        },
        {
            name: 'guitar',
            resonators: [
                { ratio: 1.0, level: 1.0 },
                { ratio: 2.02, level: 0.5 },
                { ratio: 3.99, level: 0.2 }
            ],
            cut: 8000,
            resonance: 1.0,
            allpassDelay: 70,
            allpassFeedback: 0.5
        },
        {
            name: 'marimba',
            resonators: [
                { ratio: 1.0, level: 1.0 },
                { ratio: 2.95, level: 0.4 }
            ],
            cut: 6000,
            resonance: 1.0,
            allpassDelay: 30,
            allpassFeedback: 0.35
        },
        {
            name: 'wooden',
            resonators: [
                { ratio: 1.0, level: 1.0 },
                { ratio: 1.58, level: 0.5 },
                { ratio: 2.46, level: 0.3 }
            ],
            cut: 6000,
            resonance: 1.0,
            allpassDelay: 80,
            allpassFeedback: 0.55
        },
        {
            name: 'glass',
            resonators: [
                { ratio: 1.0, level: 1.0 },
                { ratio: 2.414, level: 0.6 },
                { ratio: 3.414, level: 0.4 }
            ],
            cut: 12000,
            resonance: 1.0,
            allpassDelay: 90,
            allpassFeedback: 0.4
        },
        {
            name: 'percussion',
            resonators: [
                { ratio: 1.0, level: 1.0 },
                { ratio: 1.33, level: 0.7 }
            ],
            cut: 5000,
            resonance: 1.0,
            allpassDelay: 20,
            allpassFeedback: 0.5
        },
        {
            name: 'drone',
            resonators: [
                { ratio: 1.0, level: 1.0 },
                { ratio: 1.2, level: 0.8 },
                { ratio: 2.5, level: 0.6 }
            ],
            cut: 5000,
            resonance: 1.0,
            allpassDelay: 100,
            allpassFeedback: 0.5
        }
    ];

    constructor(sampleRate: number, maxDelayMs = 100, blockSize = 128) {
        this.sampleRate = sampleRate;
        this.bufferSize = Math.floor((maxDelayMs / 1000) * sampleRate);
        this.blockSize = blockSize;

        // Pre-allocate output buffers
        this.outputBuffer = new Float32Array(blockSize);
        this.resonatorOutputs = Array(this.MAX_RESONATORS)
            .fill(null)
            .map(() => new Float32Array(blockSize));

        // We'll allocate a reasonably large maxDelay for allpass filters.
        // Let's say maxDelay = bufferSize (just to keep it simple).
        // We'll start with a default delay and feedback.
        const defaultAllpassDelay = 50;
        const defaultAllpassFeedback = 0.5;

        for (let i = 0; i < this.MAX_RESONATORS; i++) {
            const buffer = new Float32Array(this.bufferSize);
            const allpass = new AllPassFilter(this.bufferSize, defaultAllpassDelay, defaultAllpassFeedback);
            this.resonators.push({
                ratio: i === 0 ? 1.0 : (i + 1),
                level: i === 0 ? 1.0 : 0.0,
                enabled: i === 0,
                delaySamples: 0,
                buffer,
                writeIndex: 0,
                filterState: 0,
                allpass
            });
        }

        this.clear();
        this.cut = this._cut;
    }

    private removeDC(input: number): number {
        // Rearranged for better vectorization
        const output = input - 2 * this.x1 + this.x2 +
            2 * this.R * this.y1 - this.R * this.R * this.y2;

        // Update state variables
        this.x2 = this.x1;
        this.x1 = input;
        this.y2 = this.y1;
        this.y1 = output;

        // Normalize output
        return output / (1 + 2 * this.R + this.R * this.R);
    }

    setFrequency(frequency: number): void {
        for (let i = 0; i < this.MAX_RESONATORS; i++) {
            const r = this.resonators[i]!;
            if (!r.enabled) continue;
            const freq = frequency * r.ratio;
            let delaySamples = this.sampleRate / freq;
            if (delaySamples >= this.bufferSize) {
                delaySamples = this.bufferSize - 1;
            }
            r.delaySamples = delaySamples;
        }
    }

    updateState(state: FilterState): void {
        this.cut = state.cut;
        this.is_enabled = state.is_enabled;
        this.resonance = state.resonance;
    }

    set cut(cut: number) {
        this._cut = Math.max(20, Math.min(cut, this.sampleRate / 2));
        const omega = (2 * Math.PI * this._cut) / this.sampleRate;
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

    setResonatorEnabled(index: number, enabled: boolean): void {
        if (index === 0 && !enabled) return;
        if (index >= 0 && index < this.MAX_RESONATORS) {
            this.resonators[index]!.enabled = enabled;
        }
    }

    setResonatorParams(index: number, ratio: number, level: number, enabled?: boolean): void {
        if (index < 0 || index >= this.MAX_RESONATORS) return;
        const r = this.resonators[index]!;
        r.ratio = ratio;
        r.level = level;
        if (enabled !== undefined && (index !== 0 || enabled)) {
            r.enabled = enabled;
        }
    }

    setPreset(name: string): void {
        const preset = this.presets.find(p => p.name.toLowerCase() === name.toLowerCase());
        if (!preset) {
            console.log('preset ' + name + ' not found');
            return;
        }
        console.log('set preset:', name);

        // Disable all resonators first
        for (let i = 0; i < this.MAX_RESONATORS; i++) {
            const r = this.resonators[i]!;
            r.enabled = false;
            r.level = 0;
            r.ratio = i + 1;
        }

        const pRes = preset.resonators;
        for (let i = 0; i < pRes.length && i < this.MAX_RESONATORS; i++) {
            const pr = pRes[i]!;
            const r = this.resonators[i]!;
            r.ratio = pr.ratio;
            r.level = pr.level;
            r.enabled = pr.enabled !== undefined ? pr.enabled : (i === 0 || pr.level > 0);
        }

        if (preset.cut !== undefined) this.cut = preset.cut;
        if (preset.resonance !== undefined) this.resonance = preset.resonance;

        // Update allpass filters if specified
        const allpassDelay = preset.allpassDelay ?? 50;
        const allpassFeedback = preset.allpassFeedback ?? 0.5;
        for (let i = 0; i < this.MAX_RESONATORS; i++) {
            this.resonators[i]!.allpass.setDelayLength(allpassDelay);
            this.resonators[i]!.allpass.setFeedback(allpassFeedback);
        }
    }

    process(inputBlock: Float32Array): Float32Array {
        if (!this.is_enabled) return inputBlock;

        if (inputBlock.length !== this.blockSize) {
            throw new Error(`Input block size ${inputBlock.length} does not match configured block size ${this.blockSize}`);
        }

        // Clear output buffers instead of reallocating
        this.outputBuffer.fill(0);
        this.resonatorOutputs.forEach(buffer => buffer.fill(0));

        // Process each resonator
        for (let i = 0; i < this.MAX_RESONATORS; i++) {
            const r = this.resonators[i]!;
            if (!r.enabled || r.level <= 0) continue;

            const resonatorOutput = this.resonatorOutputs[i]!;
            const delaySamples = r.delaySamples;
            const delayInt = Math.floor(delaySamples);
            const frac = delaySamples - delayInt;

            // Process the entire block for this resonator
            for (let n = 0; n < this.blockSize; n++) {
                const readIndex1 = (r.writeIndex - delayInt + this.bufferSize) % this.bufferSize;
                const readIndex2 = (readIndex1 - 1 + this.bufferSize) % this.bufferSize;

                const delayedSample1 = r.buffer[readIndex1]!;
                const delayedSample2 = r.buffer[readIndex2]!;
                const delayedSample = delayedSample1 * (1 - frac) + delayedSample2 * frac;

                r.filterState = delayedSample + (r.filterState - delayedSample) * this.filterAlpha;

                const feedbackSample = r.filterState * this.maxFeedbackGain * this._resonance;
                const feedbackSignal = inputBlock[n]! + feedbackSample;

                const dispersed = r.allpass.process(feedbackSignal);

                r.buffer[r.writeIndex] = dispersed;
                r.writeIndex = (r.writeIndex + 1) % this.bufferSize;

                resonatorOutput[n] = dispersed * r.level;
            }
        }

        // Mix all resonator outputs together
        for (let n = 0; n < this.blockSize; n++) {
            let mixedSample = 0;
            for (let i = 0; i < this.MAX_RESONATORS; i++) {
                mixedSample += this.resonatorOutputs[i]![n]!;
            }
            this.outputBuffer[n] = this.removeDC(mixedSample);
        }

        return this.outputBuffer;
    }

    clear(): void {
        for (let i = 0; i < this.MAX_RESONATORS; i++) {
            const r = this.resonators[i]!;
            r.buffer.fill(0);
            r.writeIndex = 0;
            r.filterState = 0;
            r.allpass.clear();
        }
        this.x1 = 0;
        this.x2 = 0;
        this.y1 = 0;
        this.y2 = 0;
    }
}
