// import { OscillatorUpdateParams } from 'app/public/wasm/audio_processor';
import { createStandardAudioWorklet } from './audio-processor-loader';
import { type EnvelopeConfig } from './dsp/envelope';
import { type FilterState } from './dsp/filter-state';
import { type NoiseState } from './dsp/noise-generator';
import type OscillatorState from './models/OscillatorState';

export default class Instrument {
  readonly num_voices = 8;
  outputNode: AudioNode;
  workletNode: AudioWorkletNode | null = null;
  private activeNotes: Map<number, number> = new Map(); // midi note -> voice index
  private voiceLastUsedTime: number[] = []; // Track when each voice was last used
  private ready = false;

  constructor(
    destination: AudioNode,
    private audioContext: AudioContext,
    memory: WebAssembly.Memory,
  ) {
    this.outputNode = audioContext.createGain();
    (this.outputNode as GainNode).gain.value = 0.25;
    this.outputNode.connect(destination);
    this.voiceLastUsedTime = new Array(this.num_voices).fill(0);
    this.setupAudio(memory);
  }

  private async setupAudio(_memory: WebAssembly.Memory) {
    try {
      this.workletNode = await createStandardAudioWorklet(this.audioContext);

      // Set up parameters for each voice
      for (let i = 0; i < this.num_voices; i++) {
        const gateParam = this.workletNode.parameters.get(`gate_${i}`);
        if (gateParam) gateParam.value = 0;

        const freqParam = this.workletNode.parameters.get(`frequency_${i}`);
        if (freqParam) freqParam.value = 440;

        const gainParam = this.workletNode.parameters.get(`gain_${i}`);
        if (gainParam) gainParam.value = 1;
      }

      this.workletNode.connect(this.outputNode);
      this.ready = true;
      console.log('Audio setup completed successfully');
    } catch (error) {
      console.error('Failed to set up audio:', error);
    }
  }

  public updateNoiseState(newState: NoiseState) {
    this.workletNode?.port.postMessage({
      type: 'updateNoise',
      newState,
    });
  }

  public updateOscillatorState(oscillatorId: number, newState: OscillatorState) {
    this.workletNode?.port.postMessage({
      type: 'updateOscillator',
      oscillatorId,
      newState,
    });
  }

  public updateEnvelopeState(key: number, newState: EnvelopeConfig) {
    this.workletNode?.port.postMessage({
      type: 'updateEnvelope',
      voice_index: key,
      config: newState,
    });
  }

  public updateFilterState(key: number, newState: FilterState) {
    this.workletNode?.port.postMessage({
      type: 'updateFilter',
      voice_index: key,
      config: newState,
    });
  }

  public note_on(midi_note: number, velocity: number) {
    if (!this.ready || !this.workletNode) return;

    if (this.activeNotes.has(midi_note)) {
      this.note_off(midi_note);
    }

    const voiceIndex = this.findFreeVoice();
    if (voiceIndex !== -1) {
      const frequency = this.midiNoteToFrequency(midi_note);

      // Update parameters for the selected voice
      const freqParam = this.workletNode.parameters.get(
        `frequency_${voiceIndex}`,
      );
      const gateParam = this.workletNode.parameters.get(`gate_${voiceIndex}`);
      const gainParam = this.workletNode.parameters.get(`gain_${voiceIndex}`);

      if (freqParam && gateParam && gainParam) {
        freqParam.setValueAtTime(frequency, this.audioContext.currentTime);
        gateParam.setValueAtTime(0.0, this.audioContext.currentTime);
        gateParam.setValueAtTime(1.0, this.audioContext.currentTime + 0.005);
        gainParam.setValueAtTime(velocity / 127, this.audioContext.currentTime);
      }

      this.activeNotes.set(midi_note, voiceIndex);
      this.voiceLastUsedTime[voiceIndex] = performance.now();
    }
  }

  public note_off(midi_note: number) {
    if (!this.ready || !this.workletNode) return;

    const voiceIndex = this.activeNotes.get(midi_note);
    if (voiceIndex !== undefined) {
      const gateParam = this.workletNode.parameters.get(`gate_${voiceIndex}`);
      if (gateParam) {
        gateParam.setValueAtTime(0.0, this.audioContext.currentTime);
      }
      this.activeNotes.delete(midi_note);
    }
  }

  private findFreeVoice(): number {
    // Get list of used voice indices
    const usedVoiceIndices = new Set(this.activeNotes.values());

    // Find the oldest free voice
    let oldestFreeVoiceIndex = -1;
    let oldestFreeVoiceTime = Infinity;

    for (let i = 0; i < this.num_voices; i++) {
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

  private midiNoteToFrequency(note: number): number {
    return 440 * Math.pow(2, (note - 69) / 12);
  }
}
