import { createStandardAudioWorklet } from './audio-processor-loader';
import { type EnvelopeConfig } from './dsp/envelope';
import { type FilterState } from 'src/audio/dsp/filter-state';
import { type OscillatorState } from './wavetable/wavetable-oscillator';
import { type NoiseState } from './dsp/noise-generator';

export default class Voice {
  private active: boolean = false;
  private currentNote: number = 0;
  workletNode: AudioWorkletNode | null = null;

  destination: AudioNode;
  audioContext: AudioContext;

  constructor(destination: AudioNode, audioContext: AudioContext, memory: WebAssembly.Memory) {
    this.destination = destination;
    this.audioContext = audioContext;
    this.setupAudio(memory);
  }

  public updateNoiseState(newState: NoiseState) {
    try {
      this.workletNode?.port?.postMessage({
        type: 'updateNoise',
        newState
      });
    }
    catch (ex) {
      console.warn(ex, newState);
    }
  }

  public updateOscillatorState(key: number, newState: OscillatorState) {
    try {
      this.workletNode?.port?.postMessage({
        type: 'updateOscillator',
        key,
        newState
      });
    }
    catch (ex) {
      console.warn(ex);
    }
  }

  private async setupAudio(_memory: WebAssembly.Memory) {
    try {
      // Create the AudioWorklet
      console.log('trying to make synth worklet');
      this.workletNode = await createStandardAudioWorklet(this.audioContext);
      // Connect the worklet to the audio context
      this.workletNode.connect(this.destination);
      console.log('Audio setup completed successfully');
    } catch (error) {
      console.error('Failed to set up audio:', error);
    }
  }

  public updateEnvelopeState(id: number, config: EnvelopeConfig) {
    this.workletNode?.port.postMessage({
      type: 'updateEnvelope',
      id,
      config
    });
  }

  public updateFilterState(id: number, config: FilterState) {
    this.workletNode?.port.postMessage({
      type: 'updateFilter',
      id,
      newState: config
    });
  }

  public get output() {
    return null;
  }

  public start(midi_note: number, _velocity: number) {
    this.active = true;
    this.currentNote = midi_note;

    const frequency = this.midiNoteToFrequency(midi_note);
    const frequencyParam = this.workletNode?.parameters.get('frequency');
    if (frequencyParam) {
      frequencyParam.value = frequency;
    }
    const gateParam = this.workletNode?.parameters.get('gate');
    if (gateParam) {
      gateParam.setValueAtTime(0.0, this.audioContext.currentTime);
      gateParam.setValueAtTime(1.0, this.audioContext.currentTime + 0.0001);
    }
  }

  public stop() {
    this.active = false;
    const gateParam = this.workletNode?.parameters.get('gate');
    if (gateParam) {
      gateParam.value = 0.0;
    }

  }

  public isActive(): boolean {
    return this.active;
  }

  public getCurrentNote(): number {
    return this.currentNote;
  }

  private midiNoteToFrequency(note: number): number {
    return 440 * Math.pow(2, (note - 69) / 12);
  };

}
