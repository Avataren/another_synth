import { createStandardAudioWorklet } from './audio-processor-loader';
import { type EnvelopeConfig } from './dsp/envelope';
import { type OscillatorState } from './wavetable/wavetable-oscillator';

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
      this.workletNode = await createStandardAudioWorklet(this.audioContext);

      this.updateEnvelope(0, {
        attack: 0.00,
        decay: 0.0035,
        sustain: 0.0,
        release: 0.0,
        attackCurve: 0.0,
        decayCurve: 0.0,
        releaseCurve: 0.0
      })

      // Connect the worklet to the audio context
      this.workletNode.connect(this.destination);
      console.log('Audio setup completed successfully');
    } catch (error) {
      console.error('Failed to set up audio:', error);
    }
  }

  public updateEnvelope(id: number, config: EnvelopeConfig) {
    this.workletNode?.port.postMessage({
      type: 'updateEnvelope',
      id,
      config
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
      gateParam.value = 1.0;
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
