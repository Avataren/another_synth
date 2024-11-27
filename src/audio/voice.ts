import { createAudioWorkletWithWasm } from './audio-processor-loader';

export default class Voice {
  private active: boolean = false;
  private currentNote: number = 0;
  workletNode: AudioWorkletNode | null = null;

  destination: AudioNode;
  audioContext: AudioContext;

  constructor(destination: AudioNode, audioContext: AudioContext) {
    this.destination = destination;
    this.audioContext = audioContext;
    this.setupAudio();
  }

  private async setupAudio() {
    try {
      // Create the AudioWorklet
      this.workletNode = await createAudioWorkletWithWasm(this.audioContext);

      const gain = this.workletNode.parameters.get('gain');
      if (gain) {
        gain.value = 0.0;
      }

      // Connect the worklet to the audio context
      this.workletNode.connect(this.destination);
      console.log('Audio setup completed successfully');
    } catch (error) {
      console.error('Failed to set up audio:', error);
    }
  }

  public get output() {
    return null;
  }

  public start(midi_note: number, _velocity: number) {
    this.active = true;
    this.currentNote = midi_note;
    // todo: actual sound generation code, trigger envelopes etc
  }

  public stop() {
    this.active = false;
    // todo:  handle release logic
  }

  public isActive(): boolean {
    return this.active;
  }

  public getCurrentNote(): number {
    return this.currentNote;
  }
}
