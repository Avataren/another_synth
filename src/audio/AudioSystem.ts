
import {
  AmigaLpfStage,
  PostFxRack,
  registerPostFxRack,
} from '@another-synth/tracker-playback';
import { defaultAudioSampleRate } from './device-profile';

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
    // The device's own default, used whenever the settings blob has nothing
    // usable to say. See device-profile: a phone asks for 48 kHz, which is
    // what its hardware runs at, rather than 96 kHz plus a resampler.
    const deviceDefault = defaultAudioSampleRate();
    try {
        const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
        if (!raw) return deviceDefault;
        const parsed = JSON.parse(raw) as { audioSampleRate?: unknown };
        const rate = parsed?.audioSampleRate;
        if (typeof rate !== 'number' || !Number.isFinite(rate)) {
            return deviceDefault;
        }
        if (rate < 8000 || rate > 192000) return deviceDefault;
        return rate;
    } catch {
        return deviceDefault;
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
    /**
     * The post-fx rack every speaker-bound signal passes through, and the
     * stage id the UI addresses (D114/D117). Built here because this is the
     * app's only speaker feed; recorder taps use `postFxOutput` so captures
     * are what-you-hear.
     */
    postFxRack: PostFxRack;
    postFxLpfStage: AmigaLpfStage;
    /** Waiters released when the context reaches `running`. */
    private runningWaiters = new Set<() => void>();
    /** Cached `whenRunning()` promise (idempotent while it is still waiting). */
    private whenRunningPromise: Promise<void> | null = null;
    constructor() {
        console.log('creating audio context');
        // Read straight from storage rather than from the settings store: this
        // runs while the audio singleton is being built, before Pinia is
        // necessarily available, and the value is needed exactly once.
        this.audioContext = createAudioContext(readPreferredSampleRate());
        console.log('audio context rate:', this.audioContext.sampleRate);
        this.destinationNode = this.audioContext.createGain();
        (this.destinationNode as GainNode).gain.value = 1.0;
        // destinationNode -> rack -> speakers. Everything that ever connects
        // to destinationNode (tracker bank master gain, patch editor
        // instruments) therefore plays through the rack.
        this.postFxRack = new PostFxRack(this.audioContext);
        this.postFxLpfStage = new AmigaLpfStage(this.audioContext);
        this.postFxRack.registerStage(this.postFxLpfStage);
        this.destinationNode.connect(this.postFxRack.input);
        this.postFxRack.output.connect(this.audioContext.destination);
        registerPostFxRack({ rack: this.postFxRack, amigaLpf: this.postFxLpfStage });
        this.resumeOnUserInteraction();
    }

    /** What playback really sounds like through -- the rack output. */
    get postFxOutput(): AudioNode {
        return this.postFxRack.output;
    }

    /**
     * Resolves once the audio context reaches `running`.
     *
     * Resolves immediately when the context is already running (desktop, or
     * anything after the first gesture); otherwise it resolves on
     * `statechange` reporting `running` or when the gesture-driven
     * `resume()` succeeds. Never awaits a bare `resume()` call: on a fresh
     * iOS/Safari tab that promise stays pending forever without a gesture
     * (see useTrackerFileIO.applySongFile's comment). A `closed` context
     * bails out too -- callers treat resolution as "stop waiting", not as a
     * guarantee of audio.
     */
    whenRunning(): Promise<void> {
        if (this.audioContext.state === 'running') {
            return Promise.resolve();
        }
        if (!this.whenRunningPromise) {
            this.whenRunningPromise = this.createWhenRunningPromise();
        }
        return this.whenRunningPromise;
    }

    private createWhenRunningPromise(): Promise<void> {
        return new Promise<void>((resolve) => {
            let settled = false;
            const settle = () => {
                if (settled) return;
                settled = true;
                this.runningWaiters.delete(settle);
                this.audioContext.removeEventListener(
                    'statechange',
                    onStateChange
                );
                // A bail-out (closed context, or resolved through the resume
                // hook while state reads non-running) must not pin the cache:
                // a later call should re-evaluate the live state.
                if (this.audioContext.state !== 'running') {
                    this.whenRunningPromise = null;
                }
                resolve();
            };
            const onStateChange = () => {
                const state = this.audioContext.state;
                if (state === 'running' || state === 'closed') {
                    this.notifyRunning();
                }
            };
            // Check-then-subscribe with a re-check: a resume between the
            // first state read and the listener attach must not strand us.
            if (this.audioContext.state === 'running') {
                resolve();
                return;
            }
            this.audioContext.addEventListener('statechange', onStateChange);
            this.runningWaiters.add(settle);
            // Fresh read through a full-union helper: the narrowed union from
            // the first check must not leak into the re-check.
            const readState = (): AudioContextState => this.audioContext.state;
            if (readState() === 'running') {
                this.notifyRunning();
            }
        });
    }

    /** Release every `whenRunning()` waiter. Called on resume success. */
    private notifyRunning(): void {
        for (const waiter of [...this.runningWaiters]) {
            waiter();
        }
        this.runningWaiters.clear();
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
                        this.notifyRunning();
                    })
                    .catch((err) => console.error('AudioContext failed to resume:', err));
            } else {
                // Something else resumed the context before this gesture
                // landed; release waiters and drop the now-useless listeners.
                this.removeInteractionListeners(resumeAudio);
                this.notifyRunning();
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
