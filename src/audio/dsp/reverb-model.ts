// ReverbModel.ts

import { ReverbTunings } from './reverb-tunings';
import { ReverbCombFilter } from './reverb-comb-filter';
import { ReverbAllPassFilter } from './reverb-allpass-filter';

export class ReverbModel {
    private gain: number = ReverbTunings.FixedGain;
    private roomSize: number = 0;
    private roomSize1: number = 0;
    private damp: number = 0;
    private damp1: number = 0;
    private wet: number = 0;
    private wet1: number = 0;
    private wet2: number = 0;
    private dry: number = 0;
    private width: number = 0;
    private mode: number = 0;

    private combL: ReverbCombFilter[] = [];
    private combR: ReverbCombFilter[] = [];
    private allpassL: ReverbAllPassFilter[] = [];
    private allpassR: ReverbAllPassFilter[] = [];

    private sampleRate: number;

    constructor(sampleRate: number) {
        this.sampleRate = sampleRate;

        // Initialize filters with adjusted delay lengths
        this.initializeFilters();

        // Set default values
        this.allpassL.forEach((ap) => ap.setFeedback(0.5));
        this.allpassR.forEach((ap) => ap.setFeedback(0.5));

        this.setWet(ReverbTunings.InitialWet);
        this.setRoomSize(ReverbTunings.InitialRoom);
        this.setDry(ReverbTunings.InitialDry);
        this.setDamp(ReverbTunings.InitialDamp);
        this.setWidth(ReverbTunings.InitialWidth);
        this.setMode(ReverbTunings.InitialMode);

        this.mute();
    }

    private initializeFilters(): void {
        const {
            CombDelayTimes,
            AllpassDelayTimes,
            StereoSpreadTime,
            NumCombs,
            NumAllpasses,
        } = ReverbTunings;

        // Adjust stereo spread according to sample rate
        const stereoSpreadInSamples = Math.round(StereoSpreadTime * this.sampleRate);

        // Initialize Comb Filters
        for (let i = 0; i < NumCombs; i++) {
            const delayTime = CombDelayTimes[i % CombDelayTimes.length]!;
            const delayInSamplesL = Math.round(delayTime * this.sampleRate);
            const delayInSamplesR = delayInSamplesL + stereoSpreadInSamples;

            this.combL.push(new ReverbCombFilter(delayInSamplesL));
            this.combR.push(new ReverbCombFilter(delayInSamplesR));
        }

        // Initialize Allpass Filters
        for (let i = 0; i < NumAllpasses; i++) {
            const delayTime = AllpassDelayTimes[i % AllpassDelayTimes.length]!;
            const delayInSamplesL = Math.round(delayTime * this.sampleRate);
            const delayInSamplesR = delayInSamplesL + stereoSpreadInSamples;

            this.allpassL.push(new ReverbAllPassFilter(delayInSamplesL, 0.5));
            this.allpassR.push(new ReverbAllPassFilter(delayInSamplesR, 0.5));
        }
    }

    private softClip(input: number): number {
        const threshold = 0.6;
        if (input > threshold) {
            return threshold + (input - threshold) / (1 + Math.pow(input - threshold, 2));
        } else if (input < -threshold) {
            return -threshold + (input + threshold) / (1 + Math.pow(-input - threshold, 2));
        } else {
            return input;
        }
    }

    public mute(): void {
        if (this.mode >= ReverbTunings.FreezeMode) return;

        this.combL.forEach((comb) => comb.mute());
        this.combR.forEach((comb) => comb.mute());
        this.allpassL.forEach((ap) => ap.mute());
        this.allpassR.forEach((ap) => ap.mute());
    }

    public processReplace(
        inputL: Float32Array,
        inputR: Float32Array,
        outputL: Float32Array,
        outputR: Float32Array,
        numSamples: number,
        skip: number
    ): void {
        let outL: number, outR: number, input: number;

        for (let i = 0; i < numSamples; i++) {
            outL = 0;
            outR = 0;
            input = (inputL[i * skip]! + inputR[i * skip]!) * this.gain;

            // Accumulate comb filters in parallel
            for (let j = 0; j < this.combL.length; j++) {
                outL += this.combL[j]!.process(input);
                outR += this.combR[j]!.process(input);
            }

            // Feed through allpasses in series
            for (let j = 0; j < this.allpassL.length; j++) {
                outL = this.allpassL[j]!.process(outL);
                outR = this.allpassR[j]!.process(outR);
            }

            // Calculate output REPLACING anything already there
            outputL[i * skip] = outL * this.wet1 + outR * this.wet2 + inputL[i * skip]! * this.dry;
            outputR[i * skip] = outR * this.wet1 + outL * this.wet2 + inputR[i * skip]! * this.dry;

            // Optional phase shift (as in your C# code)
            const phaseShift = 0.02;
            outputR[i * skip]! += outputL[i * skip]! * phaseShift;
            outputL[i * skip]! -= outputR[i * skip]! * phaseShift;

            // Soft clipping
            outputL[i * skip] = this.softClip(outputL[i * skip]!);
            outputR[i * skip] = this.softClip(outputR[i * skip]!);
        }
    }

    private update(): void {
        this.wet1 = this.wet * (this.width / 2 + 0.5);
        this.wet2 = this.wet * ((1 - this.width) / 2);

        if (this.mode >= ReverbTunings.FreezeMode) {
            this.roomSize1 = 1;
            this.damp1 = 0;
            this.gain = ReverbTunings.Muted;
        } else {
            this.roomSize1 = this.roomSize;
            this.damp1 = this.damp;
            this.gain = ReverbTunings.FixedGain;
        }

        this.combL.forEach((comb) => {
            comb.setFeedback(this.roomSize1);
            comb.setDamp(this.damp1);
        });

        this.combR.forEach((comb) => {
            comb.setFeedback(this.roomSize1);
            comb.setDamp(this.damp1);
        });
    }

    // Getters and Setters
    public getRoomSize(): number {
        return (this.roomSize - ReverbTunings.OffsetRoom) / ReverbTunings.ScaleRoom;
    }

    public setRoomSize(value: number): void {
        this.roomSize = value * ReverbTunings.ScaleRoom + ReverbTunings.OffsetRoom;
        this.update();
    }

    public getDamp(): number {
        return this.damp / ReverbTunings.ScaleDamp;
    }

    public setDamp(value: number): void {
        this.damp = value * ReverbTunings.ScaleDamp;
        this.update();
    }

    public getWet(): number {
        return this.wet / ReverbTunings.ScaleWet;
    }

    public setWet(value: number): void {
        this.wet = value * ReverbTunings.ScaleWet;
        this.update();
    }

    public getDry(): number {
        return this.dry / ReverbTunings.ScaleDry;
    }

    public setDry(value: number): void {
        this.dry = value * ReverbTunings.ScaleDry;
    }

    public getWidth(): number {
        return this.width;
    }

    public setWidth(value: number): void {
        this.width = value;
        this.update();
    }

    public getMode(): number {
        return this.mode >= ReverbTunings.FreezeMode ? 1 : 0;
    }

    public setMode(value: number): void {
        this.mode = value;
        this.update();
    }
}
