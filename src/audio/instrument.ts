import Voice from './voice';

export default class Instrument {
  readonly num_voices = 4;
  voices: Array<Voice>;
  outputNode: AudioNode;
  private activeNotes: Map<number, number> = new Map(); // midi note -> voice index

  constructor(
    destination: AudioNode,
    audioContext: AudioContext,
    memory: WebAssembly.Memory,
  ) {
    this.outputNode = audioContext.createGain();
    (this.outputNode as GainNode).gain.value = 1.0;
    this.outputNode.connect(destination);
    this.voices = Array.from(
      { length: this.num_voices },
      () => new Voice(this.outputNode, audioContext, memory),
    );
  }

  public note_on(midi_note: number, velocity: number) {
    //console.log('note_on ', midi_note);
    if (this.activeNotes.has(midi_note)) {
      this.note_off(midi_note);
    }

    const voiceIndex = this.findFreeVoice();
    if (voiceIndex !== -1) {
      //console.log('voiceIndex ', voiceIndex);
      const voice = this.voices[voiceIndex];
      voice?.start(midi_note, velocity);
      this.activeNotes.set(midi_note, voiceIndex);
    }
  }

  public note_off(midi_note: number) {
    //console.log('note_off ', midi_note);
    const voiceIndex = this.activeNotes.get(midi_note);
    if (voiceIndex !== undefined) {
      //console.log('ending voiceIndex ', voiceIndex);
      const voice = this.voices[voiceIndex];
      voice?.stop();
      this.activeNotes.delete(midi_note);
    }
  }

  private findFreeVoice(): number {
    // Find voices that aren't assigned to any active notes
    const usedVoiceIndices = new Set(this.activeNotes.values());
    for (let i = 0; i < this.voices.length; i++) {
      if (!usedVoiceIndices.has(i)) {
        return i;
      }
    }

    // If no free voice, steal the oldest one
    if (this.activeNotes.size > 0) {
      const firstNote = this.activeNotes.keys().next().value as number;
      const voiceIndex = this.activeNotes.get(firstNote)!;
      this.note_off(firstNote);
      return voiceIndex;
    }

    return -1;
  }
}
