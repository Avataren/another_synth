/**
 * FastTracker 2-style effect processor for the playback engine.
 * Handles per-tick effect processing for portamento, vibrato, arpeggio, etc.
 */

import type { EffectCommand, VolumeColumnCommand } from './types';
import { type FormatProfile, PROTRACKER_PROFILE } from './format-profile';

/**
 * Sample frames one unit of a 9xx parameter skips.
 *
 * ProTracker's unit is 256 bytes of 8-bit mono PCM, i.e. 256 frames;
 * FastTracker 2 keeps the same 256-frame unit for 8- and 16-bit samples
 * alike. So this is a shared constant rather than a per-format profile field.
 */
const SAMPLE_OFFSET_FRAMES_PER_UNIT = 256;

/**
 * ProTracker's vibrato/tremolo waveform tables peak at 255, and the depth
 * scaling divides by 128 for vibrato (period units) and 64 for tremolo
 * (volume units, 0-64). getWaveformValue returns -1..1 rather than the raw
 * table, so the peak is reintroduced here.
 */
const VIBRATO_TABLE_PEAK = 255;
const VIBRATO_DEPTH_DIVISOR = 128;
const TREMOLO_DEPTH_DIVISOR = 64;

function updatePitchFromPeriod(state: TrackEffectState, period: number): void {
  const pitch = state.profile.pitch;
  const clamped = pitch.clampPeriod(period);
  state.currentPeriod = clamped;
  const frequency = pitch.frequencyFromPeriod(clamped);
  state.currentFrequency = frequency;
  state.currentMidi = frequencyToMidi(frequency);
}

function updatePitchFromFrequency(
  state: TrackEffectState,
  frequency: number,
): void {
  state.currentFrequency = frequency;
  state.currentMidi = frequencyToMidi(frequency);
  if (state.currentPeriod !== undefined) {
    const pitch = state.profile.pitch;
    state.currentPeriod = pitch.clampPeriod(
      pitch.rawPeriodFromFrequency(frequency),
    );
  }
}

/**
 * E1x / E2x fine portamento: one immediate step of `units` period units.
 *
 * Same unit as 1xx/2xx (see applyPortamentoStep) -- ProTracker subtracts the
 * parameter straight from the period and FT2 subtracts param*4 from its
 * four-times-finer period, which is what portamentoUnitScale carries. Positive
 * `units` raises the pitch, matching E1x.
 *
 * This used to apply 2^(x/192), i.e. treat the parameter as 1/16 of a
 * semitone. That is not a fine portamento at all: at C-2 (period 428) an E11
 * moved ~1.55 period units instead of 1, and the error scales with pitch, so
 * the detuning-by-a-hair effect these commands exist for came out roughly half
 * again too strong in the middle of the range and worse at the extremes.
 */
function applyFinePortamento(
  state: TrackEffectState,
  units: number,
  /**
   * Period units one parameter step moves. Defaults to the format's ordinary
   * portamento scale, which is what E1x/E2x use. Xxy's "extra fine" step is a
   * quarter of that -- FT2 subtracts the raw parameter from its period where
   * E1x subtracts param*4 -- so it passes 1.
   */
  unitScale: number = state.profile.portamentoUnitScale,
): void {
  const delta = units * unitScale;
  if (state.currentPeriod !== undefined) {
    updatePitchFromPeriod(state, state.currentPeriod - delta);
  } else {
    // No period context (a natively authored song). Fall back to the
    // semitone-ratio approximation this always used.
    const ratio = Math.pow(2, units / (12 * 16));
    updatePitchFromFrequency(state, state.currentFrequency * ratio);
  }
}

/**
 * The pitch a vibrato offset lands on, without disturbing the channel's own
 * pitch (vibrato is a deviation, not a slide).
 *
 * ProTracker computes `periodDelta = (vibratoTable[pos] * depth) / 128` with a
 * table peaking at 255, so a depth of x swings the period by about +-2x --
 * *period* units, which means the musical size of a given depth depends on the
 * note being played. FT2 uses the same formula against its four-times-finer
 * period scale, hence portamentoUnitScale.
 *
 * The previous code worked in semitones instead (`wave * depth / 16`), which
 * is a fixed musical width. That is only about right in the middle of the
 * range: at C-2 (period 428) it under-swung by ~23%, and an octave lower
 * (period 856) it over-swung by ~55%.
 */
function vibratoFrequency(state: TrackEffectState, wave: number): number {
  const period = state.currentPeriod;
  if (period === undefined) {
    const semitones = (wave * state.vibratoDepth) / 16;
    return state.currentFrequency * Math.pow(2, semitones / 12);
  }
  const pitch = state.profile.pitch;
  const delta =
    (wave * VIBRATO_TABLE_PEAK * state.vibratoDepth) /
    VIBRATO_DEPTH_DIVISOR *
    state.profile.portamentoUnitScale;
  // A positive waveform value raises the pitch, so it lowers the period.
  return pitch.frequencyFromPeriod(pitch.clampPeriod(period - delta));
}

function applyPortamentoStep(state: TrackEffectState): void {
  const speed = state.portamentoSpeed;
  if (speed === 0) return;

  if (state.currentPeriod !== undefined) {
    const delta = Math.abs(speed) * state.profile.portamentoUnitScale;
    const nextPeriod =
      speed > 0 ? state.currentPeriod - delta : state.currentPeriod + delta;
    updatePitchFromPeriod(state, nextPeriod);
  } else {
    const ratio = Math.pow(2, speed / (12 * 16));
    updatePitchFromFrequency(state, state.currentFrequency * ratio);
  }
}

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
  vibratoWaveform: number; // 0=sine, 1=ramp down, 2=square, 3=random
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

  // Arpeggio state
  arpeggioX: number;
  arpeggioY: number;
  arpeggioTick: number;

  // Volume slide state
  volumeSlide: {
    delta: number; // positive = up, negative = down (normalized per tick)
    mode: 'none' | 'normal' | 'fine';
    source: 'volSlide' | 'tonePortaVol' | 'vibratoVol' | null;
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

  // Note delay overflow to next row (ProTracker EDx quirk)
  carryDelayedNote: { midi: number; velocity: number; frequency?: number } | null;
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
    vibratoWaveform: 0,
    vibratoRetrigger: true,

    tremoloSpeed: 0,
    tremoloDepth: 0,
    tremoloPos: 0,
    tremoloWaveform: 0,
    tremoloRetrigger: true,

    arpeggioX: 0,
    arpeggioY: 0,
    arpeggioTick: 0,

    volumeSlide: { delta: 0, mode: 'none', source: null },
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
    instrumentId: undefined,

    lastPortaUp: 0,
    lastPortaDown: 0,
    lastTonePorta: 0,
    lastVibrato: 0,
    lastTremolo: 0,
    lastVolSlide: 0,
    lastArpeggio: 0,
    lastSampleOffset: 0,
    carryDelayedNote: null,
  };
}

