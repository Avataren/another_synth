import Voice from './voice';

export default class Instrument {
  readonly num_voices = 8;
  voices: Array<Voice>;

  // Keep track of which notes are assigned to which voices
  private activeNotes: Map<number, number> = new Map(); // midi note -> voice index

  constructor(destination: AudioNode, audioContext: AudioContext) {
    this.voices = Array.from(
      { length: this.num_voices },
      () => new Voice(destination, audioContext),
    );
  }

  public note_on(midi_note: number, velocity: number) {
    // If note is already playing, trigger note off first
    if (this.activeNotes.has(midi_note)) {
      this.note_off(midi_note, 0);
    }

    // Find a free voice or steal one
    const voiceIndex = this.findFreeVoice();
    if (voiceIndex !== -1) {
      const voice = this.voices[voiceIndex];
      // Start the voice
      voice?.start(midi_note, velocity);
      // Keep track of the note assignment
      this.activeNotes.set(midi_note, voiceIndex);
    }
  }

  public note_off(midi_note: number, _velocity: number) {
    const voiceIndex = this.activeNotes.get(midi_note);
    if (voiceIndex !== undefined) {
      const voice = this.voices[voiceIndex];
      voice?.stop();
      this.activeNotes.delete(midi_note);
    }
  }

  private findFreeVoice(): number {
    // First try to find an inactive voice
    for (let i = 0; i < this.voices.length; i++) {
      if (!this.activeNotes.has(i)) {
        return i;
      }
    }

    // If no free voice, steal the oldest one
    // In this simple implementation, we'll just take the first one
    if (this.activeNotes.size > 0) {
      const firstNote = this.activeNotes.keys().next().value;
      if (firstNote) {
        const voiceIndex = this.activeNotes.get(firstNote)!;
        this.note_off(firstNote, 0);
        return voiceIndex;
      } else {
        return -1;
      }
    }

    return -1; // Should never happen with the above logic
  }
}
