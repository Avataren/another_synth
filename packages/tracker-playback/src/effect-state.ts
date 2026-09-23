/**
 * Per-track effect state for the effect processor, and the factory and
 * per-note reset that act on it alone.
 */

import { type FormatProfile, PROTRACKER_PROFILE } from './format-profile';

/**
 * Per-track effect state
 */
export interface TrackEffectState {
  /**
   * Playback semantics for the song this track belongs to. Held per track so
   * the effect handlers can read it without threading a parameter through
   * every helper; the object itself is shared and immutable.
   */
  profile: FormatProfile;

  // Current note state
  currentMidi: number;
  currentFrequency: number;
  targetMidi: number;
  targetFrequency: number;
  targetPeriod?: number | undefined;
  lastTonePortaTargetFreq?: number | undefined;
  lastTonePortaTargetPeriod?: number | undefined;
  tonePortaActive: boolean;
  currentVolume: number; // 0-1
  currentPan: number; // -1 to 1

  // Portamento state
  portamentoSpeed: number;
  tonePortaSpeed: number;
  currentPeriod?: number | undefined; // Amiga period for ProTracker-style portamento

  // Vibrato state
  vibratoSpeed: number;
  vibratoDepth: number;
  vibratoPos: number;
  /**
   * Whether a vibrato offset is currently bending this channel.
   *
   * FT2 leaves the channel period alone on a row whose cell is empty, so a
   * vibrato holds its current offset there rather than springing back to the
   * note. Tracking this lets tick 0 tell "no effect, hold what vibrato set"
   * apart from "no effect, nothing to hold".
   */
  vibratoApplied: boolean;
  /**
   * The waveform sample of the last vibrato offset actually emitted.
   *
   * Both replayers advance the position *after* using it, so once a row has
   * run, `vibratoPos` already points at the *next* tick's sample rather than
   * the one currently sounding. Tick 0 of a row that merely holds the offset
   * (see the `continuesVibrato` note in processEffectTick0) has to re-state
   * what is sounding, not what comes next, so it reads this instead of
   * recomputing from the position.
   */
  vibratoHeldWave: number;
  vibratoWaveform: number; // 0=sine, 1=ramp, 2/3=square (the reference has no random)
  /**
   * Whether a new note restarts the vibrato waveform.
   *
   * E4x's bit 2 (values 4-7) selects the same three waveforms again but asks
   * for the position to carry across notes instead of restarting. Masking the
   * parameter with & 3, as this used to, threw that choice away and always
   * restarted.
   */
  vibratoRetrigger: boolean;

  // Tremolo state
  tremoloSpeed: number;
  tremoloDepth: number;
  tremoloPos: number;
  tremoloWaveform: number;
  /** As vibratoRetrigger, for E7x. */
  tremoloRetrigger: boolean;
  /**
   * Whether a tremolo is currently bending this channel's volume.
   *
   * Unlike vibrato, FT2 and ProTracker do NOT hold a tremolo offset across
   * rows: both recompute `outVol` from `realVol` every tick, so the moment a
   * row stops carrying 7xy the volume springs back to what the channel's
   * slides have made of it. Tick 0 uses this flag to tell "tremolo ran on a
   * previous row, re-state the channel volume" apart from "nothing to
   * restore".
   */
  tremoloApplied: boolean;

  // Arpeggio state
  arpeggioX: number;
  arpeggioY: number;

  // Volume slide state
  volumeSlide: {
    delta: number; // positive = up, negative = down (normalized per tick)
    mode: 'none' | 'normal' | 'fine';
    source: 'volSlide' | 'tonePortaVol' | 'vibratoVol' | null;
    /**
     * Whether a `normal` slide also steps on tick 0 of the row.
     *
     * False everywhere except S3M, and there only for the ST3.00-era files
     * `FormatProfile.fastVolumeSlides` describes and for the two `D0F`/`DF0`
     * parameters that OpenMPT's VolumeSlide steps on the first tick as well
     * as every later one (see `FormatProfile.volumeSlideNibbles`).
     */
    firstTick: boolean;
  };

  // Panning slide state
  panSlideSpeed: number;

  /**
   * Per-tick slides requested by the *volume column* (XM 0x6x-0xEx).
   *
   * Kept apart from the effect-column slides above because FT2 runs both
   * columns on the same row: a row can slide volume from the volume column
   * while an effect-column 3xx slides pitch, and sharing one accumulator would
   * let whichever was primed last silently cancel the other.
   */
  volumeColumnSlide: number;
  volumeColumnPanSlide: number;

  // Retrigger state
  retriggerInterval: number;
  retriggerTick: number;
  retriggerVolChange: number;
  /** Rxy parameter memory: FT2 reuses the last non-zero nibbles for R00. */
  lastRetrigger: number;

  /**
   * Position within the current Txy on/off cycle.
   *
   * Persistent across rows, as in FT2: tremor counts continuously, so a run of
   * tremor rows produces one unbroken pattern rather than restarting the cycle
   * at every row boundary. Deriving it from the tick index instead (which
   * resets to 0 each row) made every row start on the "on" phase, which turns
   * an off-beat stutter into a steady one.
   */
  tremorPos: number;
  /** Txy parameter memory. */
  lastTremor: number;
  // Tone portamento glissando (E3x)
  glissandoEnabled: boolean;

