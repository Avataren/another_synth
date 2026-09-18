import type {
  TrackerMacroRamp,
  TrackerRampMode,
  TrackerSink,
  TrackerVolumeRampMode,
} from '@another-synth/tracker-playback';
import type { AhxPlayerClient } from 'src/audio/tracker/ahx-player';

/**
 * `TrackerSink` over the AHX worklet.
 *
 * The shape is `StandaloneTrackerSink`'s -- small, no mixer, no recording --
 * but the division of labour is not: the Rust `AhxEngine` runs its own
 * transport (bit-exact against the C reference), so the sink's note and
 * per-voice automation methods have nothing to do and are no-ops. Nothing
 * schedules notes *into* this sink, and if something did, the engine would not
 * hear it: AHX instruments are waveform/envelope/filter/PList descriptors
 * inside the song, not slots this app addresses. What the sink does carry is
 * the transport lifecycle and the master level:
 *
 *  - `setMasterVolume` -> the client's output gain, sample-accurately;
 *  - `allNotesOff` / `cutAllVoicesAtTime` / `cancelAllScheduled` -> pause.
 *    These are the stop-the-song calls of the interface, and for an engine
 *    that owns its voices "silence everything" and "stop" are the same act.
 *
 * `setVoiceSampleOffsetAtTime` (PT 9xx) is meaningless here, as
 * architecture-map.md predicted.
 */
export class AhxTrackerSink implements TrackerSink {
  constructor(private readonly player: AhxPlayerClient) {}

  get audioContext(): AudioContext {
    return this.player.audioContext;
  }

  get needsResume(): boolean {
    return this.audioContext.state !== 'running';
  }

  async ensureAudioContextRunning(): Promise<boolean> {
    const ctx = this.audioContext;
    if (ctx.state === 'running') return true;
    try {
      await ctx.resume();
    } catch {
      // Refused outside a user gesture; the caller checks the result.
    }
    return (ctx.state as AudioContextState) === 'running';
  }

  /** Nothing to prepare: the instruments live inside the loaded song. */
  async prepareInstrument(_instrumentId?: string): Promise<void> {}

  // --- notes: the engine plays its own -----------------------------------

  noteOnAtTime(
    _instrumentId: string | undefined,
    _midi: number,
    _velocity: number,
    _time: number,
    _trackIndex?: number,
    _frequency?: number,
    _pan?: number,
    _sampleOffsetFrames?: number,
    _tickSeconds?: number,
  ): void {}

  noteOffAtTime(
    _instrumentId: string | undefined,
    _midi: number | undefined,
    _time: number,
    _trackIndex?: number,
  ): void {}

  retriggerNoteAtTime(
    _instrumentId: string | undefined,
    _midi: number,
    _velocity: number,
    _time: number,
    _trackIndex?: number,
    _frequency?: number,
  ): void {}

  noteOn(
    _instrumentId: string | undefined,
    _midi: number,
    _velocity?: number,
    _trackIndex?: number,
  ): void {}

  noteOff(
    _instrumentId: string | undefined,
    _midi?: number,
    _trackIndex?: number,
  ): void {}

  // --- per-voice automation: likewise ------------------------------------

  setVoicePitchAtTime(
    _instrumentId: string | undefined,
    _voiceIndex: number,
    _frequency: number,
    _time: number,
    _trackIndex: number,
    _rampMode?: TrackerRampMode,
  ): void {}

  setVoiceVolumeAtTime(
    _instrumentId: string | undefined,
    _voiceIndex: number,
    _volume: number,
    _time: number,
    _trackIndex: number,
    _rampMode?: TrackerVolumeRampMode,
  ): void {}

  setVoicePanAtTime(
    _instrumentId: string | undefined,
    _voiceIndex: number,
    _pan: number,
    _time: number,
    _trackIndex: number,
  ): void {}

  setVoiceSampleOffsetAtTime(
    _instrumentId: string | undefined,
    _voiceIndex: number,
    _offset: number,
    _time: number,
    _trackIndex: number,
  ): void {}

  setVoiceEnvelopePositionAtTime(
    _instrumentId: string | undefined,
    _voiceIndex: number,
    _tick: number,
    _time: number,
    _trackIndex: number,
  ): void {}

  // --- per-instrument and global -----------------------------------------

  setInstrumentGain(
    _instrumentId: string | undefined,
    _gain: number,
    _time?: number,
  ): void {}

  setInstrumentMacro(
    _instrumentId: string | undefined,
    _macroIndex: number,
    _value: number,
    _time?: number,
    _ramp?: TrackerMacroRamp,
  ): void {}

  setMasterVolume(volume: number, time?: number): void {
    const param = this.player.output.gain;
    const value = Math.max(0, volume);
    if (time === undefined || time <= this.audioContext.currentTime) {
      param.setValueAtTime(value, this.audioContext.currentTime);
    } else {
      param.setValueAtTime(value, time);
    }
  }

  // --- transport lifecycle -----------------------------------------------

  /** A single channel cannot be silenced: the engine owns its four voices. */
  notesOffForTrack(_trackIndex: number): void {}

  allNotesOff(): void {
    this.player.pause();
  }

  cutAllVoicesAtTime(_time: number): void {
    this.player.pause();
  }

  cancelAllScheduled(): void {
    this.player.pause();
  }
}
