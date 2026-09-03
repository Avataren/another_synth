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
    return state.currentFrequency * Math.pow(2, -semitones / 12);
  }
  const pitch = state.profile.pitch;
  const delta =
    ((wave * VIBRATO_TABLE_PEAK * state.vibratoDepth) / VIBRATO_DEPTH_DIVISOR) *
    state.profile.portamentoUnitScale;
  // The offset is *added* to the period, so the first half of the waveform
  // bends the pitch down and the second half up.
  //
  // ProTracker and FT2 both branch on the sign of the vibrato position and
  // add the delta to the period while it is positive; subtracting instead
  // inverts the whole waveform. That is inaudible on a fast vibrato -- it only
  // shifts the phase -- but jt_911.xm holds `41F` (speed 1, depth 15) for a
  // full cycle of about ten rows, so an inverted phase leaves the channel
  // nearly two semitones sharp for five rows where it should be flat, against
  // other channels holding the chord.
  //
  // Note the tremolo below has always added its offset to the volume, which is
  // the same convention; period is inverted relative to pitch, which is what
  // made this one look right.
  return pitch.frequencyFromPeriod(pitch.clampPeriod(period + delta));
}

/**
 * One tick of vibrato: take the sample at the current position, then advance.
 *
 * The order matters and was wrong. Both replayers read the waveform at the
 * position they already hold and only then move it on -- `doVibrato` in
 * ft2_replayer.c ends with `ch->vibratoPos += ch->vibratoSpeed;`, and
 * `vibrato2` in pt2_replayer.c with `ch->n_vibratopos += (ch->n_vibratocmd >> 2)
 * & 0x3C;`. Neither runs vibrato on tick 0 at all: FT2 has `dummy` at slot 4
 * of `JumpTab_TickZero`, and ProTracker's tick 0 goes through `setPeriod` ->
 * `checkMoreEffects`, which handles only 9/B/C/D/E/F. A note trigger zeroes the
 * position (`if ((ch->n_wavecontrol & 0x04) == 0) ch->n_vibratopos = 0;`).
 *
 * So the first vibrato tick of a fresh note reads position 0, whose sample is
 * zero -- the note's own pitch -- and the deviation only starts on the tick
 * after. Advancing first, as this used to, made every vibrato start one step
 * into the wave: at `4x8` (speed 4, depth 8) the very first tick jumped
 * straight to a 6.1-period offset instead of 0, and the whole wave ran a
 * 64th of a cycle early for as long as the note lasted. 6880 MOD and 25124 XM
 * vibrato commands in the corpus, plus every 6xy.
 */