  // Note cut/delay
  noteCutTick: number;
  noteDelayTick: number;
  delayedNote:
    | {
        midi: number;
        velocity: number;
        // Precise ProTracker period-derived frequency for this note, when
        // known (MOD imports supply this). Falling back to
        // midiToFrequency(midi) alone discards finetune/period precision
        // and can land several cents off pitch.
        frequency?: number;
      }
    | undefined;

  // Voice tracking
  voiceIndex: number;
  /**
   * Whether the channel currently owns a sounding voice.
   *
   * Key-off releases that voice. A later 3xx note therefore has nothing to
   * slide, and FT2 starts a new note rather than leaving the channel silent.
   */
  hasActiveVoice: boolean;

  // Instrument tracking (for "naked" effects without explicit instrument)
  instrumentId: string | undefined;

  // Effect memory (FT2 remembers last values)
  lastPortaUp: number;
  lastPortaDown: number;
  lastTonePorta: number;
  lastVibrato: number;
  lastTremolo: number;
  lastVolSlide: number;
  lastArpeggio: number;
  /** 9xx offset memory (ProTracker reuses the last value for a bare 900). */
  lastSampleOffset: number;

  /**
   * FT2's fine-slide memories: `fPitchSlideUpSpeed` / `fPitchSlideDownSpeed`
   * (E1x/E2x), `fVolSlideUpSpeed` / `fVolSlideDownSpeed` (EAx/EBx) and
   * `efPitchSlideUpSpeed` / `efPitchSlideDownSpeed` (Xxy). Each is its own
   * byte -- E1x does not share with Xxy -- and each is only consulted when
   * the profile's fineSlideHasMemory is set.
   */
  lastFinePortaUp: number;
  lastFinePortaDown: number;
  lastFineVolUp: number;
  lastFineVolDown: number;
  lastExtraFinePortaUp: number;
  lastExtraFinePortaDown: number;

  // Note delay overflow to next row (ProTracker EDx quirk)
  carryDelayedNote: {
    midi: number;
    velocity: number;
    frequency?: number;
  } | null;

  /**
   * Reusable command buffers for the batch-producing processors.
   *
   * One per column because the engine produces the effect-column tick-0 batch
   * and then the volume-column tick-0 batch on the same state, and only after
   * both does it dispatch them and test `hasVolumeCommand(tick0Batch.commands)`
   * -- sharing one buffer would wipe the effect batch before it was read.
   *
   * Both are reset (`length = 0`) at the top of every processor call and the
   * dispatched arrays are never retained past dispatch (engine.ts:
   * "dispatchCommands only reads the context"), so reuse is safe there. See
   * the `TickCommandBatch` doc for the consumer contract.
   */
  effectCommandBuffer: ProcessorCommand[];
  volumeCommandBuffer: ProcessorCommand[];

  /**
   * AHX/HVL only, all four fields (`.ai/ahx/p2-report.md`). None are
   * consumed anywhere yet -- there is no AHX voice sink in this phase (P4)
   * -- so these exist purely as the decoded, correctly-typed record of what
   * the pattern asked for, the same "data now, wiring later" shape
   * `setGlobalVol`'s song-level state has today.
   */
  /** fx 0x4 direct set (`vc_FilterPos = FXParam-0x40`), 0-63. */
  ahxFilterPos?: number;
  /** fx 0x4 latched override (`vc_IgnoreFilter`) for a future PList filter command, 0-63. */
  ahxFilterIgnore?: number;
  /**
   * fx 0x9's raw reconstructed byte, NOT `vc_SquarePos` itself.
   *
   * `hvl_replay.c:691-695` computes `vc_SquarePos = FXParam >>
   * (5 - vc_WaveLength)`, where `vc_WaveLength` is the *voice's* currently
   * active instrument's waveform-length setting (latched at instrument
   * trigger, `hvl_replay.c:903`) -- state that lives on the voice, not on
   * this per-track decode-time `TrackEffectState`. Threading it through here
   * would mean widening this record with a running "active instrument's
   * wave length" field sourced from the song's instrument table, which no
   * other field here does and which this phase does not need. The shift is
   * therefore deferred to whichever layer actually holds `vc_WaveLength`:
   * the future AHX voice (P3's Rust `voice.rs`, which tracks it per
   * `hvl_replay.c:903` as part of building the waveform generator anyway).
   * That consumer MUST right-shift this raw byte by `5 - waveLength` before
   * treating it as `vc_SquarePos` -- reading it verbatim reproduces the bug
   * this field was renamed to prevent.
   */
  ahxSquarePosRaw?: number;
  /** fx 0xc's third tier (`vc_TrackMasterVolume`), 0-1. */
  ahxTrackVolume?: number;
}

/**
 * Create default track effect state
 */
