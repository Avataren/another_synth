import { createAudioWorkletWithWasm } from 'src/audio/audio-processor-loader';

export default class AudioSystem {
  audioContext: AudioContext;
  destinationNode: AudioNode;
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
      const workletNode = await createAudioWorkletWithWasm(this.audioContext);
      const freq = workletNode.parameters.get('frequency');
      if (freq) {
        freq.value = 20;
        freq.linearRampToValueAtTime(1000, this.audioContext.currentTime + 1.0);
        freq.linearRampToValueAtTime(20, this.audioContext.currentTime + 2.0);
      }

      const gain = workletNode.parameters.get('gain');
      if (gain) {
        gain.value = 0.0;
        gain.linearRampToValueAtTime(0.5, this.audioContext.currentTime + 1.0);
        gain.linearRampToValueAtTime(0.0, this.audioContext.currentTime + 2.0);
      }

      // Connect the worklet to the audio context
      workletNode.connect(this.destinationNode);
      console.log('Audio setup completed successfully');
    } catch (error) {
      console.error('Failed to set up audio:', error);
    }
  }
}
