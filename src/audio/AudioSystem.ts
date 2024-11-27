import { createAudioWorkletWithWasm } from 'src/audio/audio-processor-loader';

export default class AudioSystem {
    audioContext: AudioContext;
    constructor() {
        console.log('creating audio context');
        const audioCtxOptions: AudioContextOptions = {
            latencyHint: 'interactive',
            sampleRate: 48000,
        };
        this.audioContext = new AudioContext(audioCtxOptions);
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
                freq.linearRampToValueAtTime(1000, this.audioContext.currentTime + 5.0);
                freq.linearRampToValueAtTime(20, this.audioContext.currentTime + 10.0);
            }

            // Connect the worklet to the audio context
            workletNode.connect(this.audioContext.destination);
            console.log('Audio setup completed successfully');
        } catch (error) {
            console.error('Failed to set up audio:', error);
        }
    }


}
