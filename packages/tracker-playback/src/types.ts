export type TransportState = 'stopped' | 'playing' | 'paused';

/**
 * Which tracker format a song's playback semantics should follow.
 *
 * This is deliberately a property of the *song*, not an app-wide preference:
 * one session can have a ProTracker MOD and a FastTracker 2 XM open, and the
 * two disagree on enough behaviour (pitch model, effect memory, tick-0
 * semantics, default panning) that they cannot share one code path without
 * degrading both.
 *
 * 'native' means a song authored in this tracker, with no legacy quirks.
 *
 * See PLAN-module-format-support.md for the roadmap this belongs to.
 */
export type ModuleFormat = 'native' | 'protracker' | 'xm' | 's3m';

/**
 * Format assumed for songs saved before the format tag existed, when nothing
 * in the song suggests otherwise.
 */
export const DEFAULT_MODULE_FORMAT: ModuleFormat = 'native';

export interface Song {
  title: string;
  author: string;
  bpm: number;
  patterns: Pattern[];
  sequence: string[];
  /**
   * Which tracker's playback semantics to apply. Optional so callers that
   * predate the tag keep working; the engine falls back to
   * DEFAULT_MODULE_FORMAT.
   */
  moduleFormat?: ModuleFormat;
  /**
   * Ticks per row the song starts at, as tracker "speed" (the Fxx 01-1F
   * parameter). Absent means the tracker default of 6.
   *
   * XM carries this in its header and most modules use something other than 6
   * -- 3 is common -- so ignoring it plays the song at the wrong tempo even
   * though the BPM is right.
   */
  initialSpeed?: number;
  /**
   * XM only: whether the module header selected the linear frequency table.
   * XM carries this per file rather than per format -- roughly half of real
   * modules use the Amiga table -- so it cannot live in `moduleFormat`.
   * Absent means XM's own default, linear.
   */
  linearFrequency?: boolean;
  /**
   * S3M only: the per-file amiga-limits header flag (flags & 0x10), which
   * selects S3M_AMIGA_PROFILE. Same per-file-flag shape as
   * `linearFrequency`; absent means the default 64..32767 period range.
   */
  amigaLimits?: boolean;
  /**
   * The song's initial global volume, 0..1 (S3M's header `globalVol`, 0..64,
   * divided by 64). Absent means full volume, what every other format does
   * and what the engine resets to. Feeds the same `songGlobalVolume`
   * machinery the Gxx/Hxy commands drive (D72).
   */
  initialGlobalVolume?: number;
}

export interface Pattern {
  id: string;
  length: number; // rows
  tracks: Track[];
}

export interface Track {
  id: string;
  instrumentId?: string;
  steps: Step[];
}

/**
 * FastTracker 2-style effect command types
 */
export type EffectType =
  | 'arpeggio'       // 0xy - Cycle through note, note+x, note+y semitones
  | 'portaUp'        // 1xx - Slide pitch up by xx units per tick
  | 'portaDown'      // 2xx - Slide pitch down by xx units per tick
  | 'tonePorta'      // 3xx - Slide to note at speed xx
  | 'vibrato'        // 4xy - Vibrato with speed x, depth y
  | 'tonePortaVol'   // 5xy - Tone portamento + volume slide
  | 'vibratoVol'     // 6xy - Vibrato + volume slide
  | 'tremolo'        // 7xy - Tremolo with speed x, depth y
  | 'setPan'         // 8xx - Set panning position
  | 'sampleOffset'   // 9xx - Set sample offset (for samplers)
  | 'volSlide'       // Axy - Volume slide (x=up, y=down)
  | 'posJump'        // Bxx - Jump to position xx in sequence
  | 'setVolume'      // Cxx - Set volume to xx
  | 'patBreak'       // Dxx - Break to row xx of next pattern
  | 'extEffect'      // Exy - Extended effects (fine slides, retrigger, etc.)
  | 'setGlobalVol'   // Gxx - Set global volume
  | 'globalVolSlide' // Hxy - Global volume slide
  | 'keyOff'         // Kxx - Key off after xx ticks
  | 'panSlide'       // Pxy - Panning slide
  | 'retrigVol'      // Rxy - Retrigger with volume slide
  | 'tremor'         // Txy - Tremor (on x ticks, off y ticks)
  | 'fineVibrato'    // Uxy - Fine vibrato
  | 'setVibratoWave' // E4x - Set vibrato waveform
  | 'setTremoloWave' // E7x - Set tremolo waveform
  | 'finePortaUp'    // E1x - Fine portamento up
  | 'finePortaDown'  // E2x - Fine portamento down
  | 'extraFinePorta' // Xxy - Extra fine portamento up (x=1) / down (x=2)
  | 'setEnvelopePos'  // Lxx - Set envelope position (XM)
  | 'noteCut'        // ECx - Note cut after x ticks
  | 'noteDelay'      // EDx - Note delay by x ticks
  | 'patDelay';      // EEx - Pattern delay by x rows