/**
 * Convert MIDI note to frequency
 */
export function midiToFrequency(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function resolveTonePortaSpeed(
  state: TrackEffectState,
  paramX: number,
  paramY: number,
): number {
  const value = paramX * 16 + paramY;
  if (value > 0) {
    state.lastTonePorta = value;
    return value;
  }
  // If no new value is provided, prefer the remembered last non-zero value;
  // fall back to the current speed so 300 continues an in-flight slide.
  return state.lastTonePorta > 0 ? state.lastTonePorta : state.tonePortaSpeed;
}

function applyTonePortaStep(state: TrackEffectState): number {
  if (state.tonePortaSpeed <= 0) {
    return state.currentFrequency;
  }

  if (state.currentPeriod === undefined && state.targetPeriod !== undefined) {
    state.currentPeriod = state.profile.pitch.periodFromFrequency(
      state.currentFrequency,
    );
  }

  if (state.currentPeriod !== undefined && state.targetPeriod !== undefined) {
    const step = state.tonePortaSpeed * state.profile.portamentoUnitScale;
    let nextPeriod = state.currentPeriod;
    if (state.currentPeriod > state.targetPeriod) {
      nextPeriod = Math.max(state.targetPeriod, state.currentPeriod - step);
    } else if (state.currentPeriod < state.targetPeriod) {
      nextPeriod = Math.min(state.targetPeriod, state.currentPeriod + step);
    }
    updatePitchFromPeriod(state, nextPeriod);
  } else {
    const ratio = Math.pow(2, state.tonePortaSpeed / (12 * 16));
    let nextFrequency = state.currentFrequency;
    if (state.currentFrequency < state.targetFrequency) {
      nextFrequency *= ratio;
      if (nextFrequency >= state.targetFrequency) {
        nextFrequency = state.targetFrequency;
      }
    } else if (state.currentFrequency > state.targetFrequency) {
      nextFrequency /= ratio;
      if (nextFrequency <= state.targetFrequency) {
        nextFrequency = state.targetFrequency;
      }
    }
    updatePitchFromFrequency(state, nextFrequency);
  }

  // When glissando control is enabled (E3x), snap to semitone grid.
  if (state.glissandoEnabled) {
    if (state.currentPeriod !== undefined) {
      // MOD/period-domain track: snap to the nearest real ProTracker
      // period-table entry, matching authentic glissando behavior, instead
      // of the nearest equal-tempered MIDI note (which can disagree with
      // the table near octave boundaries).
      updatePitchFromPeriod(
        state,
        state.profile.pitch.snapPeriod(state.currentPeriod),
      );
    } else {
      const snappedMidi = Math.round(frequencyToMidi(state.currentFrequency));
      const snappedFrequency = midiToFrequency(snappedMidi);
      updatePitchFromFrequency(state, snappedFrequency);
    }
  }

  return state.currentFrequency;
}

/**
 * Convert frequency to MIDI note (fractional)
 */
export function frequencyToMidi(freq: number): number {
  return 69 + 12 * Math.log2(freq / 440);
}

/**
 * Get vibrato/tremolo waveform value
 */
function getWaveformValue(pos: number, waveform: number): number {
  const phase = (pos & 63) / 64; // 64 positions per cycle

  switch (waveform & 3) {
    case 0: // Sine
      return Math.sin(phase * Math.PI * 2);
    case 1: // Ramp down (sawtooth)
      return 1 - 2 * phase;
    case 2: // Square
      return phase < 0.5 ? 1 : -1;
    case 3: // Random
      return Math.random() * 2 - 1;
    default:
      return Math.sin(phase * Math.PI * 2);
  }
}

function clampVolume(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function resetVolumeSlide(state: TrackEffectState): void {
  state.volumeSlide = { delta: 0, mode: 'none', source: null };
}

function primeVolumeSlide(
  state: TrackEffectState,
  effect: EffectCommand | undefined,
): void {
  if (!effect) return;

  const setSlide = (
    delta: number,
    mode: 'normal' | 'fine',
    source: 'volSlide' | 'tonePortaVol' | 'vibratoVol',
  ) => {
    state.volumeSlide = { delta, mode, source };
  };

  switch (effect.type) {
    case 'volSlide': {
      if (effect.extSubtype === 'fineVolUp') {
        setSlide(effect.paramY / 64, 'fine', 'volSlide');
        return;
      }
      if (effect.extSubtype === 'fineVolDown') {
        setSlide(-effect.paramY / 64, 'fine', 'volSlide');
        return;
      }

      let delta = 0;
      // One volume unit as a fraction of full scale, from the format profile
      // (1/64 for the 0-64 ranges ProTracker and FT2 both use) -- the same
      // scale the fine slides (EAx/EBx) above and tonePortaVol/vibratoVol
      // below already use.
      //
      // This was 1/128 ("softer slide ... to better match MOD feel"), which
      // made every Axy slide run at exactly half the authentic rate: at speed
      // 6 an A06 row dropped 0.234 instead of ProTracker's 5 x 6/64 = 0.469.
      // That constant looks like an ear-made compensation for a
      // double-application bug that has since been fixed independently -- the
      // slide is now applied once per tick for ticks 1..speed-1, five times at
      // speed 6, which is exactly what ProTracker does. Its own comment said
      // 1/256 while the code said 1/128, so it was never a derived value.
      const scale = state.profile.volumeSlideUnit;
      if (effect.paramX) delta = effect.paramX * scale;
      else if (effect.paramY) delta = -effect.paramY * scale;
      else if (state.profile.volumeSlideHasMemory && state.lastVolSlide) {
        // FT2 reuses the last non-zero slide for A00. ProTracker has no
        // volume-slide memory at all -- there A00 means "no volume change" --
        // so continuing the previous slide would make the volume drift where
        // ProTracker holds it.
        const lastX = (state.lastVolSlide >> 4) & 0x0f;
        const lastY = state.lastVolSlide & 0x0f;
        if (lastX) delta = lastX * scale;
        else if (lastY) delta = -lastY * scale;
      }

      if (delta !== 0) {
        setSlide(delta, 'normal', 'volSlide');
        state.lastVolSlide =
          (effect.paramX << 4) | effect.paramY || state.lastVolSlide;
      }
      return;
    }

    case 'tonePortaVol': {
      if (effect.paramX) setSlide(effect.paramX / 64, 'normal', 'tonePortaVol');
      else if (effect.paramY)
        setSlide(-effect.paramY / 64, 'normal', 'tonePortaVol');
      return;
    }

    case 'vibratoVol': {
      if (effect.paramX) setSlide(effect.paramX / 64, 'normal', 'vibratoVol');
      else if (effect.paramY)
        setSlide(-effect.paramY / 64, 'normal', 'vibratoVol');
      return;
    }

    default:
      return;
  }
}

function applyVolumeSlideIfNeeded(state: TrackEffectState): number | undefined {
  if (state.volumeSlide.mode !== 'normal' || state.volumeSlide.delta === 0) {
    return undefined;
  }
  state.currentVolume = clampVolume(
    state.currentVolume + state.volumeSlide.delta,
  );
  return state.currentVolume;
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
      ramp?: 'linear' | 'exponential';
    }
  | { kind: 'pan'; pan: number; voiceIndex?: number }
  | { kind: 'sampleOffset'; offset: number; voiceIndex?: number }
  | { kind: 'retrigger'; midi: number; velocity: number; frequency?: number };

export interface TickCommandBatch {
  commands: ProcessorCommand[];
}

/**
 * Process effect for the first tick of a row (tick 0)
 * This handles effects that apply immediately
 */
export function processEffectTick0(
  state: TrackEffectState,
  effect: EffectCommand | undefined,
  newNote?: number,
  newVelocity?: number,
  noteFrequency?: number,
  ticksPerRow?: number,
  pan?: number,
): TickCommandBatch {
  const commands: ProcessorCommand[] = [];
  const voiceIndex = state.voiceIndex >= 0 ? state.voiceIndex : undefined;
  const hasNoteDelay =
    effect?.type === 'noteDelay' ||
    (effect?.type === 'extEffect' && effect.extSubtype === 'noteDelay');

  const pushPitch = (frequency: number) => {
    const cmd: ProcessorCommand =
      voiceIndex !== undefined
        ? { kind: 'pitch', frequency, voiceIndex }
        : { kind: 'pitch', frequency };
    commands.push(cmd);
  };

  const pushVolume = (volume: number) => {
    const cmd: ProcessorCommand =
      voiceIndex !== undefined
        ? { kind: 'volume', volume, voiceIndex }
        : { kind: 'volume', volume };
    commands.push(cmd);
  };

  const pushPan = (value: number) => {
    const cmd: ProcessorCommand =
      voiceIndex !== undefined
        ? { kind: 'pan', pan: value, voiceIndex }
        : { kind: 'pan', pan: value };
    commands.push(cmd);
  };

  // ProTracker 9xx sets where in the sample a note starts, so it has to be
  // resolved before the note-trigger block below rather than in the effect
  // switch further down (which runs after the noteOn has already been
  // emitted). A bare 900 reuses the channel's remembered value.
  let pendingSampleOffsetFrames: number | undefined;
  if (effect?.type === 'sampleOffset') {
    const raw = effect.paramX * 16 + effect.paramY || state.lastSampleOffset;
    state.lastSampleOffset = raw;
    pendingSampleOffsetFrames = raw * SAMPLE_OFFSET_FRAMES_PER_UNIT;
  }

  const pushNoteOn = (midi: number, velocity: number) => {
    commands.push({
      kind: 'noteOn',
      midi,
      velocity,
      frequency: state.currentFrequency,
      ...(pan !== undefined ? { pan } : {}),
      ...(pendingSampleOffsetFrames !== undefined
        ? { sampleOffsetFrames: pendingSampleOffsetFrames }
        : {}),
    });
  };

  // Reset per-row volume slide accumulator (effect memory stored separately)
  resetVolumeSlide(state);

  /** Whether this row started a note, i.e. whether a voice was allocated. */
  let triggeredNote = false;

  // ProTracker note delay overflow: if previous row had EDx with x >= speed and
  // no new note arrives, trigger the carried note at the start of this row.
  if (!effect && newNote === undefined && state.carryDelayedNote) {
    const carry = state.carryDelayedNote;
    state.carryDelayedNote = null;
    state.currentMidi = carry.midi;
    if (carry.frequency !== undefined) {
      // Preserve the MOD's exact period-derived pitch instead of
      // recomputing it from the rounded MIDI note (which discards
      // finetune/period precision and can land several cents off).
      updatePitchFromPeriod(
        state,
        state.profile.pitch.periodFromFrequency(carry.frequency),
      );
      state.currentFrequency = carry.frequency;
    } else {
      state.currentFrequency = midiToFrequency(carry.midi);
    }
    state.targetMidi = carry.midi;
    state.targetFrequency = state.currentFrequency;
    state.targetPeriod = undefined;
    state.currentVolume = carry.velocity / 255;
    pushNoteOn(carry.midi, 127);
    pushPitch(state.currentFrequency);
    pushVolume(state.currentVolume);
    return { commands };
  }

  // Update current note if we have a new one
  if (newNote !== undefined) {
    // For tone portamento, new note sets target, not current
    if (effect?.type === 'tonePorta' || effect?.type === 'tonePortaVol') {
      state.targetMidi = newNote;
      const targetFreq = noteFrequency ?? midiToFrequency(newNote);
      state.targetFrequency = targetFreq;
      // Only use ProTracker-style periods when we have period context
      // (MOD imports provide noteFrequency/currentPeriod). Otherwise keep
      // frequency-based slides for normal tracker notes.
      if (noteFrequency !== undefined || state.currentPeriod !== undefined) {
        state.targetPeriod = state.profile.pitch.periodFromFrequency(targetFreq);
      } else {
        state.targetPeriod = undefined;
      }
      state.lastTonePortaTargetFreq = state.targetFrequency;
      state.lastTonePortaTargetPeriod = state.targetPeriod;
      state.tonePortaActive = state.tonePortaSpeed > 0;
    } else {
      if (noteFrequency !== undefined) {
        const rawPeriod =
          state.profile.pitch.rawPeriodFromFrequency(noteFrequency);
        updatePitchFromPeriod(state, rawPeriod);
      } else {
        state.currentPeriod = undefined;
        updatePitchFromFrequency(state, midiToFrequency(newNote));
      }
      state.targetMidi = newNote;
      state.targetFrequency = state.currentFrequency;
      state.targetPeriod = state.currentPeriod;

      // Trigger note immediately unless delayed or a tone portamento continuation
      if (!hasNoteDelay) {
        pushNoteOn(newNote, 127);
        triggeredNote = true;
      }
    }
  }

  if (newVelocity !== undefined) {
    // newVelocity is in 0-255 range (from MOD importer volume column)
    // Normalize to 0-1 for internal use
    state.currentVolume = newVelocity / 255;
  }

  // A note that starts always states the channel's volume, even when the row
  // supplies no volume of its own.
  //
  // A note with no sample number keeps whatever volume the channel has
  // reached -- including one a volume slide has been walking up or down for
  // several rows -- and that lives here in `currentVolume`. It cannot be left
  // implicit, because a note allocates a fresh voice whose gain node starts at
  // the instrument's own gain rather than at the channel's volume, so without
  // this the new voice plays at the wrong level until something else happens
  // to set it.
  //
  // mod-import used to compensate by stamping its own running volume onto
  // every note that lacked a sample number, but an importer cannot know what
  // the slides will have done by the time the row plays: in GSLINGER.MOD
  // pattern 36 a flute swells from 8 to 33 under `A50`, and the very next row
  // -- a plain note with no sample number -- reset it to the sample's default
  // 8 and threw the swell away.
  if (triggeredNote) {
    pushVolume(state.currentVolume);
  }

  // Handle effect parameters (use memory if param is 0 where applicable)
  switch (effect?.type) {
    case 'portaUp':
      state.portamentoSpeed =
        effect.paramX * 16 + effect.paramY || state.lastPortaUp;
      state.lastPortaUp = state.portamentoSpeed;
      break;

    case 'portaDown':
      state.portamentoSpeed = -(
        effect.paramX * 16 + effect.paramY || state.lastPortaDown
      );
      state.lastPortaDown = Math.abs(state.portamentoSpeed);
      break;

    case 'tonePorta':
      state.tonePortaSpeed = resolveTonePortaSpeed(
        state,
        effect.paramX,
        effect.paramY,
      );
      // Always restore remembered target so 3xx rows without notes keep sliding.
      if (state.lastTonePortaTargetFreq !== undefined) {
        state.targetFrequency = state.lastTonePortaTargetFreq;
      }
      if (state.lastTonePortaTargetPeriod !== undefined) {
        state.targetPeriod = state.lastTonePortaTargetPeriod;
      }
      state.tonePortaActive = state.tonePortaSpeed > 0;
      // Real ProTracker/FT2 never applies tone portamento (or any other
      // per-tick slide effect) on tick 0 -- tick 0 is only when the row is
      // read and any new note triggered; the target set here starts
      // sliding from tick 1 (see processEffectTickN's 'tonePorta' case).
      // An "apply on tick 0 too" step used to live here, which -- now that
      // TimingSystem.setSpeed() correctly keeps ticksPerRow in sync with
      // speed (see its comment) -- would double up with tick 1's own step
      // and slide one increment further per row than authentic ProTracker.
      break;

    case 'vibrato':
      if (effect.paramX) state.vibratoSpeed = effect.paramX;
      if (effect.paramY) state.vibratoDepth = effect.paramY;
      state.lastVibrato = (state.vibratoSpeed << 4) | state.vibratoDepth;
      break;

    case 'tonePortaVol':
      // 5xy: tone portamento continues *and* a volume slide applies.
      //
      // The parameter belongs entirely to the volume slide (x = up, y = down)
      // -- see primeVolumeSlide below, which reads the very same nibbles. The
      // slide speed is NOT in this command; it carries over from the last 3xx.
      //
      // Feeding these nibbles to resolveTonePortaSpeed (as this used to do)
      // therefore reinterprets a volume-slide parameter as a pitch-slide
      // speed, and because that helper also *writes* state.lastTonePorta it
      // destroys the remembered 3xx speed for every following row. A run like
      // GSLINGER.MOD pattern 4 -- "3F0" (speed 240) then a long tail of
      // 300/500/501 -- collapsed to speed 1 the moment the first 501 landed,
      // so the pitch crawled instead of reaching each target and the whole
      // passage drifted badly out of tune.
      state.tonePortaSpeed =
        state.lastTonePorta > 0 ? state.lastTonePorta : state.tonePortaSpeed;
      if (state.lastTonePortaTargetFreq !== undefined) {
        state.targetFrequency = state.lastTonePortaTargetFreq;
      }
      if (state.lastTonePortaTargetPeriod !== undefined) {
        state.targetPeriod = state.lastTonePortaTargetPeriod;
      }
      state.tonePortaActive = state.tonePortaSpeed > 0;
      primeVolumeSlide(state, effect);
      if (
        state.volumeSlide.mode === 'normal' &&
        state.volumeSlide.delta !== 0
      ) {
        pushVolume(state.currentVolume);
      }
      // No slide on tick 0 -- see the 'tonePorta' case above for why.
      break;

    case 'vibratoVol':
      // Vibrato continues, volume slide applies
      primeVolumeSlide(state, effect);
      if (
        state.volumeSlide.mode === 'normal' &&
        state.volumeSlide.delta !== 0
      ) {
        pushVolume(state.currentVolume);
      }
      break;

    case 'tremolo':
      if (effect.paramX) state.tremoloSpeed = effect.paramX;
      if (effect.paramY) state.tremoloDepth = effect.paramY;
      state.lastTremolo = (state.tremoloSpeed << 4) | state.tremoloDepth;
      break;

    case 'arpeggio':
      state.arpeggioX = effect.paramX;
      state.arpeggioY = effect.paramY;
      state.arpeggioTick = 0;
      state.lastArpeggio = (effect.paramX << 4) | effect.paramY;
      // Tick 0: play base note
      pushPitch(state.currentFrequency);
      break;

    case 'volSlide': {
      // Distinguish between normal Axy volume slide and fine EAx/EBx slides.
      primeVolumeSlide(state, effect);
      if (
        state.volumeSlide.mode === 'normal' &&
        state.volumeSlide.delta !== 0
      ) {
        // Emit current volume so schedulers have a starting point before per-tick slides.
        pushVolume(state.currentVolume);
      }
      if (state.volumeSlide.mode === 'fine' && state.volumeSlide.delta !== 0) {
        state.currentVolume = clampVolume(
          state.currentVolume + state.volumeSlide.delta,
        );
        pushVolume(state.currentVolume);
        resetVolumeSlide(state);
      }
      break;
    }

    case 'extEffect':
      // Exy sub-commands that affect per-track state but don't have dedicated types.
      if (effect.extSubtype === 'glissandoCtrl') {
        // E3x: Glissando control (0=off, >0=on)
        const raw = effect.paramY | (effect.paramX << 4);
        state.glissandoEnabled = raw !== 0;
      } else if (effect.extSubtype === 'setFinetune') {
        // E5x: retune the note on this row.
        //
        // The nibble's meaning is format-specific -- ProTracker reads it as a
        // signed value, FT2 as an unsigned position in its finetune range, and
        // they disagree by a full semitone for every nibble under 8. See
        // FormatProfile.finetuneFromNibble.
        //
        // Applied only to the note this row triggers, and not remembered for
        // later notes on the channel as the trackers do. Every E5x in the
        // local MOD and XM corpora sits on a row that carries a note, so the
        // difference has yet to come up; persisting it properly means undoing
        // the sample's own finetune, which this engine bakes into the
        // instrument patch as a fixed detune.
        const semitones = state.profile.finetuneFromNibble(
          effect.paramY & 0x0f,
        );
        const ratio = Math.pow(2, semitones / 12);
        state.targetFrequency *= ratio;
        state.targetMidi = frequencyToMidi(state.targetFrequency);
        state.targetPeriod = state.profile.pitch.periodFromFrequency(
          state.targetFrequency,
        );
        updatePitchFromFrequency(state, state.currentFrequency * ratio);
        pushPitch(state.currentFrequency);
      }
      break;

    case 'setVolume':
      // Cxx: Set volume (00-40 in FT2, we scale to 0-1)
      state.currentVolume = Math.min(
        1,
        (effect.paramX * 16 + effect.paramY) / 64,
      );
      pushVolume(state.currentVolume);
      break;

    case 'setPan':
      if (effect.extSubtype === 'setPan') {
        // E8y: coarse panning, a single 4-bit nibble (0=left, 15=right).
        // This shares the 'setPan' EffectType with the full-byte 8xx
        // command, but encodes its value completely differently: 8xx's
        // paramX/paramY are the two nibbles of one 0-255 byte, while E8y's
        // paramX is just the extended-effect subtype marker (8) and paramY
        // is the real (0-15) value. Running E8y through the 8xx formula
        // (paramX*16+paramY-128)/128 treats the "8" subtype marker as part
        // of the pan byte, producing a near-silent, barely-left-of-center
        // result regardless of the actual nibble.
        state.currentPan = (effect.paramY / 15) * 2 - 1;
      } else {
        // 8xx: Set panning (00=left, 80=center, FF=right)
        state.currentPan = (effect.paramX * 16 + effect.paramY - 128) / 128;
      }
      pushPan(state.currentPan);
      break;

    case 'finePortaUp':
      // E1x: Fine portamento up (applied once on tick 0)
      applyFinePortamento(state, effect.paramY);
      pushPitch(state.currentFrequency);
      break;

    case 'finePortaDown':
      // E2x: Fine portamento down (applied once on tick 0)
      applyFinePortamento(state, -effect.paramY);
      pushPitch(state.currentFrequency);
      break;

    case 'extraFinePorta':
      // Xxy (XM 0x21): x=1 up, x=2 down, by y period units -- a quarter of
      // E1x/E2x's step, so it passes an explicit unit scale of 1.
      if (effect.paramX === 1) {
        applyFinePortamento(state, effect.paramY, 1);
        pushPitch(state.currentFrequency);
      } else if (effect.paramX === 2) {
        applyFinePortamento(state, -effect.paramY, 1);
        pushPitch(state.currentFrequency);
      }
      break;

    case 'setVibratoWave':
      // Bit 2 means "do not restart the waveform on a new note".
      state.vibratoWaveform = effect.paramY & 3;
      state.vibratoRetrigger = (effect.paramY & 4) === 0;
      break;

    case 'setTremoloWave':
      state.tremoloWaveform = effect.paramY & 3;
      state.tremoloRetrigger = (effect.paramY & 4) === 0;
      break;

    case 'noteCut':
      // ECx: Note cut after x ticks.
      //
      // "Cut" here means *set the channel volume to zero*, not release the
      // note: ProTracker writes n_volume = 0 and FT2 does the same. Sending a
      // noteOff instead (as this used to) runs the release path -- on XM that
      // means the instrument's volume fadeout, which can take seconds, so
      // EC2 on a sustained note faded slowly away rather than stopping dead.
      // The channel stays silent until something sets its volume again, which
      // is also what the trackers do.
      state.noteCutTick = effect.paramY;
      if (state.noteCutTick === 0) {
        state.currentVolume = 0;
        pushVolume(0);
        state.noteCutTick = -1;
      }
      break;

    case 'noteDelay': {
      // EDx: Note delay by x ticks
      state.noteDelayTick = effect.paramY;
      if (newNote !== undefined && newVelocity !== undefined) {
        state.delayedNote = {
          midi: newNote,
          velocity: newVelocity,
          ...(noteFrequency !== undefined ? { frequency: noteFrequency } : {}),
        };
        // If delay exceeds or equals the current speed, ProTracker spills to the next row.
        if (ticksPerRow !== undefined && state.noteDelayTick >= ticksPerRow) {
          // ProTracker leaks an over-long EDx into the next row; formats
          // without that quirk simply drop the note.
          state.carryDelayedNote = state.profile.noteDelayOverflowCarries
            ? state.delayedNote
            : null;
          state.delayedNote = undefined;
          state.noteDelayTick = -1;
        }
        // Don't trigger on tick 0
      }
      break;
    }

    case 'retrigVol': {
      // Rxy: Retrigger with volume slide
      // E9x: Retrigger without volume slide (mapped via extSubtype === 'retrigger')
      //
      // FT2 remembers Rxy's nibbles independently, so R03 then R80 keeps
      // interval 3 while changing the volume change, and a bare R00 repeats
      // the last retrigger outright. E9x has no such memory.
      const isExtended = effect.extSubtype === 'retrigger';
      let interval = effect.paramY;
      let volChange = isExtended ? 0 : effect.paramX;
      if (!isExtended) {
        if (interval === 0) interval = state.lastRetrigger & 0x0f;
        if (volChange === 0) volChange = (state.lastRetrigger >> 4) & 0x0f;
        state.lastRetrigger = (volChange << 4) | interval;
      }
      state.retriggerInterval = interval;
      state.retriggerTick = 0;
      state.retriggerVolChange = volChange;
      break;
    }

    case 'keyOff':
      // Kxx: Key off after xx ticks
      if (effect.paramX * 16 + effect.paramY === 0) {
        commands.push({ kind: 'noteOff' });
      }
      break;

    case 'fineVibrato':
      // Uxy: Fine vibrato (smaller depth)
      if (effect.paramX) state.vibratoSpeed = effect.paramX;
      if (effect.paramY) state.vibratoDepth = effect.paramY / 4; // Quarter depth
      break;

    case 'panSlide':
      if (effect.paramX) state.panSlideSpeed = effect.paramX / 64;
      else if (effect.paramY) state.panSlideSpeed = -effect.paramY / 64;
      break;

    case 'tremor': {
      // Txy: the on/off lengths, with FT2's parameter memory. The cycle
      // position itself is deliberately not reset -- see state.tremorPos.
      const raw = (effect.paramX << 4) | effect.paramY;
      if (raw !== 0) state.lastTremor = raw;
      break;
    }

    case 'sampleOffset':
      // Nothing more to do. When a note starts on this row the offset already
      // rode along with the noteOn (see pendingSampleOffsetFrames), and a 9xx
      // on a row *without* a note is inaudible in both ProTracker and FT2: it
      // only updates the channel's offset memory (state.lastSampleOffset,
      // written above), because the offset is consumed where the sample's
      // playback pointer is armed, which only happens on a note trigger.
      //
      // This used to emit a standalone sampleOffset command, which latched
      // the value on the instrument to be applied to whatever note came next
      // -- even a note on a different channel, and even one carrying no 9xx
      // of its own. That started notes mid-waveform that should have started
      // at zero, which is heard as a click.
      break;

    default:
      break;
  }

  // Ensure we emit at least one pitch command to keep schedulers in sync
  if (!commands.some((cmd) => cmd.kind === 'pitch')) {
    pushPitch(state.currentFrequency);
  }

  return { commands };
}

/**
 * Process effect for ticks 1-N of a row
 */
export function processEffectTickN(
  state: TrackEffectState,
  effect: EffectCommand | undefined,
  tick: number,
  _ticksPerRow: number,
): TickCommandBatch {
  const commands: ProcessorCommand[] = [];
  const voiceIndex = state.voiceIndex >= 0 ? state.voiceIndex : undefined;

  const pushPitch = (frequency: number) => {
    const cmd: ProcessorCommand =
      voiceIndex !== undefined
        ? { kind: 'pitch', frequency, voiceIndex }
        : { kind: 'pitch', frequency };
    commands.push(cmd);
  };

  const pushVolume = (volume: number) => {
    const cmd: ProcessorCommand =
      voiceIndex !== undefined
        ? { kind: 'volume', volume, voiceIndex }
        : { kind: 'volume', volume };
    commands.push(cmd);
  };

  const pushPan = (pan: number) => {
    commands.push({ kind: 'pan', pan });
  };

  // Check for note cut. ECx zeroes the channel volume rather than releasing
  // the note -- see the 'noteCut' case in processEffectTick0.
  if (state.noteCutTick === tick) {
    state.currentVolume = 0;
    pushVolume(0);
    state.noteCutTick = -1;
  }

  // Check for note delay
  if (state.noteDelayTick === tick && state.delayedNote) {
    const delayed = state.delayedNote;
    // Preserve the MOD's exact period-derived pitch instead of recomputing
    // it from the rounded MIDI note (which discards finetune/period
    // precision and can land several cents off).
    const frequency = delayed.frequency ?? midiToFrequency(delayed.midi);
    commands.push({
      kind: 'noteOn',
      midi: delayed.midi,
      velocity: 127,
      frequency,
    });
    state.currentMidi = delayed.midi;
    if (delayed.frequency !== undefined) {
      updatePitchFromPeriod(
        state,
        state.profile.pitch.periodFromFrequency(delayed.frequency),
      );
    }
    state.currentFrequency = frequency;
    state.targetMidi = delayed.midi;
    state.targetFrequency = state.currentFrequency;
    state.targetPeriod = undefined;
    state.currentVolume = delayed.velocity / 255;
    state.delayedNote = undefined;
    state.noteDelayTick = -1;
    pushPitch(state.currentFrequency);
    pushVolume(state.currentVolume);
  }

  if (!effect) {
    // Continue an active tone portamento when no effect is present (e.g., across pattern boundaries).
    if (state.tonePortaActive && state.tonePortaSpeed > 0) {
      const beforeFreq = state.currentFrequency;
      const freq = applyTonePortaStep(state);
      const moved = Math.abs(freq - beforeFreq) > 1e-9;
      if (moved) {
        pushPitch(freq);
      }
      if (state.targetFrequency === state.currentFrequency) {
        state.tonePortaActive = false;
      }
    }
    return { commands };
  }

  switch (effect.type) {
    case 'portaUp':
      // Slide pitch up
      applyPortamentoStep(state);
      pushPitch(state.currentFrequency);
      break;

    case 'portaDown':
      // Slide pitch down
      applyPortamentoStep(state);
      pushPitch(state.currentFrequency);
      break;

    case 'tonePorta':
    case 'tonePortaVol': {
      const beforeFreq = state.currentFrequency;
      const freq = applyTonePortaStep(state);
      const moved = Math.abs(freq - beforeFreq) > 1e-9;
      if (moved) {
        pushPitch(freq);
      }
      if (state.targetFrequency === state.currentFrequency) {
        state.tonePortaActive = false;
      }

      // Handle volume slide for 5xy
      if (effect.type === 'tonePortaVol') {
        const slid = applyVolumeSlideIfNeeded(state);
        if (slid !== undefined) {
          pushVolume(slid);
        }
      }
      break;
    }

    case 'vibrato':
    case 'fineVibrato':
      // Apply vibrato
      state.vibratoPos += state.vibratoSpeed;
      pushPitch(
        vibratoFrequency(
          state,
          getWaveformValue(state.vibratoPos, state.vibratoWaveform),
        ),
      );
      break;

    case 'vibratoVol':
      // Vibrato + volume slide
      state.vibratoPos += state.vibratoSpeed;
      pushPitch(
        vibratoFrequency(
          state,
          getWaveformValue(state.vibratoPos, state.vibratoWaveform),
        ),
      );
      {
        const slid = applyVolumeSlideIfNeeded(state);
        if (slid !== undefined) {
          pushVolume(slid);
        }
      }
      break;

    case 'tremolo':
      // Apply tremolo (volume oscillation)
      state.tremoloPos += state.tremoloSpeed;
      const tremoloOffset = getWaveformValue(
        state.tremoloPos,
        state.tremoloWaveform,
      );
      // ProTracker: volumeDelta(0-64) = (tremoloTable[pos] * depth) / 64, with
      // a table peaking at 255 -- so a depth of x swings volume by about +-4x
      // of 64. Dividing the -1..1 waveform by 64 directly (as this used to)
      // dropped the peak factor and made every tremolo a quarter as deep as
      // it should be, which is why tremolo was barely audible.
      const tremoloAmount =
        (tremoloOffset * VIBRATO_TABLE_PEAK * state.tremoloDepth) /
        TREMOLO_DEPTH_DIVISOR /
        64;
      pushVolume(Math.max(0, Math.min(1, state.currentVolume + tremoloAmount)));
      break;

    case 'arpeggio': {
      // Cycle through base, +x semitones, +y semitones
      state.arpeggioTick = (state.arpeggioTick + 1) % 3;
      const offset =
        state.arpeggioTick === 1
          ? state.arpeggioX
          : state.arpeggioTick === 2
            ? state.arpeggioY
            : 0;

      if (state.currentPeriod !== undefined) {
        const period = state.profile.pitch.arpeggioPeriod(
          state.currentPeriod,
          offset,
        );
        pushPitch(
          period === 0 ? 0 : state.profile.pitch.frequencyFromPeriod(period),
        );
      } else {
        let arpeggioNote = state.currentMidi;
        arpeggioNote += offset;
        pushPitch(midiToFrequency(arpeggioNote));
      }
      break;
    }

    case 'volSlide':
      if (state.volumeSlide.mode === 'normal') {
        const slid = applyVolumeSlideIfNeeded(state);
        if (slid !== undefined) {
          pushVolume(slid);
        }
      }
      break;

    case 'panSlide':
      state.currentPan = Math.max(
        -1,
        Math.min(1, state.currentPan + state.panSlideSpeed),
      );
      pushPan(state.currentPan);
      break;

    case 'retrigVol':
      // Retrigger note
      state.retriggerTick++;
      if (
        state.retriggerInterval > 0 &&
        state.retriggerTick >= state.retriggerInterval
      ) {
        state.retriggerTick = 0;

        // Apply volume change (Rxy only; E9x uses extSubtype 'retrigger' and keeps volume)
        if (effect.extSubtype !== 'retrigger') {
          switch (state.retriggerVolChange) {
            case 1:
              state.currentVolume -= 1 / 64;
              break;
            case 2:
              state.currentVolume -= 2 / 64;
              break;
            case 3:
              state.currentVolume -= 4 / 64;
              break;
            case 4:
              state.currentVolume -= 8 / 64;
              break;
            case 5:
              state.currentVolume -= 16 / 64;
              break;
            case 6:
              state.currentVolume *= 2 / 3;
              break;
            case 7:
              state.currentVolume *= 0.5;
              break;
            case 9:
              state.currentVolume += 1 / 64;
              break;
            case 10:
              state.currentVolume += 2 / 64;
              break;
            case 11:
              state.currentVolume += 4 / 64;
              break;
            case 12:
              state.currentVolume += 8 / 64;
              break;
            case 13:
              state.currentVolume += 16 / 64;
              break;
            case 14:
              state.currentVolume *= 1.5;
              break;
            case 15:
              state.currentVolume *= 2;
              break;
          }
          state.currentVolume = Math.max(0, Math.min(1, state.currentVolume));
        }

        commands.push({
          kind: 'retrigger',
          midi: state.currentMidi,
          velocity: Math.round(state.currentVolume * 127),
          // state.currentFrequency already tracks the exact ProTracker
          // period-derived pitch of whatever's currently sounding; use it
          // instead of letting the downstream handler fall back to
          // midiToFrequency(currentMidi), which discards finetune/period
          // precision and can land the retrigger several cents off pitch.
          frequency: state.currentFrequency,
        });
      }
      break;

    case 'tremor': {
      // Txy: sound on for x+1 ticks, off for y+1 ticks, counted continuously
      // across rows rather than from this row's tick index.
      const raw = ((effect.paramX << 4) | effect.paramY) || state.lastTremor;
      const onTicks = ((raw >> 4) & 0x0f) + 1;
      const offTicks = (raw & 0x0f) + 1;
      const inOnPhase = state.tremorPos < onTicks;
      state.tremorPos = (state.tremorPos + 1) % (onTicks + offTicks);
      pushVolume(inOnPhase ? state.currentVolume : 0);
      break;
    }

    case 'keyOff':
      const keyOffTick = effect.paramX * 16 + effect.paramY;
      if (tick === keyOffTick) {
        commands.push({ kind: 'noteOff' });
      }
      break;

    default:
      break;
  }

  return { commands };
}

/**
 * Whether a volume-column command has per-tick work, i.e. whether ticks 1..n
 * need processing for it at all.
 */
export function volumeCommandIsTickBased(
  command: VolumeColumnCommand | undefined,
): boolean {
  switch (command?.type) {
    case 'volSlideDown':
    case 'volSlideUp':
    case 'panSlideLeft':
    case 'panSlideRight':
    case 'vibrato':
      return true;
    default:
      return false;
  }
}

/**
 * Tick 0 of a FastTracker 2 volume-column command.
 *
 * Runs *before* the row's effect-column command, which is the order FT2 uses:
 * the volume column is read while the note is being set up, the effect column
 * immediately after, so where both write the same thing the effect column
 * wins.
 *
 * Only the commands that act immediately do anything here. The slides merely
 * arm themselves; processVolumeColumnTickN applies them.
 */
export function processVolumeColumnTick0(
  state: TrackEffectState,
  command: VolumeColumnCommand | undefined,
): TickCommandBatch {
  const commands: ProcessorCommand[] = [];
  const voiceIndex = state.voiceIndex >= 0 ? state.voiceIndex : undefined;

  const push = (cmd: ProcessorCommand) => commands.push(cmd);
  const pushVolume = (volume: number) =>
    push(
      voiceIndex !== undefined
        ? { kind: 'volume', volume, voiceIndex }
        : { kind: 'volume', volume },
    );
  const pushPan = (pan: number) =>
    push(
      voiceIndex !== undefined
        ? { kind: 'pan', pan, voiceIndex }
        : { kind: 'pan', pan },
    );

  // A new row re-arms the column's own slides from scratch; unlike the effect
  // column's Axy, FT2's volume-column slides have no parameter memory.
  state.volumeColumnSlide = 0;
  state.volumeColumnPanSlide = 0;

  if (!command) return { commands };

  const unit = state.profile.volumeSlideUnit;

  switch (command.type) {
    case 'volSlideDown':
      state.volumeColumnSlide = -command.value * unit;
      // Emit the starting point so a scheduler has something to slide from.
      if (state.volumeColumnSlide !== 0) pushVolume(state.currentVolume);
      break;

    case 'volSlideUp':
      state.volumeColumnSlide = command.value * unit;
      if (state.volumeColumnSlide !== 0) pushVolume(state.currentVolume);
      break;

    case 'fineVolDown':
      state.currentVolume = clampVolume(state.currentVolume - command.value * unit);
      pushVolume(state.currentVolume);
      break;

    case 'fineVolUp':
      state.currentVolume = clampVolume(state.currentVolume + command.value * unit);
      pushVolume(state.currentVolume);
      break;

    case 'vibratoSpeed':
      // Sets the speed for later vibrato without starting one of its own.
      if (command.value) state.vibratoSpeed = command.value;
      break;

    case 'vibrato':
      // Depth only; the speed is whatever the channel last had (from 4xy or
      // from an earlier 0xAx).
      if (command.value) state.vibratoDepth = command.value;
      break;

    case 'setPan':
      // FT2 stores this as `pan = x << 4`, so the column reaches 0 (hard left)
      // and 128 (centre) exactly but tops out at 240 rather than 255. That
      // asymmetry is FT2's, not a rounding slip here.
      state.currentPan = ((command.value << 4) / 128) - 1;
      pushPan(state.currentPan);
      break;

    case 'panSlideLeft':
      state.volumeColumnPanSlide = -command.value / 64;
      break;

    case 'panSlideRight':
      state.volumeColumnPanSlide = command.value / 64;
      break;

    case 'tonePorta':
      // Sets the speed only; the target is whatever note the row supplied,
      // which processEffectTick0 has already resolved. A zero parameter keeps
      // the remembered speed, as 300 does.
      if (command.value > 0) {
        state.tonePortaSpeed = command.value;
        state.lastTonePorta = command.value;
      } else if (state.lastTonePorta > 0) {
        state.tonePortaSpeed = state.lastTonePorta;
      }
      state.tonePortaActive = state.tonePortaSpeed > 0;
      break;
  }

  return { commands };
}

/**
 * Ticks 1..n of a FastTracker 2 volume-column command.
 */
export function processVolumeColumnTickN(
  state: TrackEffectState,
  command: VolumeColumnCommand | undefined,
): TickCommandBatch {
  const commands: ProcessorCommand[] = [];
  if (!command) return { commands };

  const voiceIndex = state.voiceIndex >= 0 ? state.voiceIndex : undefined;

  switch (command.type) {
    case 'volSlideDown':
    case 'volSlideUp': {
      if (state.volumeColumnSlide === 0) break;
      state.currentVolume = clampVolume(
        state.currentVolume + state.volumeColumnSlide,
      );
      commands.push(
        voiceIndex !== undefined
          ? { kind: 'volume', volume: state.currentVolume, voiceIndex }
          : { kind: 'volume', volume: state.currentVolume },
      );
      break;
    }

    case 'panSlideLeft':
    case 'panSlideRight': {
      if (state.volumeColumnPanSlide === 0) break;
      state.currentPan = Math.max(
        -1,
        Math.min(1, state.currentPan + state.volumeColumnPanSlide),
      );
      commands.push(
        voiceIndex !== undefined
          ? { kind: 'pan', pan: state.currentPan, voiceIndex }
          : { kind: 'pan', pan: state.currentPan },
      );
      break;
    }

    case 'vibrato': {
      state.vibratoPos += state.vibratoSpeed;
      const frequency = vibratoFrequency(
        state,
        getWaveformValue(state.vibratoPos, state.vibratoWaveform),
      );
      commands.push(
        voiceIndex !== undefined
          ? { kind: 'pitch', frequency, voiceIndex }
          : { kind: 'pitch', frequency },
      );
      break;
    }

    default:
      break;
  }

  return { commands };
}

/**
 * Reset effect state for a new note
 */
export function resetEffectStateForNote(state: TrackEffectState): void {
  if (state.vibratoRetrigger) state.vibratoPos = 0;
  if (state.tremoloRetrigger) state.tremoloPos = 0;
  state.arpeggioTick = 0;
  state.retriggerTick = 0;
  state.noteCutTick = -1;
  state.noteDelayTick = -1;
  state.delayedNote = undefined;
  state.tonePortaActive = false;
}
