import type { WasmAudio } from 'app/public/wasm/wasm_audio_worklet';
import { createAudioWorkletWithWasm } from './audio-processor-loader';

export default class Voice {
  private active: boolean = false;
  private currentNote: number = 0;
  workletNode: WasmAudio | null = null;

  destination: AudioNode;
  audioContext: AudioContext;

  constructor(destination: AudioNode, audioContext: AudioContext) {
    console.log('voice ctor');
    this.destination = destination;
    this.audioContext = audioContext;
    this.setupAudio();
  }

  private async setupAudio() {
    try {
      console.log('voice::setupAudio');
      // Create the AudioWorklet
      this.workletNode = await createAudioWorkletWithWasm(this.audioContext);

      // Connect the worklet to the audio context
      this.workletNode?.connect(this.destination);
      console.log('Audio setup completed successfully');
    } catch (error) {
      console.error('Failed to set up audio:', error);
    }
  }

  public get output() {
    return null;
  }

  public start(midi_note: number, velocity: number) {
    this.active = true;
    this.currentNote = midi_note;

    const frequency = this.midiNoteToFrequency(midi_note);
    const frequencyParam = this.workletNode?.get_node().parameters.get('frequency');
    if (frequencyParam) {
      frequencyParam.value = frequency;
    }

    const gainParam = this.workletNode?.get_node().parameters.get('gain');
    if (gainParam) {
      gainParam.value = velocity / 127.0;
    }

    const gateParam = this.workletNode?.get_node().parameters.get('gate');
    if (gateParam) {
      gateParam.value = 1.0;
    }
    // todo: actual sound generation code, trigger envelopes etc
  }

  public stop() {
    this.active = false;
    const gateParam = this.workletNode?.get_node().parameters.get('gate');
    if (gateParam) {
      gateParam.value = 0.0;
    }

    //const gain = this.workletNode?.parameters.get('gain');
    // if (gain) {
    //   gain.value = 0.0;
    // }
    // todo:  handle release logic
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