/**
 * Extended effect subtypes (Exy commands)
 */
export type ExtendedEffectSubtype =
  | 'finePortaUp'    // E1x
  | 'finePortaDown'  // E2x
  | 'glissandoCtrl'  // E3x
  | 'vibratoWave'    // E4x
  | 'setFinetune'    // E5x
  | 'patLoop'        // E6x
  | 'tremoloWave'    // E7x
  | 'setPan'         // E8x (coarse panning)
  | 'retrigger'      // E9x
  | 'fineVolUp'      // EAx
  | 'fineVolDown'    // EBx
  | 'noteCut'        // ECx
  | 'noteDelay'      // EDx
  | 'patDelay'       // EEx
  | 'filterToggle'   // E0x - ProTracker filter on/off (legacy)
  | 'invertLoop';    // EFx - ProTracker invert loop / funk repeat

/**
 * A FastTracker 2 volume-column command.
 *
 * XM's volume column is one byte whose high nibble selects a command and
 * whose low nibble is its parameter. 0x10-0x50 is a plain "set volume" and is
 * carried by the step's `velocity` like any other volume; everything from
 * 0x60 up is a *command*, and those are what this describes.
 *
 * They are not simply duplicates of their effect-column namesakes: the
 * volume-column tone portamento scales its parameter by 16, its vibrato
 * supplies only a depth (reusing the channel's stored speed), and it can slide
 * panning, which the effect column does only via Pxy. They also run
 * *alongside* an effect-column command on the same row rather than replacing
 * it, so a row can slide volume from the volume column while sliding pitch
 * from the effect column.
 */
export type VolumeColumnCommand =
  /** 0x6x: volume slide down by x, on every tick after the first. */
  | { type: 'volSlideDown'; value: number }
  /** 0x7x: volume slide up by x. */
  | { type: 'volSlideUp'; value: number }
  /** 0x8x: fine volume slide down by x, once, on tick 0. */
  | { type: 'fineVolDown'; value: number }
  /** 0x9x: fine volume slide up by x, once, on tick 0. */
  | { type: 'fineVolUp'; value: number }
  /** 0xAx: set the channel's vibrato speed without starting vibrato. */
  | { type: 'vibratoSpeed'; value: number }
  /** 0xBx: vibrato at depth x, using the channel's stored speed. */
  | { type: 'vibrato'; value: number }
  /** 0xCx: set panning. */
  | { type: 'setPan'; value: number }
  /** 0xDx: pan slide left by x. */
  | { type: 'panSlideLeft'; value: number }
  /** 0xEx: pan slide right by x. */
  | { type: 'panSlideRight'; value: number }
  /** 0xFx: tone portamento at speed x*16. */
  | { type: 'tonePorta'; value: number };

/**
 * Parsed effect command data
 */
export interface EffectCommand {
  type: EffectType;
  paramX: number;  // First nibble/parameter (0-15 or 0-255 depending on effect)
  paramY: number;  // Second nibble/parameter
  /** For extended effects (Exy), the specific subtype */
  extSubtype?: ExtendedEffectSubtype;
}

