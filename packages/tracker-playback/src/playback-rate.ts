/**
 * `calculatePlaybackRate`, moved out of `TrackerSamplerInstrument` (arch-review §2c).
 * The body is unchanged and still runs with the instrument as `this`.
 */
import type { TrackerSamplerConfig } from './tracker-sample';

export interface PlaybackRateHost {
  readonly samplerState: TrackerSamplerConfig | null;
  readonly oversampleFactor: number;
}

export function calculatePlaybackRate(
  this: PlaybackRateHost,
  frequency: number,
): number {
    if (!this.samplerState) {
      return 1.0;
    }

    // Calculate playback rate based on frequency relative to root note
    // frequency = root_frequency * 2^(semitones/12)
    // playbackRate = frequency / root_frequency

    const rootNote = this.samplerState.rootNote;
    const rootFrequency = 440 * Math.pow(2, (rootNote - 69) / 12);

    // Apply detune
    const detuneCents = this.samplerState.detune ?? 0;
    const detuneRatio = Math.pow(2, detuneCents / 1200);

    // Scaled for oversampling: the buffer holds `oversampleFactor` frames per
    // original frame at an unchanged declared rate, so it must be read that
    // much faster to sound at the written pitch.
    return (frequency / rootFrequency) * detuneRatio * this.oversampleFactor;
}
