import { createAudioWorkletWithWasm } from 'src/audio/audio-processor-loader';
import { useKeyboardStore } from 'src/stores/keyboard-store';
import { watch } from 'vue';

export default class AudioSystem {
  audioContext: AudioContext;
  destinationNode: AudioNode;
  workletNode: AudioWorkletNode | null = null;
  constructor() {
    console.log('creating audio context');
    const audioCtxOptions: AudioContextOptions = {
      latencyHint: 'interactive',
      sampleRate: 48000,
    };
    this.audioContext = new AudioContext(audioCtxOptions);
    this.destinationNode = this.audioContext.createGain();
    this.destinationNode.connect(this.audioContext.destination);
    this.resumeOnUserInteraction();
    this.setupKeyboardListener();
  }

  private resumeOnUserInteraction() {
    const resumeAudio = () => {
      if (this.audioContext.state !== 'running') {
        this.audioContext
          .resume()
          .then(() => {
            console.log('AudioContext resumed');
            // Remove event listeners once resumed
            this.removeInteractionListeners(resumeAudio);
          })
          .catch((err) => console.error('AudioContext failed to resume:', err));
      }
    };

    // Add listeners for various user interactions
    const eventTypes = ['click', 'keydown', 'touchstart'];
    for (const eventType of eventTypes) {
      window.addEventListener(eventType, resumeAudio);
    }
  }

  private removeInteractionListeners(callback: EventListener) {
    const eventTypes = ['click', 'keydown', 'touchstart'];
    for (const eventType of eventTypes) {
      window.removeEventListener(eventType, callback);
    }
  }

  public async setupAudio() {
    try {
      // Create the AudioWorklet
      this.workletNode = await createAudioWorkletWithWasm(this.audioContext);

      const gain = this.workletNode.parameters.get('gain');
      if (gain) {
        gain.value = 0.0;
      }

      // Connect the worklet to the audio context
      this.workletNode.connect(this.destinationNode);
      console.log('Audio setup completed successfully');
    } catch (error) {
      console.error('Failed to set up audio:', error);
    }
  }

  private setupKeyboardListener() {
    const keyboardStore = useKeyboardStore();

    watch(
      () => keyboardStore.noteEvents,
      (events) => {
        if (!events.length || !this.workletNode) return;

        const latestEvent = events[events.length - 1];
        if (!latestEvent) return;

        const frequency = this.midiNoteToFrequency(latestEvent.note);
        const gain = latestEvent.velocity / 127;

        // Update audio parameters
        const freqParam = this.workletNode.parameters.get('frequency');
        const gainParam = this.workletNode.parameters.get('gain');

        if (freqParam && gainParam) {
          freqParam.setValueAtTime(frequency, this.audioContext.currentTime);
          gainParam.setValueAtTime(gain, this.audioContext.currentTime);
        }
      },
      { deep: true },
    );
  }

  private midiNoteToFrequency(note: number): number {
    return 440 * Math.pow(2, (note - 69) / 12);
  }
}