export interface Step {
  row: number;
  note?: string;
  velocity?: number;
  instrumentId?: string;
  macroIndex?: number;
  /** Normalized macro value 0..1 */
  macroValue?: number;
  /**
   * Optional macro ramp target (used for interpolated macro automation).
   * When provided, engines should schedule a linear ramp from macroValue
   * at this row/time to targetValue at the targetRow's time.
   */
  macroRamp?: {
    targetRow: number;
    targetValue: number;
    interpolation?: 'linear' | 'exponential';
  };
  /**
   * Pre-parsed MIDI note number for the step. Optional so callers can
   * keep note strings but still provide a numeric value for scheduling.
   */
  midi?: number;
  /**
   * Optional frequency override in Hz. When present, this exact frequency
   * should be used instead of converting MIDI to frequency (equal temperament).
   * Used for ProTracker MOD imports to preserve Amiga period-based tuning.
   */
  frequency?: number;
  /**
   * Optional pan value 0-1 (for stereo positioning).
   * Used for MOD imports to preserve channel panning.
   */
  pan?: number;
  /**
   * Marks this step as a note-off. When true, engines should release
   * any active notes for the given instrument (or the specific midi note
   * when provided).
   */
  isNoteOff?: boolean;
  /**
   * Speed command (F01-F1F): Sets playback speed multiplier.
   * Value 1-31, where 6 is normal speed.
   * speedMultiplier = speedCommand / 6.0
   */
  speedCommand?: number;
  /**
   * True when this row's velocity came from an XM volume-column set-volume
   * command (0x10-0x50). FT2's Rxy skips its tick-0 retrigger count on such
   * rows; see TrackerEntryData.volumeColumnVolume.
   */
  volumeColumnVolume?: boolean;
  /**
   * Tempo command (F20-FF): Sets BPM directly.
   * Value 32-255 represents the new BPM.
   */
  tempoCommand?: number;
  /**
   * FastTracker 2-style effect command
   */
  effect?: EffectCommand;
  /**
   * FastTracker 2 volume-column command (XM volume column 0x60-0xFF).
   *
   * Independent of `effect`: FT2 runs the volume column and the effect column
   * on the same row, volume column first.
   */
  volumeCommand?: VolumeColumnCommand;
}

export interface PlaybackPosition {
  row: number;
  patternId?: string;
  sequenceIndex?: number;
}

export interface PlaybackEventMap {
  position: PlaybackPosition;
  state: TransportState;
  error: Error;
  /**
   * The sequence ran off its end and playback stopped there.
   *
   * Only fires when song looping is off (`setLoopSong(false)`); a looping
   * song has no end to report. It fires when the last row has actually been
   * heard, not when it was scheduled, so a listener that starts the next song
   * does not cut the tail of this one.
   */
  songEnd: void;
}

export type PlaybackEvent = keyof PlaybackEventMap;

export type PlaybackListener<K extends PlaybackEvent> = (payload: PlaybackEventMap[K]) => void;

export interface PlaybackOptions {
  instrumentResolver?: InstrumentResolver;
  scheduler?: PlaybackScheduler;
  playbackClock?: PlaybackClock;
  noteHandler?: PlaybackNoteHandler;
  /** Handler for scheduling notes at specific audio times */
  scheduledNoteHandler?: ScheduledNoteHandler;
  /** Handler for scheduling gain automation per instrument at specific audio times */
  scheduledAutomationHandler?: ScheduledAutomationHandler;
  /** Handler for gain automation when no scheduled handler exists (fallback) */
  automationHandler?: AutomationHandler;
  /** Handler for scheduling macro values per instrument at specific audio times */
  scheduledMacroHandler?: ScheduledMacroHandler;
  /** Handler for macros when no scheduled handler exists (fallback) */
  macroHandler?: MacroHandler;
  /** Handler for scheduling pitch changes (portamento, vibrato, arpeggio) */
  scheduledPitchHandler?: ScheduledPitchHandler;
  /** Handler for scheduling volume changes (tremolo, volume slide) */
  scheduledVolumeHandler?: ScheduledVolumeHandler;
  /** Handler for scheduling panning changes (8xx, E8x, Pxy) */
  scheduledPanHandler?: ScheduledPanHandler;
  /** Handler for scheduling per-note sample offsets (9xx) */
  scheduledSampleOffsetHandler?: ScheduledSampleOffsetHandler;
  /** Handler for Lxx envelope-position jumps */
  scheduledEnvelopePositionHandler?: ScheduledEnvelopePositionHandler;
  /** Handler for silencing everything when the song loops back to the start */
  scheduledAllNotesOffHandler?: ScheduledAllNotesOffHandler;
  /** Handler for scheduling global volume changes (Gxx/Hxy) */
  scheduledGlobalVolumeHandler?: ScheduledGlobalVolumeHandler;
  /** Handler for the ProTracker E0x set-filter command (profile-gated) */
  scheduledFilterHandler?: ScheduledFilterHandler;
  /** Handler for scheduling note retriggers */
  scheduledRetriggerHandler?: ScheduledRetriggerHandler;
  /** Handler for position commands (Bxx jump, Dxx break) */
  positionCommandHandler?: PositionCommandHandler;
  /** Audio context for getting current time */
  audioContext?: AudioContext;
  /** Ticks per row (FT2 style, default 6) */
  ticksPerRow?: number;
}

