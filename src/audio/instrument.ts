import { type EnvelopeConfig } from './dsp/envelope';
import { type FilterState } from './dsp/filter-state';
import { type NoiseState } from './dsp/noise-generator';
import { type OscillatorState } from './wavetable/wavetable-oscillator';
import Voice from './voice';

export default class Instrument {
  readonly num_voices = 8;
  voices: Array<Voice> | null = null;
  outputNode: AudioNode;
  effectsNode: AudioWorkletNode | null = null;
  private activeNotes: Map<number, number> = new Map(); // midi note -> voice index
  private voiceLastUsedTime: number[] = []; // Track when each voice was last used
  private ready = false;

  constructor(
    destination: AudioNode,
    audioContext: AudioContext,
    memory: WebAssembly.Memory,
  ) {
    this.outputNode = audioContext.createGain();
    (this.outputNode as GainNode).gain.value = 0.25;

    // Add analyzer to check actual levels
    // const analyzer = audioContext.createAnalyser();
    // analyzer.fftSize = 2048;
    // this.outputNode.connect(analyzer);
    // analyzer.connect(destination);

    // Debug monitoring
    // const dataArray = new Float32Array(analyzer.frequencyBinCount);
    // const checkLevels = () => {
    //   analyzer.getFloatTimeDomainData(dataArray);
    //   const max = Math.max(...dataArray.map(Math.abs));
    //   if (max > 0.8) {  // Check for near-clipping levels
    //     console.log('High signal level detected:', max);
    //   }
    //   requestAnimationFrame(checkLevels);
    // };
    // checkLevels();

    this.outputNode.connect(destination);
    this.voices = Array.from(
      { length: this.num_voices },
      () => new Voice(this.outputNode as AudioNode, audioContext, memory),
    );
    this.voiceLastUsedTime = new Array(this.num_voices).fill(0);
    this.effectsNode?.connect(this.outputNode);
  }

  public updateNoiseState(newState: NoiseState) {
    this.voices?.forEach((voice) => {
      voice.updateNoiseState(newState);
    });
  }

  public updateOscillatorState(key: number, newState: OscillatorState) {
    this.voices?.forEach((voice) => {
      voice.updateOscillatorState(key, newState);
    });
  }

  public updateEnvelopeState(key: number, newState: EnvelopeConfig) {
    this.voices?.forEach((voice) => {
      voice.updateEnvelopeState(key, newState);
    });
  }

  public updateFilterState(key: number, newState: FilterState) {
    this.voices?.forEach((voice) => {
      voice.updateFilterState(key, newState);
    });
  }

  public note_on(midi_note: number, velocity: number) {
    if (this.activeNotes.has(midi_note)) {
      this.note_off(midi_note);
    }

    const voiceIndex = this.findFreeVoice();
    if (voiceIndex !== -1) {
      const voice = this.voices![voiceIndex];
      voice?.start(midi_note, velocity);
      this.activeNotes.set(midi_note, voiceIndex);
      this.voiceLastUsedTime[voiceIndex] = performance.now();
    }
  }

  public note_off(midi_note: number) {
    const voiceIndex = this.activeNotes.get(midi_note);
    if (voiceIndex !== undefined) {
      const voice = this.voices![voiceIndex];
      voice?.stop();
      this.activeNotes.delete(midi_note);
    }
  }

  private findFreeVoice(): number {
    // Get list of used voice indices
    const usedVoiceIndices = new Set(this.activeNotes.values());

    // Find the oldest free voice
    let oldestFreeVoiceIndex = -1;
    let oldestFreeVoiceTime = Infinity;

    for (let i = 0; i < this.voices!.length; i++) {
      if (!usedVoiceIndices.has(i)) {
        if (this.voiceLastUsedTime[i]! < oldestFreeVoiceTime) {
          oldestFreeVoiceTime = this.voiceLastUsedTime[i]!;
          oldestFreeVoiceIndex = i;
        }
      }
    }

    // If we found a free voice, return it
    if (oldestFreeVoiceIndex !== -1) {
      return oldestFreeVoiceIndex;
    }

    // If no free voice is available, steal the oldest active voice
    let oldestActiveVoiceIndex = -1;
    let oldestActiveVoiceTime = Infinity;

    for (const voiceIndex of this.activeNotes.values()) {
      if (this.voiceLastUsedTime[voiceIndex]! < oldestActiveVoiceTime) {
        oldestActiveVoiceTime = this.voiceLastUsedTime[voiceIndex]!;
        oldestActiveVoiceIndex = voiceIndex;
      }
    }

    if (oldestActiveVoiceIndex !== -1) {
      // Find and release the note using this voice
      for (const [noteToRelease, voiceIndex] of this.activeNotes) {
        if (voiceIndex === oldestActiveVoiceIndex) {
          this.note_off(noteToRelease);
          break;
        }
      }
      return oldestActiveVoiceIndex;
    }

    return -1;
  }
}
