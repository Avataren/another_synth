export type TransportState = 'stopped' | 'playing' | 'paused';

export interface Song {
  title: string;
  author: string;
  bpm: number;
  patterns: Pattern[];
  sequence: string[];
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
  | 'patDelay';      // EEx

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
   * Pre-parsed MIDI note number for the step. Optional so callers can
   * keep note strings but still provide a numeric value for scheduling.
   */
  midi?: number;
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
   * Tempo command (F20-FF): Sets BPM directly.
   * Value 32-255 represents the new BPM.
   */
  tempoCommand?: number;
  /**
   * FastTracker 2-style effect command
   */
  effect?: EffectCommand;
}

export interface PlaybackPosition {
  row: number;
  patternId?: string;
}

export interface PlaybackEventMap {
  position: PlaybackPosition;
  state: TransportState;
  error: Error;
}

export type PlaybackEvent = keyof PlaybackEventMap;

export type PlaybackListener<K extends PlaybackEvent> = (payload: PlaybackEventMap[K]) => void;

export interface PlaybackOptions {
  instrumentResolver?: InstrumentResolver;
  scheduler?: PlaybackScheduler;
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
  time: number
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
  time: number
) => void;

/**
 * Handler for scheduling volume changes at specific audio times.
 * Used for tremolo, volume slide effects.
 */
export type ScheduledVolumeHandler = (
  instrumentId: string,
  /** Voice index to modify (-1 for all active voices) */
  voiceIndex: number,
  /** Volume 0-1 */
  volume: number,
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
  time: number
) => void;

/**
 * Handler for position jump/pattern break commands.
 */
export interface PositionCommand {
  type: 'posJump' | 'patBreak';
  /** For posJump: sequence index. For patBreak: target row */
  value: number;
}

export type PositionCommandHandler = (command: PositionCommand) => void;