export type InstrumentResolver = (instrumentId: string | undefined) => Promise<void> | void;

export interface PlaybackClock {
  start(tick: (deltaMs: number) => void): void;
  stop(): void;
  setVisible?(isVisible: boolean): void;
}

export interface PlaybackScheduler {
  start(tick: (deltaMs: number) => void): void;
  stop(): void;
}

export type PlaybackNoteEventType = 'noteOn' | 'noteOff';

export interface PlaybackNoteEvent {
  type: PlaybackNoteEventType;
  instrumentId?: string;
  midi?: number;
  velocity?: number;
  row: number;
  trackIndex: number;
}

export type PlaybackNoteHandler = (event: PlaybackNoteEvent) => void;

export interface ScheduledNoteEvent {
  type: PlaybackNoteEventType;
  instrumentId?: string;
  midi?: number;
  velocity?: number;
  row: number;
  trackIndex: number;
  /** Audio context time when this note should be triggered */
  time: number;
  /** Optional frequency override in Hz (for ProTracker MOD imports) */
  frequency?: number;
  /** Optional pan value 0-1 (for stereo positioning) */
  pan?: number;
  /**
   * Start offset into the sample in *frames* (ProTracker 9xx: param * 256).
   * Must be applied when the voice starts -- it cannot be set after the fact.
   */
  sampleOffsetFrames?: number;
  /**
   * Duration of one tracker tick in seconds at this note's position, so
   * instruments can time tick-based envelopes against the song's tempo.
   */
  tickSeconds?: number;
}

export type ScheduledAutomationHandler = (
  instrumentId: string,
  gain: number,
  time: number
) => void;

export type AutomationHandler = (instrumentId: string, gain: number) => void;

export type ScheduledMacroHandler = (
  instrumentId: string,
  macroIndex: number,
  value: number,
  time: number,
  ramp?: {
    targetValue: number;
    targetTime: number;
    interpolation?: 'linear' | 'exponential';
  }
) => void;

export type MacroHandler = (instrumentId: string, macroIndex: number, value: number) => void;

export interface GainAutomationEvent {
  instrumentId: string;
  velocity: number;
  row: number;
  trackIndex: number;
  time: number;
}

export type ScheduledNoteHandler = (event: ScheduledNoteEvent) => void;

export interface CancelScheduledHandler {
  (): void;
}

/**
 * Handler for scheduling pitch changes at specific audio times.
 * Used for portamento, vibrato, arpeggio effects.
 */
export type ScheduledPitchHandler = (
  instrumentId: string,
  /** Voice index to modify (-1 for all active voices) */
  voiceIndex: number,
  /** Frequency in Hz */
  frequency: number,
  /** Audio context time */
  time: number,
  /** Track index for routing (tracker effects) */
  trackIndex: number,
  /** Ramp mode for smooth transitions (exponential recommended for frequency) */
  rampMode?: 'linear' | 'exponential'
) => void;

/**
 * Handler for scheduling volume changes at specific audio times.
 * Used for tremolo, volume slide effects.
 */
/**
 * Handler for Lxx: move a voice's envelopes to a tick position.
 */
export type ScheduledEnvelopePositionHandler = (
  instrumentId: string,
  voiceIndex: number,
  /** Envelope tick to jump to. */
  tick: number,
  time: number,
  trackIndex: number
) => void;

