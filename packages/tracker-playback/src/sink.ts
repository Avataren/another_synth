/**
 * The sound source a scheduled song is played through.
 *
 * The engine stops at "note on, track 3, at t=1.2s" -- see the
 * `Scheduled*Handler` types in ./types, which are how those events are
 * delivered. This is the other side of that: the object a host wires those
 * handlers into, and the whole surface the transport needs from it.
 *
 * Two implementations are intended, not one. This app's `TrackerSongBank`
 * carries the mixer, live patch editing, recording and visualisation the
 * editor needs; a standalone player wants none of that and can be a few
 * hundred lines over `ModInstrument`. Naming the surface is what lets the
 * second exist.
 *
 * ## Conventions
 *
 * `instrumentId` is the zero-padded slot string (see ./instrument-ids), and is
 * typed `string | undefined` throughout because that is what a row carries: a
 * step with no instrument resolves to nothing, and every method treats it as a
 * no-op rather than making the caller guard.
 *
 * `time` is in `AudioContext.currentTime` seconds. A time in the past means
 * "as soon as possible", not "skip"; implementations clamp rather than drop,
 * because a late tick should still sound.
 *
 * `trackIndex` identifies the channel the command came from. A tracker channel
 * is monophonic and owns its voice, so the pair (instrumentId, trackIndex) is
 * what actually addresses a voice -- `voiceIndex` alone is not enough when two
 * channels play the same instrument.
 */
import type { InstrumentResolver } from './types';

/** How a value moves to its target when a command schedules a change. */
export type TrackerRampMode = 'linear' | 'exponential';

/** As `TrackerRampMode`, plus the instant jump volume commands need. */
export type TrackerVolumeRampMode = TrackerRampMode | 'step';

/** A macro ramp: where to end up, and when. */
export interface TrackerMacroRamp {
  targetValue: number;
  targetTime: number;
  interpolation?: TrackerRampMode;
}

/**
 * Everything the transport and the scheduled-event handlers need from a sound
 * source.
 *
 * Implementations may do far more than this -- `TrackerSongBank` has 36 public
 * methods -- but nothing outside this interface is reachable from playback.
 */
export interface TrackerSink {
  /** The context whose clock `time` arguments are expressed in. */
  readonly audioContext: AudioContext;

  /**
   * True when the context is suspended and needs a user gesture to resume.
   *
   * Browsers block audio until the page has been interacted with, and a
   * transport that starts anyway plays to silence while its clock advances.
   */
  readonly needsResume: boolean;

  /** Resolve to true once the context is running, attempting a resume first. */
  ensureAudioContextRunning(): Promise<boolean>;

  /**
   * Make an instrument ready to play, loading whatever it needs.
   *
   * Called before playback rather than at the first note: building a voice
   * costs more than one tick's worth of time, and doing it inside the
   * scheduling window makes the note late.
   */
  prepareInstrument(instrumentId?: string): Promise<void>;

  // --- notes ------------------------------------------------------------

  noteOnAtTime(
    instrumentId: string | undefined,
    midi: number,
    velocity: number,
    time: number,
    trackIndex?: number,
    frequency?: number,
    pan?: number,
    /**
     * Start offset into the sample in *frames* (ProTracker 9xx: param * 256).
     * Applied at voice start -- it cannot be set afterwards on a Web Audio
     * buffer source, so it has to arrive with the note rather than as
     * automation.
     */
    sampleOffsetFrames?: number,
    /** Tick duration in seconds, for tick-timed instrument envelopes. */
    tickSeconds?: number,
  ): void;

  noteOffAtTime(
    instrumentId: string | undefined,
    midi: number | undefined,
    time: number,
    trackIndex?: number,
  ): void;

  /**
   * Restart a sounding note (ProTracker Rxy / E9x).
   *
   * Distinct from note-off then note-on because the retrigger keeps the
   * channel's voice rather than allocating a new one.
   */
  retriggerNoteAtTime(
    instrumentId: string | undefined,
    midi: number,
    velocity: number,
    time: number,
    trackIndex?: number,
    frequency?: number,
  ): void;

  /** Immediate note-on, for auditioning outside the transport. */
  noteOn(
    instrumentId: string | undefined,
    midi: number,
    velocity?: number,
    trackIndex?: number,
  ): void;

  /** Immediate note-off, for auditioning outside the transport. */
  noteOff(
    instrumentId: string | undefined,
    midi?: number,
    trackIndex?: number,
  ): void;

  // --- per-voice automation ---------------------------------------------

  setVoicePitchAtTime(
    instrumentId: string | undefined,
    voiceIndex: number,
    frequency: number,
    time: number,
    trackIndex: number,
    rampMode?: TrackerRampMode,
  ): void;

  setVoiceVolumeAtTime(
    instrumentId: string | undefined,
    voiceIndex: number,
    volume: number,
    time: number,
    trackIndex: number,
    rampMode?: TrackerVolumeRampMode,
  ): void;

  setVoicePanAtTime(
    instrumentId: string | undefined,
    voiceIndex: number,
    pan: number,
    time: number,
    trackIndex: number,
  ): void;

  setVoiceSampleOffsetAtTime(
    instrumentId: string | undefined,
    voiceIndex: number,
    offset: number,
    time: number,
    trackIndex: number,
  ): void;

  /**
   * Jump an instrument envelope to a tick position (XM's Lxx).
   *
   * Position, not time: XM envelopes are indexed in ticks, and the effect
   * names the tick to resume from.
   */
  setVoiceEnvelopePositionAtTime(
    instrumentId: string | undefined,
    voiceIndex: number,
    tick: number,
    time: number,
    trackIndex: number,
  ): void;

  // --- per-instrument and global ----------------------------------------

  setInstrumentGain(
    instrumentId: string | undefined,
    gain: number,
    time?: number,
  ): void;

  setInstrumentMacro(
    instrumentId: string | undefined,
    macroIndex: number,
    value: number,
    time?: number,
    ramp?: TrackerMacroRamp,
  ): void;

  /** Song global volume, 0..1 (S3M's Vxx and the header's globalVol). */
  setMasterVolume(volume: number, time?: number): void;

  // --- transport lifecycle ----------------------------------------------

  /** Silence a single channel, e.g. when a track is muted mid-song. */
  notesOffForTrack(trackIndex: number): void;

  /** Silence everything, immediately. */
  allNotesOff(): void;

  /**
   * Cut every sounding voice at `time` (S3M/XM key-off-all, and stop).
   *
   * Distinct from `allNotesOff` in being scheduled rather than immediate.
   */
  cutAllVoicesAtTime(time: number): void;

  /**
   * Drop automation scheduled beyond now.
   *
   * The transport schedules ahead, so stopping leaves future ramps queued on
   * every voice; without this they play out over the silence.
   */
  cancelAllScheduled(): void;
}

/**
 * A sink's `prepareInstrument`, as the engine's `InstrumentResolver`.
 *
 * The engine asks for instruments by id as it schedules; this is the one-line
 * adapter every host would otherwise write.
 */
export function instrumentResolverFor(sink: TrackerSink): InstrumentResolver {
  return (instrumentId) => sink.prepareInstrument(instrumentId);
}
