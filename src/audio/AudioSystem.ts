
const DEFAULT_SAMPLE_RATE = 48000;
const SETTINGS_STORAGE_KEY = 'synth-user-settings';

/**
 * The sample rate the user asked for, or the default.
 *
 * Bounded to what the Web Audio spec requires implementations to support, so a
 * corrupt or hand-edited settings blob cannot leave the app with no audio.
 */
function readPreferredSampleRate(): number {
    try {
        const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
        if (!raw) return DEFAULT_SAMPLE_RATE;
        const parsed = JSON.parse(raw) as { audioSampleRate?: unknown };
        const rate = parsed?.audioSampleRate;
        if (typeof rate !== 'number' || !Number.isFinite(rate)) {
            return DEFAULT_SAMPLE_RATE;
        }
        if (rate < 8000 || rate > 192000) return DEFAULT_SAMPLE_RATE;
        return rate;
    } catch {
        return DEFAULT_SAMPLE_RATE;
    }
}

export default class AudioSystem {
    audioContext: AudioContext;
    destinationNode: AudioNode;
    workletNode: AudioWorkletNode | null = null;
    constructor() {
        console.log('creating audio context');
        // Read straight from storage rather than from the settings store: this
        // runs while the audio singleton is being built, before Pinia is
        // necessarily available, and the value is needed exactly once.
        const sampleRate = readPreferredSampleRate();
        const audioCtxOptions: AudioContextOptions = {
            latencyHint: 'interactive',
            sampleRate,
        };
        try {
            this.audioContext = new AudioContext(audioCtxOptions);
        } catch (error) {
            // A rate the implementation will not accept throws NotSupportedError.
            // Falling back is better than failing to produce any audio at all.
            console.warn(
                `[AudioSystem] sampleRate ${sampleRate} rejected, using the default`,
                error,
            );
            this.audioContext = new AudioContext({ latencyHint: 'interactive' });
        }
        console.log('audio context rate:', this.audioContext.sampleRate);
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