export type ScheduledVolumeHandler = (
  instrumentId: string,
  /** Voice index to modify (-1 for all active voices) */
  voiceIndex: number,
  /** Volume 0-1 */
  volume: number,
  /** Audio context time */
  time: number,
  /** Track index for routing (tracker effects) */
  trackIndex: number,
  /**
   * How to get to the new volume.
   *
   * 'step' sets it instantly, which is what a tracker's *instantaneous* volume
   * commands (Cxx, ECx note cut) do. The ramping modes are for per-tick slides,
   * where a ramp across the row is a deliberate and much cheaper approximation
   * of stepping every tick.
   *
   * Omitting it ramps linearly. That default is load-bearing for slides and
   * wrong for anything instant: a linear ramp runs from the *previous*
   * automation event, so an unqualified "set volume to 0" glides down across
   * the whole preceding row instead of cutting.
   */
  rampMode?: 'linear' | 'exponential' | 'step'
) => void;

/**
 * Handler for scheduling panning changes at specific audio times.
 * Used for 8xx (set pan), E8x (coarse pan) and Pxy (pan slide).
 */
export type ScheduledPanHandler = (
  instrumentId: string,
  /** Voice index to modify (-1 to resolve from the track's voice history) */
  voiceIndex: number,
  /** Pan 0-1, where 0 = hard left, 0.5 = centre, 1 = hard right */
  pan: number,
  /** Audio context time */
  time: number,
  /** Track index for routing (tracker channels) */
  trackIndex: number
) => void;

/**
 * Handler for scheduling per-note sample offsets (9xx).
 * The offset value is normalized 0-1 over the sample length.
 */
export type ScheduledSampleOffsetHandler = (
  instrumentId: string,
  /** Voice index to modify (-1 for \"last voice for track\") */
  voiceIndex: number,
  /** Normalized offset 0-1 (0 = start, 1 = end) */
  offset: number,
  /** Audio context time */
  time: number,
  /** Track index for routing (tracker channels) */
  trackIndex: number
) => void;

/**
 * Handler for scheduling song-level global volume changes.
 * Used for ProTracker/FT2-style Gxx/Hxy commands.
 */
export type ScheduledGlobalVolumeHandler = (
  /** Normalized global gain 0-1 */
  gain: number,
  /** Audio context time */
  time: number
) => void;

/**
 * Handler for the ProTracker E0x "set filter" command.
 *
 * `active` follows libopenmpt's polarity (`!(param & 1)`, Snd_fx.cpp):
 * E00 (even parameter) = filter ON, E01 (odd) = filter OFF. The event is
 * global -- the C sets the flag on every channel -- so there is no track or
 * voice argument. Whether a song's format dispatches at all is a
 * `FormatProfile.filterToggleCommand` decision (MOD and native: yes; XM and
 * S3M: no -- FT2 dummies E0x and ST3.21 dummies S0x).
 */
export type ScheduledFilterHandler = (
  /** Whether the filter is toggled on */
  active: boolean,
  /** Audio context time */
  time: number
) => void;

/**
 * Handler for scheduling note retriggers.
 * Used for E9x retrigger, Rxy retrigger with volume.
 */
export type ScheduledRetriggerHandler = (
  instrumentId: string,
  midi: number,
  velocity: number,
  time: number,
  /**
   * The channel being retriggered.
   *
   * Load-bearing rather than informational: a retrigger *is* a note-on on a
   * monophonic channel, so without it the bank cannot tell which voice the
   * retrigger replaces and allocates a fresh one for every repeat.
   */
  trackIndex: number,
  /**
   * Precise ProTracker period-derived frequency for the note being
   * retriggered, when known. Preferred over deriving frequency from
   * `midi` (which discards finetune/period precision).
   */
  frequency?: number
) => void;

/**
 * Handler for "the song has wrapped back to the start; silence everything".
 *
 * A song that ends on a fade leaves notes running -- the fade is usually a
 * global-volume ramp, which turns the mix down without stopping anything -- so
 * looping back and restoring the volume would otherwise reveal whatever was
 * still sounding. See D66.
 */
export type ScheduledAllNotesOffHandler = (time: number) => void;

/**
 * Handler for position jump/pattern break commands.
 */
export interface PositionCommand {
  type: 'posJump' | 'patBreak';
  /** For posJump: sequence index. For patBreak: target row */
  value: number;
}

export type PositionCommandHandler = (command: PositionCommand) => void;

// Re-export TimingSystem for external use
export { TimingSystem } from './timing-system';
