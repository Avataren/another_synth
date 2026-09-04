/**
 * A `TrackerSink` that just plays the module.
 *
 * The second of the two implementations `./sink.ts` describes. Where this
 * app's `TrackerSongBank` carries a mixer, live patch editing, recording,
 * visualisation and a worklet pool, this carries one
 * `TrackerSamplerInstrument` per instrument and a master gain. That is the
 * whole of it, and it is the difference between 2,650 lines and this file.
 *
 * Feed it the `TrackerSample`s an importer produced:
 *
 * ```ts
 * const { samples, slotForInstrument } = buildModTrackerSamples(mod);
 * const sink = new StandaloneTrackerSink({ audioContext });
 * await sink.loadSamples(samples);
 * ```
 *
 * then wire the engine's `Scheduled*Handler`s into it and start the transport.
 */
import type {
  TrackerMacroRamp,
  TrackerRampMode,
  TrackerSink,
  TrackerVolumeRampMode,
} from './sink';
import type { TrackerSample } from './tracker-sample';
import type { PitchModel } from './pitch-model';
import { TrackerSamplerInstrument } from './sampler-instrument';
import { formatInstrumentId } from './instrument-ids';

export interface StandaloneTrackerSinkOptions {
  audioContext: AudioContext;
  /**
   * Where the master gain connects. Defaults to `audioContext.destination`.
   *
   * Supply something else to record the output, or to put the player inside a
   * larger graph.
   */
  destination?: AudioNode;
  /**
   * The song's pitch model, which decides how periods become frequencies.
   *
   * Only auto-vibrato reads it, but getting it wrong is audible: see
   * `TrackerSamplerInstrument.setPitchModel`. Pass
   * `profileForFormat(moduleFormat).pitch`.
   */
  pitchModel?: PitchModel;
}

/** What the sink remembers per instrument. */
interface LoadedInstrument {
  instrument: TrackerSamplerInstrument;
  /**
   * The voice each track most recently started a note on.
   *
   * Per-voice commands (portamento, volume slides, panning) name a
   * `voiceIndex`, but the engine numbers voices per *track* while the
   * instrument allocates them per instrument, and two channels can share one
   * instrument. This map is how a command finds the voice its channel
   * actually owns.
   */
  voiceForTrack: Map<number, number>;
}

export class StandaloneTrackerSink implements TrackerSink {
  readonly audioContext: AudioContext;

  private readonly masterGain: GainNode;
  private readonly instruments = new Map<string, LoadedInstrument>();
  private pitchModel: PitchModel | undefined;
  private songVolume = 1;

  constructor(options: StandaloneTrackerSinkOptions) {
    this.audioContext = options.audioContext;
    this.masterGain = this.audioContext.createGain();
    this.masterGain.gain.value = 1;
    this.masterGain.connect(options.destination ?? this.audioContext.destination);
    this.pitchModel = options.pitchModel;
  }

  /** The node every instrument feeds, for recording or further processing. */
  get outputNode(): AudioNode {
    return this.masterGain;
  }

  // --- loading ----------------------------------------------------------

  /**
   * Build an instrument per sample, addressed by its slot.
   *
   * Ids are the same zero-padded slot strings the importers put on rows, so
   * the steps a `PlaybackSong` carries address these directly.
   */
  async loadSamples(samples: readonly TrackerSample[]): Promise<void> {
    this.disposeInstruments();
    await Promise.all(
      samples.map(async (sample) => {
        // An OPL instrument has no PCM; it occupies a slot and plays nothing
        // until something can sound it.
        if (sample.opl) return;

        const instrument = new TrackerSamplerInstrument(
          this.masterGain,
          this.audioContext,
          this.pitchModel ? { pitchModel: this.pitchModel } : {},
        );
        await instrument.loadSample(sample);
        this.instruments.set(formatInstrumentId(sample.slot), {
          instrument,
          voiceForTrack: new Map(),
        });
      }),
    );
  }

  /**
   * Re-point every instrument at the song's pitch model.
   *
   * Safe to call after loading; the model is read at note-on.
   */
  setPitchModel(pitchModel: PitchModel): void {
    this.pitchModel = pitchModel;
    for (const { instrument } of this.instruments.values()) {
      instrument.setPitchModel(pitchModel);
    }
  }

  dispose(): void {
    this.disposeInstruments();
    this.masterGain.disconnect();
  }

