
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
 * Which latency the context should be built for.
 *
 * `interactive` asks for the smallest buffer the device will give, which is
 * what a synth being played from a keyboard needs. Phones and tablets do not
 * have the headroom for it: the same request there produces buffer underruns,
 * heard as clicks and dropouts, and the tracker is being *played back* on
 * those devices far more often than it is being played *on*. `playback` asks
 * for a larger buffer and trades input latency nobody is using for output
 * that does not glitch.
 *
 * Deliberately not `useMobileLayout`. That signal follows the *window*, by
 * design -- narrow a desktop browser and it reports mobile -- and this
 * decision is fixed for the life of the context, so a desktop user who
 * happened to start with a narrow window would be stuck with playback latency
 * until they reloaded. A coarse pointer with no hover is the device itself:
 * phones and tablets match, and a touchscreen laptop does not, because it
 * also has a mouse.
 *
 * Unknown means desktop. jsdom and SSR have no `matchMedia`, and guessing
 * mobile there would give the tests and the dev server a latency the app
 * never uses.
 */
export function preferredLatencyHint(): AudioContextLatencyCategory {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return 'interactive';
    }
    return window.matchMedia('(pointer: coarse) and (hover: none)').matches
        ? 'playback'
        : 'interactive';
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

    const latencyHint = preferredLatencyHint();
    console.log(`[AudioSystem] latencyHint: ${latencyHint}`);

    let lastError: unknown = null;
    for (const sampleRate of candidates) {
        try {
            const options: AudioContextOptions =
                sampleRate === undefined
                    ? { latencyHint }
                    : { latencyHint, sampleRate };
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
