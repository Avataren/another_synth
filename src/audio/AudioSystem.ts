
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
        (this.destinationNode as GainNode).gain.value = 1.0;
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
}