  private disposeInstruments(): void {
    for (const { instrument } of this.instruments.values()) {
      instrument.dispose();
    }
    this.instruments.clear();
  }

  // --- lookup -----------------------------------------------------------

  private get(instrumentId: string | undefined): LoadedInstrument | undefined {
    if (!instrumentId) return undefined;
    return this.instruments.get(instrumentId);
  }

  /**
   * The voice a per-voice command means.
   *
   * Prefers the voice this track actually started its note on; falls back to
   * the index the engine supplied, which is right when the track has not been
   * seen yet.
   */
  private voiceFor(
    loaded: LoadedInstrument,
    voiceIndex: number,
    trackIndex: number,
  ): number {
    return loaded.voiceForTrack.get(trackIndex) ?? voiceIndex;
  }

  /** Times in the past mean "now": a late tick should still sound. */
  private at(time: number): number {
    return Math.max(time, this.audioContext.currentTime);
  }

  // --- TrackerSink ------------------------------------------------------

  get needsResume(): boolean {
    return this.audioContext.state !== 'running';
  }

  async ensureAudioContextRunning(): Promise<boolean> {
    const ctx = this.audioContext;
    if (ctx.state === 'running') return true;
    try {
      await ctx.resume();
    } catch {
      // A resume outside a user gesture is refused; the caller checks the
      // result rather than relying on this throwing.
    }
    // The cast is load-bearing: the early return narrowed `state` away from
    // 'running', and the compiler does not know `resume()` changes it.
    return (ctx.state as AudioContextState) === 'running';
  }

  /**
   * Nothing to do: `loadSamples` built every instrument up front.
   *
   * The interface has this because a host that loads lazily needs somewhere
   * to do it, not because every host must.
   */
  async prepareInstrument(_instrumentId?: string): Promise<void> {
    // Intentionally empty.
  }

  noteOnAtTime(
    instrumentId: string | undefined,
    midi: number,
    velocity: number,
    time: number,
    trackIndex?: number,
    frequency?: number,
    pan?: number,
    sampleOffsetFrames?: number,
    tickSeconds?: number,
  ): void {
    const loaded = this.get(instrumentId);
    if (!loaded) return;

    const voiceIndex = loaded.instrument.noteOnAtTime(
      midi,
      velocity,
      this.at(time),
      {
        ...(frequency !== undefined ? { frequency } : {}),
        ...(pan !== undefined ? { pan } : {}),
        ...(sampleOffsetFrames !== undefined ? { sampleOffsetFrames } : {}),
        ...(tickSeconds !== undefined ? { tickSeconds } : {}),
        ...(trackIndex !== undefined ? { trackIndex } : {}),
      },
    );

    if (voiceIndex !== undefined && trackIndex !== undefined) {
      loaded.voiceForTrack.set(trackIndex, voiceIndex);
    }
  }

  noteOffAtTime(
    instrumentId: string | undefined,
    midi: number | undefined,
    time: number,
    trackIndex?: number,
  ): void {
    const loaded = this.get(instrumentId);
    if (!loaded || midi === undefined) return;
    loaded.instrument.noteOffAtTime(midi, this.at(time), trackIndex);
  }

  retriggerNoteAtTime(
    instrumentId: string | undefined,
    midi: number,
    velocity: number,
    time: number,
    trackIndex?: number,
    frequency?: number,
  ): void {
    const loaded = this.get(instrumentId);
    if (!loaded) return;
    const at = this.at(time);

    // Cut the channel's current voice first: a retrigger restarts the note
    // rather than layering a second copy over it.
    if (trackIndex !== undefined) {
      const current = loaded.voiceForTrack.get(trackIndex);
      if (current !== undefined) {
        loaded.instrument.cutVoiceAtTime(current, at);
      }
    }

    this.noteOnAtTime(
      instrumentId,
      midi,
      velocity,
      at,
      trackIndex,
      frequency,
    );
  }

  noteOn(
    instrumentId: string | undefined,
    midi: number,
    velocity = 100,
    trackIndex?: number,
  ): void {
    this.noteOnAtTime(
      instrumentId,
      midi,
      velocity,
      this.audioContext.currentTime,
      trackIndex,
    );
  }

  noteOff(
    instrumentId: string | undefined,
    midi?: number,
    trackIndex?: number,
  ): void {
    this.noteOffAtTime(
      instrumentId,
      midi,
      this.audioContext.currentTime,
      trackIndex,
    );
  }

