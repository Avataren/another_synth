import { type WaveTable, type WaveformType, WaveTableGenerator } from './wave-utils';
import { type WaveTableBank } from './wavetable-bank';

export class WaveTableOscillator {
    private phasor = 0.0;
    private phaseInc = 0.0;
    private phaseOfs = 0.5;
    private curWaveTable = 0;
    private currentWaveTables: WaveTable[] = [];
    private currentType: WaveformType;
    private sampleRate: number;

    constructor(
        private bank: WaveTableBank,
        initialType: WaveformType = 'sine',
        sampleRate = 44100
    ) {
        this.currentType = initialType;
        this.sampleRate = sampleRate;
        this.setWaveform(initialType);
    }

    setWaveform(type: WaveformType): void {
        this.currentWaveTables = this.bank.getWaveform(type);
        this.currentType = type;
        this.updateWaveTableSelector();
    }

    private setFrequency(frequency: number): void {
        this.phaseInc = WaveTableGenerator.freqToNormalized(frequency, this.sampleRate);
        this.updateWaveTableSelector();
    }

    setNote(note: number, detune: number = 0): void {
        const frequency = WaveTableGenerator.noteToFrequency(note, detune);
        this.setFrequency(frequency);
    }

    setSampleRate(sampleRate: number): void {
        this.sampleRate = sampleRate;
        // Recalculate phase increment for new sample rate
        if (this.phaseInc > 0) {
            const frequency = this.phaseInc * this.sampleRate;
            this.setFrequency(frequency);
        }
    }

    private updateWaveTableSelector(): void {
        let curWaveTable = 0;
        while (
            curWaveTable < this.currentWaveTables.length - 1 &&
            this.phaseInc >= this.currentWaveTables[curWaveTable]!.topFreq
        ) {
            ++curWaveTable;
        }
        this.curWaveTable = curWaveTable;
    }

    process(frequency: number): number {
        this.setFrequency(frequency);
        this.phasor += this.phaseInc;
        if (this.phasor >= 1.0) {
            this.phasor -= 1.0;
        }

        const waveTable = this.currentWaveTables[this.curWaveTable];
        const temp = this.phasor * waveTable!.waveTableLen;
        const intPart = Math.floor(temp);
        const fracPart = temp - intPart;
        const samp0 = waveTable!.waveTable[intPart];
        const samp1 = waveTable!.waveTable[intPart + 1];

        return samp0! + (samp1! - samp0!) * fracPart;
    }

    getWaveform(): WaveformType {
        return this.currentType;
    }

    getCurrentFrequency(): number {
        return this.phaseInc * this.sampleRate;
    }

}