function advanceVibrato(state: TrackEffectState): number {
  const wave = getWaveformValue(state.vibratoPos, state.vibratoWaveform);
  state.vibratoApplied = true;
  state.vibratoHeldWave = wave;
  const frequency = vibratoFrequency(state, wave);
  state.vibratoPos += state.vibratoSpeed;
  return frequency;
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

  // Arpeggio state
  arpeggioX: number;
  arpeggioY: number;

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

    arpeggioX: 0,
    arpeggioY: 0,

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
 * ProTracker's and FastTracker 2's shared vibrato/tremolo sine table, byte for
 * byte -- `vibratoTable` in pt2_tables.c and `vibratoTab` in ft2_tables.c hold
 * the same 32 values. It is a *half* sine, 255 * sin(pi * i / 32); the second
 * half of the cycle is the same table read again with the offset subtracted
 * instead of added.
 */
const REFERENCE_SINE_TABLE = [
  0, 24, 49, 74, 97, 120, 141, 161, 180, 197, 212, 224, 235, 244, 250, 253, 255,
  253, 250, 244, 235, 224, 212, 197, 180, 161, 141, 120, 97, 74, 49, 24,
] as const;

/**
 * One sample of a vibrato/tremolo waveform, normalised to -1..1 against the
 * tables' peak of 255.
 *
 * The reference keeps its position in an 8-bit counter and reads
 * `(pos >> 2) & 0x1F` out of a 32-entry table, taking the sign from whether
 * the counter's top bit is set. `pos` here is that counter divided by four,
 * i.e. 64 steps per cycle with the sign flipping at 32, which is what the
 * callers advance.
 *
 * Two of the four waveforms were wrong before this was checked against the C:
 *
 * - The **ramp** was `1 - 2 * phase`, a sawtooth falling from +1 to -1. Both
 *   replayers build it as `tmpVib = (pos >> 2 & 31) << 3` -- rising 0..248 --
 *   negated in the second half by `~tmpVib` (FT2) / `255 - tmpVib` (PT), and
 *   then *subtracted* rather than added there. That is a sawtooth *rising*
 *   from 0 to +1, jumping to -1 and rising back to 0: the opposite direction
 *   and a quarter-cycle out of phase.
 * - **Waveform 3 was random.** Neither replayer has a random waveform. Both
 *   switch on the two low bits with `default:` covering 2 *and* 3, and both
 *   defaults set the value to a flat 255 -- a square wave. A random waveform
 *   also made playback non-deterministic, which no tracker output is.
 *
 * (No module in the 61-file corpus selects a waveform at all -- there is not
 * one E4x or E7x in it -- so this fixes nothing audible today. It is fixed
 * because it is checkable and was checked.)
 */
function getWaveformValue(pos: number, waveform: number): number {
  const p = pos & 63;
  const index = p & 31;
  const negative = p >= 32;

  let value: number;
  switch (waveform & 3) {
    case 1: // Ramp
      value = negative ? -(255 - (index << 3)) : index << 3;
      return value / 255;
    case 2:
    case 3: // Square -- the reference's `default:` arm covers both
      return negative ? -1 : 1;
    default: // Sine
      value = REFERENCE_SINE_TABLE[index]!;
      return (negative ? -value : value) / 255;
  }
}

function clampVolume(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * The channel volume as a note-on velocity.
 *
 * A note has to *start* at the channel's volume, not merely be corrected to it
 * afterwards. The instrument sets a fresh voice's gain from the velocity it is
 * handed, and the volume command that follows can legitimately fail to apply
 * -- `TrackerSongBank.setVoiceVolumeAtTime` drops a command it cannot resolve
 * to a voice on this track, which is the right call because two tracks sharing
 * a sample share a voice pool. Whatever the note-on carries is therefore the
 * level the note is heard at whenever that happens.
 *
 * This used to be a hardcoded 127. That was survivable only because the
 * sample's default volume was also baked into the instrument gain, so the
 * fallback landed on roughly the right level by accident; with that removed
 * (D53) a hardcoded 127 means full scale. GSLINGER.MOD pattern 2 is the case:
 * the flute echo on channel 3 plays at volume 11 against the lead's 24, and
 * any note whose volume command did not land came out at 64.
 */
function velocityFromVolume(volume: number): number {
  return Math.round(clampVolume(volume) * 127);
}

function resetVolumeSlide(state: TrackEffectState): void {
  state.volumeSlide = { delta: 0, mode: 'none', source: null };
}

/**
 * The per-tick volume change a slide parameter asks for, as a fraction of full
 * scale, applying the format's parameter memory.
 *
 * FT2's `volSlide` is the whole of it:
 *
 *   static void volSlide(channel_t *ch, uint8_t param)
 *   {
 *       if (param == 0)
 *           param = ch->volSlideSpeed;
 *       ch->volSlideSpeed = param;
 *       uint8_t newVol = ch->realVol;
 *       if ((param & 0xF0) == 0) { newVol -= param; ... }
 *       else { param >>= 4; newVol += param; ... }
 *   }
 *
 * Two things follow. The up nibble wins outright -- a `A12` slides *up* by 1
 * and the 2 is never read -- and the memory is a single per-channel byte.
 *
 * ProTracker's `volumeSlide` is the same nibble precedence with no memory: it
 * reads `ch->n_cmd & 0xFF` directly, so `A00` there is a genuine no-op. That
 * is what `volumeSlideHasMemory` selects between.
 */
function resolveVolumeSlideDelta(
  state: TrackEffectState,
  paramX: number,
  paramY: number,
): number {
  let raw = ((paramX & 0x0f) << 4) | (paramY & 0x0f);
  if (state.profile.volumeSlideHasMemory) {
    if (raw === 0) raw = state.lastVolSlide;
    state.lastVolSlide = raw;
  }

  const scale = state.profile.volumeSlideUnit;
  const up = (raw >> 4) & 0x0f;
  const down = raw & 0x0f;
  if (up) return up * scale;
  if (down) return -down * scale;
  return 0;
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
    if (delta === 0) {
      resetVolumeSlide(state);
      return;
    }
    state.volumeSlide = { delta, mode, source };
  };

  switch (effect.type) {
    case 'volSlide': {
      // EAx / EBx are single-step fine slides that happen to share this
      // EffectType; they are not the per-tick Axy slide and have no memory.
      // Where the format has fine-slide memory (FT2), a zero parameter
      // repeats the last fine slide in the same direction:
      // `if (param == 0) param = ch->fVolSlideUpSpeed; ch->fVolSlideUpSpeed
      // = param;` (fineVolSlideUp/fineVolFineDown, ft2_replayer.c).
      if (effect.extSubtype === 'fineVolUp') {
        let param = effect.paramY;
        if (state.profile.fineSlideHasMemory) {
          if (param === 0) param = state.lastFineVolUp;
          state.lastFineVolUp = param;
        }
        setSlide(param * state.profile.volumeSlideUnit, 'fine', 'volSlide');
        return;
      }
      if (effect.extSubtype === 'fineVolDown') {
        let param = effect.paramY;
        if (state.profile.fineSlideHasMemory) {
          if (param === 0) param = state.lastFineVolDown;
          state.lastFineVolDown = param;
        }
        setSlide(-param * state.profile.volumeSlideUnit, 'fine', 'volSlide');
        return;
      }

      setSlide(
        resolveVolumeSlideDelta(state, effect.paramX, effect.paramY),
        'normal',
        'volSlide',
      );
      return;
    }

    // 5xy and 6xy carry no volume slide of their own: FT2's
    // `portamentoPlusVolSlide` and `vibratoPlusVolSlide` each end by calling
    // the very same `volSlide(ch, param)` that Axy uses, and ProTracker's
    // `tonePlusVolSlide` / `vibratoPlusVolSlide` likewise call `volumeSlide`.
    //
    // On XM that means they share Axy's one parameter memory in both
    // directions: a `600` *continues* the channel's last slide rather than
    // doing nothing, and a non-zero 5xy/6xy overwrites what a later `A00`
    // will repeat. Treating their parameter as private, as this used to,
    // silently dropped the slide on 1428 `600` cells in the XM corpus (all in
    // an-path.xm) and let a stale Axy parameter survive across them.
    //
    // ProTracker is unaffected either way: `volumeSlideHasMemory` is false
    // there, so the nibbles are read raw and `600` really is a no-op -- which
    // is what its 612 `600` cells expect.
    case 'tonePortaVol':
      setSlide(
        resolveVolumeSlideDelta(state, effect.paramX, effect.paramY),
        'normal',
        'tonePortaVol',
      );
      return;

    case 'vibratoVol':
      setSlide(
        resolveVolumeSlideDelta(state, effect.paramX, effect.paramY),
        'normal',
        'vibratoVol',
      );
      return;

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
  /**
   * True when this row's XM volume column carries a set-volume command
   * (0x10-0x50). FT2's Rxy quirk reads the volume column *after* its tick-0
   * volume handling and skips the tick-0 retrigger count when that handling
   * consumed it -- `multiNoteRetrig(ch, param, newVolCol)` with the comment
   * "FT2 quirk: this one is changed by vol column effects, then used for a
   * Rxy (multiNoteRetrig) check" (ft2_replayer.c, handleEffects_TickZero).
   */
  volumeColumnVolume?: boolean,
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

  const pushVolume = (
    volume: number,
    ramp?: 'linear' | 'exponential' | 'step',
  ) => {
    const cmd: ProcessorCommand =
      voiceIndex !== undefined
        ? { kind: 'volume', volume, voiceIndex, ...(ramp ? { ramp } : {}) }
        : { kind: 'volume', volume, ...(ramp ? { ramp } : {}) };
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
    pushNoteOn(carry.midi, velocityFromVolume(state.currentVolume));
    state.hasActiveVoice = true;
    pushPitch(state.currentFrequency);
    pushVolume(state.currentVolume);
    return { commands };
  }

  // Apply the row's own volume before the note is triggered, so the note-on
  // can carry the level the note should start at.
  if (newVelocity !== undefined) {
    // newVelocity is in 0-255 range (from MOD importer volume column)
    // Normalize to 0-1 for internal use
    state.currentVolume = newVelocity / 255;
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
        state.targetPeriod =
          state.profile.pitch.periodFromFrequency(targetFreq);
      } else {
        state.targetPeriod = undefined;
      }
      state.lastTonePortaTargetFreq = state.targetFrequency;
      state.lastTonePortaTargetPeriod = state.targetPeriod;
      state.tonePortaActive = state.tonePortaSpeed > 0;
      if (!state.hasActiveVoice) {
        updatePitchFromFrequency(state, targetFreq);
        pushNoteOn(newNote, velocityFromVolume(state.currentVolume));
        state.hasActiveVoice = true;
        triggeredNote = true;
      }
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
        pushNoteOn(newNote, velocityFromVolume(state.currentVolume));
        state.hasActiveVoice = true;
        triggeredNote = true;
      }
    }
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
    pushVolume(state.currentVolume, 'step');
  }

  // Handle effect parameters (use memory if param is 0 where applicable)
  switch (effect?.type) {
    case 'portaUp':
    case 'portaDown': {
      const up = effect.type === 'portaUp';
      const rawParam = effect.paramX * 16 + effect.paramY;
      // GET_LAST_NFO resolves the channel-wide memory BEFORE anything else
      // (st3play digcmd.c opens every slide routine with it), so a zero
      // parameter reuses the last non-zero one and the fine-slide decision
      // is made on the RESOLVED parameter -- an E00 after an EF3 is another
      // one-shot fine step, not a per-tick slide at the 0xE3 speed.
      const resolvedParam =
        rawParam !== 0 ? rawParam : up ? state.lastPortaUp : state.lastPortaDown;
      // S3M: the E/F commands' high parameters (0xE0-0xFF) are one-shot fine
      // slides, not slide speeds. st3play digcmd.c s_slidedown/s_slideup
      // (quoted in D101): on tick 0 a resolved parameter 0xE1-0xEF slides
      // once by `(param & 0x0F)` RAW period units and 0xF1-0xFF by
      // `(param & 0x0F) << 2`; during ticks > 0 such a row slides not at all
      // (`if (ch->info >= 0xE0) return; // no fine slides here`). 0xE0/0xF0
      // move nothing. The raw unit (1, not the <<2 slide scale) is why this
      // cannot ride portamentoUnitScale.
      if (
        state.profile.finePortaHighParameters === true &&
        resolvedParam >= 0xe0
      ) {
        if (resolvedParam >= 0xe1) {
          const units =
            (resolvedParam & 0x0f) * (resolvedParam >= 0xf1 ? 4 : 1);
          if (units > 0) {
            applyFinePortamento(state, up ? units : -units, 1);
            pushPitch(state.currentFrequency);
          }
          if (up) state.lastPortaUp = resolvedParam;
          else state.lastPortaDown = resolvedParam;
        }
        // No persistent slide speed: the fine row is a single step.
        state.portamentoSpeed = 0;
        break;
      }
      if (up) {
        state.portamentoSpeed = resolvedParam;
        state.lastPortaUp = state.portamentoSpeed;
      } else {
        state.portamentoSpeed = -resolvedParam;
        state.lastPortaDown = Math.abs(state.portamentoSpeed);
      }
      break;
    }

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
        // A *fine* slide is a single instantaneous step, not a slide.
        pushVolume(state.currentVolume, 'step');
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
      // Cxx sets the volume, it does not slide to it.
      pushVolume(state.currentVolume, 'step');
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

    case 'finePortaUp': {
      // E1x: Fine portamento up (applied once on tick 0). FT2's
      // finePitchSlideUp remembers its parameter for a zero one.
      let upParam = effect.paramY;
      if (state.profile.fineSlideHasMemory) {
        if (upParam === 0) upParam = state.lastFinePortaUp;
        state.lastFinePortaUp = upParam;
      }
      applyFinePortamento(state, upParam);
      pushPitch(state.currentFrequency);
      break;
    }

    case 'finePortaDown': {
      // E2x: Fine portamento down (applied once on tick 0), with FT2's
      // fPitchSlideDownSpeed memory.
      let downParam = effect.paramY;
      if (state.profile.fineSlideHasMemory) {
        if (downParam === 0) downParam = state.lastFinePortaDown;
        state.lastFinePortaDown = downParam;
      }
      applyFinePortamento(state, -downParam);
      pushPitch(state.currentFrequency);
      break;
    }

    case 'setEnvelopePos': {
      // Lxx (XM 0x15): move the envelopes to tick xx. The note keeps playing
      // from where it is; only the envelope's read position moves.
      const tick = effect.paramX * 16 + effect.paramY;
      commands.push(
        voiceIndex !== undefined
          ? { kind: 'envelopePosition', tick, voiceIndex }
          : { kind: 'envelopePosition', tick },
      );
      break;
    }

    case 'extraFinePorta': {
      // Xxy (XM 0x21): x=1 up, x=2 down, by y period units -- a quarter of
      // E1x/E2x's step, so it passes an explicit unit scale of 1. FT2 keeps
      // this effect's memory (efPitchSlideUpSpeed/efPitchSlideDownSpeed)
      // separate from E1x/E2x's.
      let extraParam = effect.paramY;
      if (effect.paramX === 1) {
        if (state.profile.fineSlideHasMemory) {
          if (extraParam === 0) extraParam = state.lastExtraFinePortaUp;
          state.lastExtraFinePortaUp = extraParam;
        }
        applyFinePortamento(state, extraParam, 1);
        pushPitch(state.currentFrequency);
      } else if (effect.paramX === 2) {
        if (state.profile.fineSlideHasMemory) {
          if (extraParam === 0) extraParam = state.lastExtraFinePortaDown;
          state.lastExtraFinePortaDown = extraParam;
        }
        applyFinePortamento(state, -extraParam, 1);
        pushPitch(state.currentFrequency);
      }
      break;
    }

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
        // Instant: a cut that ramps is a fade, and at speed 3 that is the
        // whole note. See the 'step' note on ScheduledVolumeHandler.
        pushVolume(0, 'step');
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
      state.retriggerVolChange = volChange;

      if (isExtended) {
        // E9x does not count tick 0: ProTracker's retrigNote and FT2's are
        // only reached on ticks > 0 (a note row returns before them), so a
        // param of x retriggers at offsets x, 2x, ... of the row.
        state.retriggerTick = 0;
        break;
      }

      // Rxy's counter, though, counts tick 0 as its first increment. FT2's
      // tick-0 path reaches doMultiNoteRetrig like any other tick: `cnt =
      // ch->noteRetrigCounter + 1; if (cnt < ch->noteRetrigSpeed) {
      // ch->noteRetrigCounter = cnt; return; }` -- the counter is reset to 0
      // only by triggerInstrument (a note trigger), and the retrigger fires
      // the moment cnt reaches the interval. Counting from 0 at tick 0, as
      // this used to, put every Rxy retrigger one tick late and dropped the
      // row's last one: at speed 6, an R2 fires on ticks 1/3/5 in FT2 and on
      // 2/4 -- one fewer -- here, and an R3 at speed 3 fired nowhere at all.
      //
      // The one exception is FT2's volume-column quirk above: a row whose
      // volume column sets a volume does not count tick 0.
      state.retriggerTick = volumeColumnVolume ? 0 : 1;
      if (state.retriggerInterval > 0 && state.retriggerTick >= state.retriggerInterval) {
        // An interval the tick-0 count already satisfies (R11) re-fires the
        // note here, exactly as FT2's tick-0 call does.
        state.retriggerTick = 0;
        commands.push({
          kind: 'retrigger',
          midi: state.currentMidi,
          velocity: velocityFromVolume(state.currentVolume),
          frequency: state.currentFrequency,
        });
      }
      break;
    }

    case 'keyOff':
      // Kxx: Key off after xx ticks
      if (effect.paramX * 16 + effect.paramY === 0) {
        commands.push({ kind: 'noteOff' });
        state.hasActiveVoice = false;
      }
      break;

    case 'fineVibrato':
      // Uxy: Fine vibrato (smaller depth)
      if (effect.paramX) state.vibratoSpeed = effect.paramX;
      if (effect.paramY) state.vibratoDepth = effect.paramY / 4; // Quarter depth
      break;

    case 'panSlide': {
      // Pxy: pan slide, in profile.panSlideUnit steps per tick -- FT2 adds
      // the raw parameter to its 0..255 pan byte each tick (panningSlide),
      // so a unit is 2/255 of full swing, not the volume-slide 1/64 this
      // used to borrow. Up-nibble precedence and parameter memory are FT2's
      // (a bare P00 repeats the channel's last pan slide).
      if (effect.paramX) state.panSlideSpeed = effect.paramX * state.profile.panSlideUnit;
      else if (effect.paramY) state.panSlideSpeed = -effect.paramY * state.profile.panSlideUnit;
      break;
    }

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

  // Ensure we emit at least one pitch command to keep schedulers in sync.
  //
  // A running vibrato has to carry its current offset across the row boundary.
  // Emitting the bare base frequency snaps the pitch back to centre on tick 0
  // of every row, so a vibrato spanning many rows -- written as one `4xy`
  // followed by a run of `400` -- comes out as a sawtooth that resets once a
  // row instead of a continuous wave. The position itself only advances on
  // ticks after the first, so this re-states the value tick 0 already holds
  // rather than moving it.
  // An empty cell counts as well as a `400`. FT2's effect handler returns
  // early on a row carrying no effect at all, leaving the channel period
  // untouched, so a vibrato simply holds its offset across those rows.
  //
  // jt_911.xm is written that way: `41F` on row 0 and then `400` only every
  // fourth row, with the rows between empty. Springing back to the note on
  // each of those turns one slow wave into a wobble that jerks to centre three
  // rows out of four -- and because the position keeps creeping, the jerk
  // grows to most of a tone. A cell carrying some *other* effect still
  // re-states the note, which is the conservative reading.
  const continuesVibrato =
    newNote === undefined &&
    (!effect || effect.type === 'vibrato' || effect.type === 'vibratoVol') &&
    state.vibratoApplied &&
    state.vibratoDepth > 0;

  if (!commands.some((cmd) => cmd.kind === 'pitch')) {
    pushPitch(
      continuesVibrato
        ? vibratoFrequency(state, state.vibratoHeldWave)
        : state.currentFrequency,
    );
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
  ticksPerRow: number,
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

  const pushVolume = (
    volume: number,
    ramp?: 'linear' | 'exponential' | 'step',
  ) => {
    const cmd: ProcessorCommand =
      voiceIndex !== undefined
        ? { kind: 'volume', volume, voiceIndex, ...(ramp ? { ramp } : {}) }
        : { kind: 'volume', volume, ...(ramp ? { ramp } : {}) };
    commands.push(cmd);
  };

  const pushPan = (pan: number) => {
    commands.push({ kind: 'pan', pan });
  };

  // Check for note cut. ECx zeroes the channel volume rather than releasing
  // the note -- see the 'noteCut' case in processEffectTick0.
  if (state.noteCutTick === tick) {
    state.currentVolume = 0;
    pushVolume(0, 'step');
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
      velocity: velocityFromVolume(delayed.velocity / 255),
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
    state.hasActiveVoice = true;
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
      pushPitch(advanceVibrato(state));
      break;

    case 'vibratoVol':
      // Vibrato + volume slide
      pushPitch(advanceVibrato(state));
      {
        const slid = applyVolumeSlideIfNeeded(state);
        if (slid !== undefined) {
          pushVolume(slid);
        }
      }
      break;

    case 'tremolo':
      // Apply tremolo (volume oscillation).
      //
      // As with vibrato, the position advances *after* the sample is used:
      // both `tremolo` routines end with `ch->tremoloPos += ch->tremoloSpeed`.
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
      state.tremoloPos += state.tremoloSpeed;
      break;

    case 'arpeggio': {
      // Which of base / x / y this tick plays is format-specific: ProTracker
      // reads `song->tick % 3` off a tick that counts up, FT2 indexes
      // `arpeggioTab[song.tick & 31]` off one that counts *down* from the
      // speed, which swaps x and y at the common speeds. See
      // FormatProfile.arpeggioStep.
      const step = state.profile.arpeggioStep(tick, ticksPerRow);
      const offset =
        step === 1 ? state.arpeggioX : step === 2 ? state.arpeggioY : 0;

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
              // FT2: `vol = (vol >> 1) + (vol >> 3) + (vol >> 4)`, i.e.
              // 11/16 of the volume -- not the 2/3 this used to apply. The
              // shifts are FT2's way of writing "about two thirds"; taking
              // the description rather than the arithmetic left every x=6
              // retrigger step 3% quiet, compounding once per retrigger.
              state.currentVolume *= 11 / 16;
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
          velocity: velocityFromVolume(state.currentVolume),
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
      const raw = (effect.paramX << 4) | effect.paramY || state.lastTremor;
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
        state.hasActiveVoice = false;
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
  const pushVolume = (
    volume: number,
    ramp?: 'linear' | 'exponential' | 'step',
  ) =>
    push(
      voiceIndex !== undefined
        ? { kind: 'volume', volume, voiceIndex, ...(ramp ? { ramp } : {}) }
        : { kind: 'volume', volume, ...(ramp ? { ramp } : {}) },
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
      state.currentVolume = clampVolume(
        state.currentVolume - command.value * unit,
      );
      pushVolume(state.currentVolume, 'step');
      break;

    case 'fineVolUp':
      state.currentVolume = clampVolume(
        state.currentVolume + command.value * unit,
      );
      pushVolume(state.currentVolume, 'step');
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
      state.currentPan = (command.value << 4) / 128 - 1;
      pushPan(state.currentPan);
      break;

    case 'panSlideLeft':
      state.volumeColumnPanSlide = -command.value * state.profile.panSlideUnit;
      break;

    case 'panSlideRight':
      state.volumeColumnPanSlide = command.value * state.profile.panSlideUnit;
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
      const frequency = advanceVibrato(state);
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
  state.vibratoApplied = false;
  state.vibratoHeldWave = 0;
  if (state.tremoloRetrigger) state.tremoloPos = 0;
  state.retriggerTick = 0;
  state.noteCutTick = -1;
  state.noteDelayTick = -1;
  state.delayedNote = undefined;
  state.tonePortaActive = false;
  state.hasActiveVoice = false;
}