  setVoicePitchAtTime(
    instrumentId: string | undefined,
    voiceIndex: number,
    frequency: number,
    time: number,
    trackIndex: number,
    rampMode?: TrackerRampMode,
  ): void {
    const loaded = this.get(instrumentId);
    if (!loaded) return;
    loaded.instrument.setVoiceFrequencyAtTime(
      this.voiceFor(loaded, voiceIndex, trackIndex),
      frequency,
      this.at(time),
      rampMode,
    );
  }

  setVoiceVolumeAtTime(
    instrumentId: string | undefined,
    voiceIndex: number,
    volume: number,
    time: number,
    trackIndex: number,
    rampMode?: TrackerVolumeRampMode,
  ): void {
    const loaded = this.get(instrumentId);
    if (!loaded) return;
    loaded.instrument.setVoiceGainAtTime(
      this.voiceFor(loaded, voiceIndex, trackIndex),
      volume,
      this.at(time),
      rampMode,
    );
  }

  setVoicePanAtTime(
    instrumentId: string | undefined,
    voiceIndex: number,
    pan: number,
    time: number,
    trackIndex: number,
  ): void {
    const loaded = this.get(instrumentId);
    if (!loaded) return;
    // Macro 0 is the per-voice stereo pan, the same route the app's patches
    // reserve it for.
    loaded.instrument.setVoiceMacroAtTime(
      this.voiceFor(loaded, voiceIndex, trackIndex),
      0,
      pan,
      this.at(time),
    );
  }

  setVoiceSampleOffsetAtTime(
    instrumentId: string | undefined,
    voiceIndex: number,
    offset: number,
    time: number,
    trackIndex: number,
  ): void {
    const loaded = this.get(instrumentId);
    if (!loaded) return;
    // Macro 1 is the per-voice sample offset.
    loaded.instrument.setVoiceMacroAtTime(
      this.voiceFor(loaded, voiceIndex, trackIndex),
      1,
      offset,
      this.at(time),
    );
  }

  setVoiceEnvelopePositionAtTime(
    instrumentId: string | undefined,
    voiceIndex: number,
    tick: number,
    time: number,
    trackIndex: number,
  ): void {
    const loaded = this.get(instrumentId);
    if (!loaded) return;
    loaded.instrument.setEnvelopePositionAtTime(
      this.voiceFor(loaded, voiceIndex, trackIndex),
      tick,
      this.at(time),
    );
  }

  setInstrumentGain(
    instrumentId: string | undefined,
    gain: number,
    _time?: number,
  ): void {
    const loaded = this.get(instrumentId);
    if (!loaded) return;
    // The instrument's output gain is a plain AudioParam value rather than a
    // scheduled ramp; instrument gain changes are per-song, not per-tick.
    loaded.instrument.setInstrumentGain(gain);
  }

  setInstrumentMacro(
    instrumentId: string | undefined,
    macroIndex: number,
    value: number,
    _time?: number,
    _ramp?: TrackerMacroRamp,
  ): void {
    const loaded = this.get(instrumentId);
    if (!loaded) return;
    loaded.instrument.setMacro(macroIndex, value);
  }

  setMasterVolume(volume: number, time?: number): void {
    this.songVolume = Math.max(0, Math.min(1, volume));
    this.masterGain.gain.setValueAtTime(
      this.songVolume,
      time ?? this.audioContext.currentTime,
    );
  }

  notesOffForTrack(trackIndex: number): void {
    const now = this.audioContext.currentTime;
    for (const loaded of this.instruments.values()) {
      const voiceIndex = loaded.voiceForTrack.get(trackIndex);
      if (voiceIndex === undefined) continue;
      loaded.instrument.cutVoiceAtTime(voiceIndex, now);
      loaded.voiceForTrack.delete(trackIndex);
    }
  }

  allNotesOff(): void {
    for (const loaded of this.instruments.values()) {
      loaded.instrument.allNotesOff();
      loaded.voiceForTrack.clear();
    }
  }

  cutAllVoicesAtTime(time: number): void {
    const at = this.at(time);
    for (const loaded of this.instruments.values()) {
      for (const voiceIndex of loaded.voiceForTrack.values()) {
        loaded.instrument.cutVoiceAtTime(voiceIndex, at);
      }
      loaded.voiceForTrack.clear();
    }
  }

  cancelAllScheduled(): void {
    for (const loaded of this.instruments.values()) {
      loaded.instrument.cancelScheduledNotes();
    }
  }
}
