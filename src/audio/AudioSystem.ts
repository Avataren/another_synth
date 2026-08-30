
const DEFAULT_SAMPLE_RATE = 96000;
/**
 * Where to go when the preferred rate is refused.
 *
 * 44.1 kHz is the one rate essentially every device runs natively, so it is
 * the safe floor rather than a second guess.
 */
const FALLBACK_SAMPLE_RATE = 44100;
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

/**
 * Build the context at the best rate the browser will accept.
 *
 * A rate an implementation will not run throws NotSupportedError from the
 * constructor, so this walks down: what was asked for, then 44.1 kHz, then
 * whatever the browser picks for itself. Producing audio at the wrong rate
 * beats producing none.
 */
function createAudioContext(preferred: number): AudioContext {
    const candidates: (number | undefined)[] = [
        preferred,
        preferred === FALLBACK_SAMPLE_RATE ? undefined : FALLBACK_SAMPLE_RATE,
        undefined,
    ];

    let lastError: unknown = null;
    for (const sampleRate of candidates) {
        try {
            const options: AudioContextOptions =
                sampleRate === undefined
                    ? { latencyHint: 'interactive' }
                    : { latencyHint: 'interactive', sampleRate };
            return new AudioContext(options);
        } catch (error) {
            lastError = error;
            console.warn(
                `[AudioSystem] sampleRate ${sampleRate ?? 'default'} refused, trying the next`,
                error,
            );
        }
    }
    // Every candidate ended with `undefined`, which cannot be refused for a
    // rate -- if even that threw, there is no audio to be had.
    throw lastError instanceof Error
        ? lastError
        : new Error('Could not create an AudioContext');
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
        this.audioContext = createAudioContext(readPreferredSampleRate());
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