export function createTrackEffectState(
  profile: FormatProfile = PROTRACKER_PROFILE,
): TrackEffectState {
  return {
    profile,
    currentMidi: 60,
    currentFrequency: 261.63,
    targetMidi: 60,
    targetFrequency: 261.63,
    targetPeriod: undefined,
    lastTonePortaTargetFreq: undefined,
    lastTonePortaTargetPeriod: undefined,
    tonePortaActive: false,
    currentVolume: 1.0,
    currentPan: 0,

    portamentoSpeed: 0,
    tonePortaSpeed: 0,

    vibratoSpeed: 0,
    vibratoDepth: 0,
    vibratoPos: 0,
    vibratoApplied: false,
    vibratoHeldWave: 0,
    vibratoWaveform: 0,
    vibratoRetrigger: true,

    tremoloSpeed: 0,
    tremoloDepth: 0,
    tremoloPos: 0,
    tremoloWaveform: 0,
    tremoloRetrigger: true,
    tremoloApplied: false,

    arpeggioX: 0,
    arpeggioY: 0,

    volumeSlide: { delta: 0, mode: 'none', source: null, firstTick: false },
    panSlideSpeed: 0,
    volumeColumnSlide: 0,
    volumeColumnPanSlide: 0,

    retriggerInterval: 0,
    retriggerTick: 0,
    retriggerVolChange: 0,
    lastRetrigger: 0,
    tremorPos: 0,
    lastTremor: 0,
    glissandoEnabled: false,

    noteCutTick: -1,
    noteDelayTick: -1,
    delayedNote: undefined,

    voiceIndex: -1,
    hasActiveVoice: false,
    instrumentId: undefined,

    lastPortaUp: 0,
    lastPortaDown: 0,
    lastTonePorta: 0,
    lastVibrato: 0,
    lastTremolo: 0,
    lastVolSlide: 0,
    lastArpeggio: 0,
    lastSampleOffset: 0,
    lastFinePortaUp: 0,
    lastFinePortaDown: 0,
    lastFineVolUp: 0,
    lastFineVolDown: 0,
    lastExtraFinePortaUp: 0,
    lastExtraFinePortaDown: 0,
    carryDelayedNote: null,
    effectCommandBuffer: [],
    volumeCommandBuffer: [],
  };
}

export type ProcessorCommand =
  | {
      kind: 'noteOn';
      midi: number;
      velocity: number;
      frequency?: number;
      pan?: number;
      /**
       * ProTracker 9xx start offset, in *sample frames*.
       *
       * 9xx means "start xx*256 frames in", an absolute distance that has
       * nothing to do with how long the sample is. This used to be carried as
       * a 0-1 fraction of the sample (`param / 255`), which is only correct
       * for a sample of exactly 255*256 = 65280 frames; every other length
       * landed somewhere else entirely, and the mid-waveform jump that
       * produced is exactly the audible click 9xx is supposed to avoid.
       * mod-import.ts papered over it by re-encoding the parameter against
       * the sample length, but that only works on rows that name an
       * instrument (13 of peacedroid.mod's 205 9xx rows do not), quantises
       * the position back down to 8 bits, and did nothing at all for XM.
       *
       * Frames are the format's own unit and need no sample knowledge here,
       * so the resolution happens once, in the instrument that owns the
       * buffer.
       *
       * This rides along with the note rather than arriving as a separate
       * command because a sample offset can only be applied *at* the moment
       * playback starts -- a Web Audio AudioBufferSourceNode cannot be seeked
       * once started.
       */
      sampleOffsetFrames?: number;
    }
  | { kind: 'noteOff'; midi?: number }
  | {
      kind: 'pitch';
      frequency: number;
      voiceIndex?: number;
      glide?: 'linear' | 'exponential';
    }
  | {
      kind: 'volume';
      volume: number;
      voiceIndex?: number;
      ramp?: 'linear' | 'exponential' | 'step';
    }
  | { kind: 'pan'; pan: number; voiceIndex?: number }
  | { kind: 'sampleOffset'; offset: number; voiceIndex?: number }
  | {
      /**
       * Lxx: jump the instrument's envelopes to a tick position, without
       * retriggering anything.
       */
      kind: 'envelopePosition';
      tick: number;
      voiceIndex?: number;
    }
  | { kind: 'retrigger'; midi: number; velocity: number; frequency?: number };

/**
 * Reset effect state for a new note
 */
export function resetEffectStateForNote(state: TrackEffectState): void {
  if (state.vibratoRetrigger) state.vibratoPos = 0;
  state.vibratoApplied = false;
  state.vibratoHeldWave = 0;
  if (state.tremoloRetrigger) state.tremoloPos = 0;
  // A new note re-states the channel volume itself (the noteOn carries the
  // velocity), so whatever tremolo was bending before it is gone with the
  // note.
  state.tremoloApplied = false;
  state.retriggerTick = 0;
  state.noteCutTick = -1;
  state.noteDelayTick = -1;
  state.delayedNote = undefined;
  state.tonePortaActive = false;
  state.hasActiveVoice = false;
}
