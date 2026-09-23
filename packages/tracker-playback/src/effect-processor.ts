/**
 * FastTracker 2-style effect processor for the playback engine.
 * Handles per-tick effect processing for portamento, vibrato, arpeggio, etc.
 */

import type { EffectCommand, VolumeColumnCommand } from './types';
import type { ProcessorCommand, TrackEffectState } from './effect-state';
import {
  TREMOLO_DEPTH_DIVISOR,
  VIBRATO_TABLE_PEAK,
  advanceVibrato,
  getWaveformValue,
  vibratoFrequency,
} from './waveforms';

export type { ProcessorCommand, TrackEffectState } from './effect-state';
export {
  createTrackEffectState,
  resetEffectStateForNote,
} from './effect-state';

/**
 * Sample frames one unit of a 9xx parameter skips.
 *
 * ProTracker's unit is 256 bytes of 8-bit mono PCM, i.e. 256 frames;
 * FastTracker 2 keeps the same 256-frame unit for 8- and 16-bit samples
 * alike. So this is a shared constant rather than a per-format profile field.
 */
const SAMPLE_OFFSET_FRAMES_PER_UNIT = 256;

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
  state.volumeSlide = { delta: 0, mode: 'none', source: null, firstTick: false };
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
 *
 * Scream Tracker 3 reads the very same nibbles differently enough that it
 * needs its own branch rather than another boolean: a 0xF nibble turns the
 * slide *fine* (one step on tick 0), the down nibble wins over the up one,
 * and `D0F`/`DF0` slide on every tick including the first. All of it is
 * quoted in `FormatProfile.volumeSlideNibbles`, whose value selects between
 * the two readings here.
 */
interface ResolvedVolumeSlide {
  delta: number;
  mode: 'normal' | 'fine';
  firstTick: boolean;
}

function resolveVolumeSlide(
  state: TrackEffectState,
  paramX: number,
  paramY: number,
): ResolvedVolumeSlide {
  let raw = ((paramX & 0x0f) << 4) | (paramY & 0x0f);
  if (state.profile.volumeSlideHasMemory) {
    if (raw === 0) raw = state.lastVolSlide;
    state.lastVolSlide = raw;
  }

  const scale = state.profile.volumeSlideUnit;
  const up = (raw >> 4) & 0x0f;
  const down = raw & 0x0f;

  if (state.profile.volumeSlideNibbles === 's3m') {
    // DxF: fine slide up by x, once, on tick 0. DFy: fine slide down by y.
    // Neither claims `D0F`/`DF0`, whose other nibble is zero -- OpenMPT
    // falls those through to the ordinary slide *and* steps them on the
    // first tick, so they move 15 units on every tick of the row.
    if (down === 0x0f && up !== 0) {
      return { delta: up * scale, mode: 'fine', firstTick: false };
    }
    if (up === 0x0f && down !== 0) {
      return { delta: -down * scale, mode: 'fine', firstTick: false };
    }
    const firstTick =
      state.profile.fastVolumeSlides || raw === 0x0f || raw === 0xf0;
    // `if (param & 0x0F) newVolume -= ...; else newVolume += ...` -- down
    // first, so a parameter with both nibbles set slides down.
    if (down) return { delta: -down * scale, mode: 'normal', firstTick };
    if (up) return { delta: up * scale, mode: 'normal', firstTick };
    return { delta: 0, mode: 'normal', firstTick: false };
  }

  // Every existing 'modxm'-nibble profile (ProTracker, XM, native) sets
  // fastVolumeSlides: false explicitly (M1), so this is a no-op for them --
  // AHX/HVL is the first 'modxm'-nibble format for which it's true (volume
  // slides apply on tick 0 there too, see AHX_PROFILE's doc comment).
  const firstTick = state.profile.fastVolumeSlides === true;
  if (up) return { delta: up * scale, mode: 'normal', firstTick };
  if (down) return { delta: -down * scale, mode: 'normal', firstTick };
  return { delta: 0, mode: 'normal', firstTick: false };
}

function primeVolumeSlide(
  state: TrackEffectState,
  effect: EffectCommand | undefined,
): void {
  if (!effect) return;

  const setSlide = (
    resolved: ResolvedVolumeSlide,
    source: 'volSlide' | 'tonePortaVol' | 'vibratoVol',
  ) => {
    if (resolved.delta === 0) {
      resetVolumeSlide(state);
      return;
    }
    state.volumeSlide = {
      delta: resolved.delta,
      mode: resolved.mode,
      source,
      firstTick: resolved.firstTick,
    };
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
        setSlide(
          {
            delta: param * state.profile.volumeSlideUnit,
            mode: 'fine',
            firstTick: false,
          },
          'volSlide',
        );
        return;
      }
      if (effect.extSubtype === 'fineVolDown') {
        let param = effect.paramY;
        if (state.profile.fineSlideHasMemory) {
          if (param === 0) param = state.lastFineVolDown;
          state.lastFineVolDown = param;
        }
        setSlide(
          {
            delta: -param * state.profile.volumeSlideUnit,
            mode: 'fine',
            firstTick: false,
          },
          'volSlide',
        );
        return;
      }

      setSlide(
        resolveVolumeSlide(state, effect.paramX, effect.paramY),
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
        resolveVolumeSlide(state, effect.paramX, effect.paramY),
        'tonePortaVol',
      );
      return;

    case 'vibratoVol':
      setSlide(
        resolveVolumeSlide(state, effect.paramX, effect.paramY),
        'vibratoVol',
      );
      return;

    default:
      return;
  }
}

/**
 * Tick 0 of a row carrying a primed `normal` volume slide.
 *
 * Ordinarily the slide's first *step* is tick 1's, and tick 0 only re-states
 * the level the channel already sits at so the scheduler has a starting point
 * to ramp from. Where the slide steps on the first tick too --
 * `volumeSlide.firstTick`, which is S3M's fast-volume-slide files and its
 * `D0F`/`DF0` parameters -- the step happens here and the stated level is the
 * one it lands on.
 *
 * `volumeStatedThisRow` is set when the row also (re)stated the channel volume
 * outright -- a sample number reloading its default, a Cxx, an XM volume-column
 * set-volume. ProTracker writes that value straight to Paula's volume register
 * on tick 0, so it is a *step*, not something to glide into: without the flag
 * an unqualified command ramps linearly from the previous automation event,
 * turning a bare "sample number + Axy" pump (reload to full, then slide down)
 * into a slow swell up from wherever the last slide left the channel. See
 * butterfly_syndrome.mod order 9 channel 4 rows 54-57 (D127).
 */
function emitTick0VolumeSlide(
  state: TrackEffectState,
  commands: ProcessorCommand[],
  voiceIndex: number | undefined,
  volumeStatedThisRow: boolean,
): void {
  if (state.volumeSlide.mode !== 'normal' || state.volumeSlide.delta === 0) {
    return;
  }
  if (state.volumeSlide.firstTick) {
    state.currentVolume = clampVolume(
      state.currentVolume + state.volumeSlide.delta,
    );
  }
  pushVolume(
    commands,
    voiceIndex,
    state.currentVolume,
    volumeStatedThisRow ? 'step' : undefined,
  );
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

/**
 * A batch of commands for one processor call.
 *
 * The `commands` array is a reusable buffer owned by the batch-producing
 * `TrackEffectState` (one buffer for the effect column, one for the volume
 * column), reset at the top of every call. Consumers must finish reading a
 * batch -- dispatch it -- before the next processor call on the same state:
 * the engine does exactly that (`dispatchCommands` only reads the context and
 * never retains the array). Anything that needs the commands to outlive the
 * call must copy them.
 */
export interface TickCommandBatch {
  commands: ProcessorCommand[];
}

/**
 * Module-scope command pushers, shared by every processor entry point.
 *
 * They replace the per-call `pushPitch`/`pushVolume`/`pushPan`/`pushNoteOn`
 * closures that each processor call used to allocate (a busy 32-track row
 * allocates a closure set per processor call, several thousand closures per
 * second on a busy module). Fields are assigned conditionally after the
 * literal is built so no conditional-spread temporaries are created.
 */
function pushPitch(
  commands: ProcessorCommand[],
  voiceIndex: number | undefined,
  frequency: number,
): void {
  const cmd: Extract<ProcessorCommand, { kind: 'pitch' }> = {
    kind: 'pitch',
    frequency,
  };
  if (voiceIndex !== undefined) cmd.voiceIndex = voiceIndex;
  commands.push(cmd);
}

function pushVolume(
  commands: ProcessorCommand[],
  voiceIndex: number | undefined,
  volume: number,
  ramp?: 'linear' | 'exponential' | 'step',
): void {
  const cmd: Extract<ProcessorCommand, { kind: 'volume' }> = {
    kind: 'volume',
    volume,
  };
  if (voiceIndex !== undefined) cmd.voiceIndex = voiceIndex;
  if (ramp !== undefined) cmd.ramp = ramp;
  commands.push(cmd);
}

function pushPan(
  commands: ProcessorCommand[],
  voiceIndex: number | undefined,
  pan: number,
): void {
  const cmd: Extract<ProcessorCommand, { kind: 'pan' }> = { kind: 'pan', pan };
  if (voiceIndex !== undefined) cmd.voiceIndex = voiceIndex;
  commands.push(cmd);
}

function pushNoteOn(
  commands: ProcessorCommand[],
  midi: number,
  velocity: number,
  frequency: number,
  pan: number | undefined,
  sampleOffsetFrames: number | undefined,
): void {
  const cmd: Extract<ProcessorCommand, { kind: 'noteOn' }> = {
    kind: 'noteOn',
    midi,
    velocity,
    frequency,
  };
  if (pan !== undefined) cmd.pan = pan;
  if (sampleOffsetFrames !== undefined)
    cmd.sampleOffsetFrames = sampleOffsetFrames;
  commands.push(cmd);
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
  /**
   * True when this row's XM volume column carries a tone portamento (Mx).
   * FT2 reads the volume column while the note is being set up, and its Mx is
   * a tone portamento in every respect the note cares about: the row's note
   * becomes the slide's target instead of retriggering the sample. The flag
   * has to arrive separately because the volume column is processed after
   * this function (processVolumeColumnTick0), by which point the note has
   * already been dealt with.
   */
  volumeColumnTonePorta?: boolean,
): TickCommandBatch {
  const commands = state.effectCommandBuffer;
  commands.length = 0;
  const voiceIndex = state.voiceIndex >= 0 ? state.voiceIndex : undefined;
  const hasNoteDelay =
    effect?.type === 'noteDelay' ||
    (effect?.type === 'extEffect' && effect.extSubtype === 'noteDelay');

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
    pushNoteOn(
      commands,
      carry.midi,
      velocityFromVolume(state.currentVolume),
      state.currentFrequency,
      pan,
      pendingSampleOffsetFrames,
    );
    state.hasActiveVoice = true;
    pushPitch(commands, voiceIndex, state.currentFrequency);
    pushVolume(commands, voiceIndex, state.currentVolume);
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
    // For tone portamento, new note sets target, not current. The volume
    // column's Mx counts: FT2 treats it as a tone portamento here even when
    // the effect column is empty.
    if (
      effect?.type === 'tonePorta' ||
      effect?.type === 'tonePortaVol' ||
      volumeColumnTonePorta === true
    ) {
      state.targetMidi = newNote;
      const targetFreq = noteFrequency ?? midiToFrequency(newNote);
      state.targetFrequency = targetFreq;
      // Only use ProTracker-style periods when we have period context.
      // A period-domain format (MOD/S3M/XM-Amiga) always has it: its slides
      // are defined in periods, so the target is derived from the frequency
      // even when the row carried no explicit one. Deciding this on
      // `noteFrequency` alone let a single note whose frequency failed to
      // resolve drop the channel into the frequency-ratio fallback -- which
      // slides several times slower -- for the rest of the song.
      if (
        state.profile.pitch.kind === 'amiga' ||
        noteFrequency !== undefined ||
        state.currentPeriod !== undefined
      ) {
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
        pushNoteOn(
          commands,
          newNote,
          velocityFromVolume(state.currentVolume),
          state.currentFrequency,
          pan,
          pendingSampleOffsetFrames,
        );
        state.hasActiveVoice = true;
        triggeredNote = true;
      }
    } else {
      if (noteFrequency !== undefined) {
        const rawPeriod =
          state.profile.pitch.rawPeriodFromFrequency(noteFrequency);
        updatePitchFromPeriod(state, rawPeriod);
      } else if (state.profile.pitch.kind === 'amiga') {
        // Same reasoning as the tone-portamento branch above: on a
        // period-domain format the channel must stay in the period domain,
        // so derive the period from the note's frequency rather than
        // abandoning it. Clearing `currentPeriod` here was sticky -- nothing
        // downstream restores it -- so one unresolved note disabled
        // period-accurate portamento, vibrato and arpeggio on that channel
        // until the next note that did resolve.
        updatePitchFromPeriod(
          state,
          state.profile.pitch.rawPeriodFromFrequency(midiToFrequency(newNote)),
        );
      } else {
        state.currentPeriod = undefined;
        updatePitchFromFrequency(state, midiToFrequency(newNote));
      }
      state.targetMidi = newNote;
      state.targetFrequency = state.currentFrequency;
      state.targetPeriod = state.currentPeriod;

      // Trigger note immediately unless delayed or a tone portamento continuation
      if (!hasNoteDelay) {
        pushNoteOn(
          commands,
          newNote,
          velocityFromVolume(state.currentVolume),
          state.currentFrequency,
          pan,
          pendingSampleOffsetFrames,
        );
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
    pushVolume(commands, voiceIndex, state.currentVolume, 'step');
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
      //
      // AHX/HVL has no such memory (`FormatProfile.portamentoHasMemory`,
      // false only there): `vc_PeriodSlideSpeed = FXParam` reassigns
      // unconditionally, so a zero parameter is a genuine "stop the slide",
      // not "repeat the last one".
      const hasMemory = state.profile.portamentoHasMemory !== false;
      const resolvedParam =
        rawParam !== 0
          ? rawParam
          : hasMemory
            ? up
              ? state.lastPortaUp
              : state.lastPortaDown
            : 0;
      // st3play's docmd1 stores the channel-wide memory for EVERY non-zero
      // raw parameter (`if (ch->info > 0) ch->alastnfo = ch->info;`) --
      // including 0xE0/0xF0 rows that move nothing -- so the store happens
      // here, before the fine/speed split, not inside it. With a zero raw
      // parameter nothing is stored: GET_LAST_NFO resolved it above.
      if (rawParam !== 0) {
        if (up) state.lastPortaUp = rawParam;
        else state.lastPortaDown = rawParam;
      }
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
            pushPitch(commands, voiceIndex, state.currentFrequency);
          }
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
      if (effect.extSubtype === 'vibratoDepth') {
        // AHX/HVL extended 0xe4: sets depth only, from the whole nibble
        // (including zero -- `vc_VibratoDepth = FXParam&0xf` is an
        // unconditional assignment, not "leave depth alone on a zero
        // param" the way the plain form below treats paramY). AHX has no
        // row-level speed nibble at all; speed comes from the instrument.
        state.vibratoDepth = effect.paramY & 0x0f;
        break;
      }
      if (effect.paramX) state.vibratoSpeed = effect.paramX;
      if (effect.paramY) state.vibratoDepth = effect.paramY;
      state.lastVibrato = (state.vibratoSpeed << 4) | state.vibratoDepth;
      break;

    case 'setFilterPos': {
      // AHX/HVL fx 0x4 (`hvl_replay.c:736-745`). One reconstructed byte,
      // two disjoint ranges; 0 and 0x40 are no-ops.
      const raw = effect.paramX * 16 + effect.paramY;
      if (raw !== 0 && raw !== 0x40) {
        if (raw < 0x40) {
          state.ahxFilterIgnore = raw;
        } else if (raw <= 0x7f) {
          state.ahxFilterPos = raw - 0x40;
        }
      }
      break;
    }

    case 'setSquarePos':
      // AHX/HVL fx 0x9 (`hvl_replay.c:691-695`): byte reconstructed the same
      // way as setFilterPos, but stored RAW -- the reference's `>> (5 -
      // vc_WaveLength)` shift needs the active instrument's waveform length,
      // which this per-track decode state does not carry. See
      // ahxSquarePosRaw's doc for why and who applies the shift.
      state.ahxSquarePosRaw = effect.paramX * 16 + effect.paramY;
      break;

    case 'setTrackVolume': {
      // AHX/HVL fx 0xc (`hvl_replay.c:746-767`): three tiers on one byte.
      let raw = effect.paramX * 16 + effect.paramY;
      if (raw <= 0x40) {
        // Tier 1: this channel's note volume, identical range/scale to
        // 'setVolume'.
        state.currentVolume = Math.min(1, raw / 64);
        pushVolume(commands, voiceIndex, state.currentVolume, 'step');
        break;
      }
      raw -= 0x50;
      if (raw < 0) break;
      if (raw <= 0x40) {
        // Tier 2: every channel's track-master volume at once -- a
        // song-level broadcast this per-channel state has no access to.
        // Decoded, deliberately not applied; see p2-report.md.
        break;
      }
      raw -= 0xa0 - 0x50;
      if (raw < 0) break;
      if (raw <= 0x40) {
        // Tier 3: this channel's own track-master volume, distinct from
        // the note volume above. No consumer yet (P4).
        state.ahxTrackVolume = raw / 64;
      }
      break;
    }

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
      emitTick0VolumeSlide(
        state,
        commands,
        voiceIndex,
        newVelocity !== undefined,
      );
      // No slide on tick 0 -- see the 'tonePorta' case above for why.
      break;

    case 'vibratoVol':
      // Vibrato continues, volume slide applies
      primeVolumeSlide(state, effect);
      emitTick0VolumeSlide(
        state,
        commands,
        voiceIndex,
        newVelocity !== undefined,
      );
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
      pushPitch(commands, voiceIndex, state.currentFrequency);
      break;

    case 'volSlide': {
      // Distinguish between normal Axy volume slide and fine EAx/EBx slides.
      primeVolumeSlide(state, effect);
      // States the level per-tick slides ramp from -- and takes the step
      // itself where the format slides on tick 0 as well.
      emitTick0VolumeSlide(
        state,
        commands,
        voiceIndex,
        newVelocity !== undefined,
      );
      if (state.volumeSlide.mode === 'fine' && state.volumeSlide.delta !== 0) {
        state.currentVolume = clampVolume(
          state.currentVolume + state.volumeSlide.delta,
        );
        // A *fine* slide is a single instantaneous step, not a slide.
        pushVolume(commands, voiceIndex, state.currentVolume, 'step');
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
        pushPitch(commands, voiceIndex, state.currentFrequency);
      }
      break;

    case 'setVolume':
      // Cxx: Set volume (00-40 in FT2, we scale to 0-1)
      state.currentVolume = Math.min(
        1,
        (effect.paramX * 16 + effect.paramY) / 64,
      );
      // Cxx sets the volume, it does not slide to it.
      pushVolume(commands, voiceIndex, state.currentVolume, 'step');
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
      } else if (state.profile.panByteIsSigned) {
        // AHX/HVL: the raw byte is a signed -128..127 value, 0 = center
        // (`hvl_replay.c:637-638`'s `if(FXParam>127) FXParam-=256`) --
        // see FormatProfile.panByteIsSigned's doc comment for the full
        // derivation against MOD's unsigned-byte formula below.
        const raw = effect.paramX * 16 + effect.paramY;
        const signed = raw >= 128 ? raw - 256 : raw;
        state.currentPan = signed / 128;
      } else {
        // 8xx: Set panning (00=left, 80=center, FF=right)
        state.currentPan = (effect.paramX * 16 + effect.paramY - 128) / 128;
      }
      pushPan(commands, voiceIndex, state.currentPan);
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
      pushPitch(commands, voiceIndex, state.currentFrequency);
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
      pushPitch(commands, voiceIndex, state.currentFrequency);
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
        pushPitch(commands, voiceIndex, state.currentFrequency);
      } else if (effect.paramX === 2) {
        if (state.profile.fineSlideHasMemory) {
          if (extraParam === 0) extraParam = state.lastExtraFinePortaDown;
          state.lastExtraFinePortaDown = extraParam;
        }
        applyFinePortamento(state, -extraParam, 1);
        pushPitch(commands, voiceIndex, state.currentFrequency);
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
        pushVolume(commands, voiceIndex, 0, 'step');
        state.noteCutTick = -1;
      }
      break;

    case 'noteDelay': {
      // EDx: Note delay by x ticks
      state.noteDelayTick = effect.paramY;
      if (newNote !== undefined) {
        state.delayedNote = {
          midi: newNote,
          // The channel's volume, not the row's -- a delayed note is an
          // ordinary note that happens later, and an ordinary note with no
          // volume of its own starts at whatever the channel has reached.
          //
          // Requiring a row volume here dropped the note outright, because a
          // note carrying no sample number deliberately has none: ProTracker
          // leaves the channel volume alone on those rows, so mod-import
          // stamps nothing (see mod-channel-volume-carry). The row then
          // triggered nothing at all, while tick 0 had already moved the
          // channel to the new note's pitch -- so instead of retriggering,
          // the note still sounding bent to the delayed note's pitch and
          // stayed there.
          //
          // GSLINGER.MOD order 37 channel 4 is the case that exposed it. Its
          // flute (sample 27) is a whole melodic phrase, and the part
          // alternates B-2 and C#3 with every C# written as a bare "C#3 ED3":
          // no sample number, hence no volume. None of them retriggered, so
          // the phrase never restarted on the C# -- it bent mid-phrase and
          // played on, which is heard as the melody not landing on its notes.
          velocity: Math.round(clampVolume(state.currentVolume) * 255),
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
      if (
        state.retriggerInterval > 0 &&
        state.retriggerTick >= state.retriggerInterval
      ) {
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
      if (effect.paramX)
        state.panSlideSpeed = effect.paramX * state.profile.panSlideUnit;
      else if (effect.paramY)
        state.panSlideSpeed = -effect.paramY * state.profile.panSlideUnit;
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

  // Restore the channel volume once a tremolo stops.
  //
  // The tremolo case above deliberately never writes `currentVolume`, so on
  // the row after the last `7xy` nothing re-asserts the channel's volume:
  // an empty (or non-volume) effect cell emits no volume command, and the
  // scheduled voice gain stays frozen at whatever the tremolo waveform held
  // on the previous row's last tick. FT2 and ProTracker never do this --
  // both recompute `outVol` from `realVol` every tick, so tremolo springs
  // back to the channel volume the moment the command is absent. (Vibrato's
  // held offset is the opposite case: there the reference does hold it,
  // which is why `continuesVibrato` above keeps the pitch bent.) A row that
  // already states its own volume -- a note (the noteOn carries the
  // velocity), a Cxx, a volume-column value -- is left alone.
  if (
    state.tremoloApplied &&
    state.tremoloDepth > 0 &&
    effect?.type !== 'tremolo' &&
    !commands.some((cmd) => cmd.kind === 'volume' || cmd.kind === 'noteOn')
  ) {
    pushVolume(commands, voiceIndex, state.currentVolume);
    // The volume is restored: the next effect-less row has nothing to
    // re-emit. (FT2/PT keep recomputing outVol from realVol, but the value
    // no longer changes, so the scheduled gain needs no further command.)
    state.tremoloApplied = false;
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
  //
  // ST3 is the exception: st3play `docmd1` restores `ch->aspd` to `ch->aorgspd`
  // on tick 0 of any cell that carries no vibrato command (the `ch->cmd == 0`
  // and `ch->cmd == 'D'` arms), so a stopped vibrato snaps back to the note on
  // the next such row rather than holding. `pitchResetsAfterEffectlessRow`
  // gates that to the S3M profiles; the fallback below then emits
  // `state.currentFrequency` (the un-modulated base) for them. Tracks the row
  // omits altogether are handled by the engine's trailing pass.
  const isVibratoRow =
    effect?.type === 'vibrato' || effect?.type === 'vibratoVol';
  const vibratoSnapsBack =
    state.profile.pitchResetsAfterEffectlessRow === true && !isVibratoRow;
  const continuesVibrato =
    newNote === undefined &&
    (isVibratoRow || !effect) &&
    !vibratoSnapsBack &&
    state.vibratoApplied &&
    state.vibratoDepth > 0;
  if (vibratoSnapsBack && newNote === undefined && state.vibratoApplied) {
    state.vibratoApplied = false;
    state.vibratoHeldWave = 0;
  }

  // A delayed note does not move the channel's pitch on tick 0. ProTracker
  // stores the new period but only writes it to the hardware when the delay
  // fires (mt_NoteDelay), so whatever is still sounding keeps its own pitch
  // until then -- and the delayed trigger re-states the pitch itself when it
  // arrives. Emitting it here instead bent the previous note to the new one's
  // pitch for the length of the delay, a few ticks of glide onto the front of
  // every EDx row.
  const holdsPitchForDelayedNote = hasNoteDelay && newNote !== undefined;

  if (
    !holdsPitchForDelayedNote &&
    !commands.some((cmd) => cmd.kind === 'pitch')
  ) {
    pushPitch(
      commands,
      voiceIndex,
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
  const commands = state.effectCommandBuffer;
  commands.length = 0;
  const voiceIndex = state.voiceIndex >= 0 ? state.voiceIndex : undefined;

  // Check for note cut. ECx zeroes the channel volume rather than releasing
  // the note -- see the 'noteCut' case in processEffectTick0.
  if (state.noteCutTick === tick) {
    state.currentVolume = 0;
    pushVolume(commands, voiceIndex, 0, 'step');
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
    pushPitch(commands, voiceIndex, state.currentFrequency);
    pushVolume(commands, voiceIndex, state.currentVolume);
  }

  if (!effect) {
    // A row that carries no tone portamento does not slide, even when the
    // previous row's slide never reached its target: ProTracker and FT2
    // re-read the effect column every row, and a blank cell is command 0,
    // which does nothing. So a 3xx run stops where its last 3xx row left it.
    // Continuing the slide through blank cells walks the pitch arbitrarily
    // far past where the module means it to stop -- in space_debris.mod the
    // C-2 slide at the end of order 1 kept falling through order 2's blank
    // cells and landed nowhere near the note. Only S3M still continues here;
    // see `tonePortaContinuesThroughEmptyRows`.
    if (
      state.profile.tonePortaContinuesThroughEmptyRows === true &&
      state.tonePortaActive &&
      state.tonePortaSpeed > 0
    ) {
      const beforeFreq = state.currentFrequency;
      const freq = applyTonePortaStep(state);
      if (Math.abs(freq - beforeFreq) > 1e-9) {
        pushPitch(commands, voiceIndex, freq);
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
      pushPitch(commands, voiceIndex, state.currentFrequency);
      break;

    case 'portaDown':
      // Slide pitch down
      applyPortamentoStep(state);
      pushPitch(commands, voiceIndex, state.currentFrequency);
      break;

    case 'tonePorta':
    case 'tonePortaVol': {
      const beforeFreq = state.currentFrequency;
      const freq = applyTonePortaStep(state);
      const moved = Math.abs(freq - beforeFreq) > 1e-9;
      if (moved) {
        pushPitch(commands, voiceIndex, freq);
      }
      if (state.targetFrequency === state.currentFrequency) {
        state.tonePortaActive = false;
      }

      // Handle volume slide for 5xy
      if (effect.type === 'tonePortaVol') {
        const slid = applyVolumeSlideIfNeeded(state);
        if (slid !== undefined) {
          pushVolume(commands, voiceIndex, slid);
        }
      }
      break;
    }

    case 'vibrato':
    case 'fineVibrato':
      pushPitch(commands, voiceIndex, advanceVibrato(state));
      break;

    case 'vibratoVol':
      // Vibrato + volume slide
      pushPitch(commands, voiceIndex, advanceVibrato(state));
      {
        const slid = applyVolumeSlideIfNeeded(state);
        if (slid !== undefined) {
          pushVolume(commands, voiceIndex, slid);
        }
      }
      break;

    case 'tremolo':
      // Apply tremolo (volume oscillation).
      //
      // As with vibrato, the position advances *after* the sample is used:
      // both `tremolo` routines end with `ch->tremoloPos += ch->tremoloSpeed`.
      state.tremoloApplied = true;
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
      pushVolume(
        commands,
        voiceIndex,
        Math.max(0, Math.min(1, state.currentVolume + tremoloAmount)),
      );
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
          commands,
          voiceIndex,
          period === 0 ? 0 : state.profile.pitch.frequencyFromPeriod(period),
        );
      } else {
        let arpeggioNote = state.currentMidi;
        arpeggioNote += offset;
        pushPitch(commands, voiceIndex, midiToFrequency(arpeggioNote));
      }
      break;
    }

    case 'volSlide':
      if (state.volumeSlide.mode === 'normal') {
        const slid = applyVolumeSlideIfNeeded(state);
        if (slid !== undefined) {
          pushVolume(commands, voiceIndex, slid);
        }
      }
      break;

    case 'panSlide':
      state.currentPan = Math.max(
        -1,
        Math.min(1, state.currentPan + state.panSlideSpeed),
      );
      pushPan(commands, voiceIndex, state.currentPan);
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
      pushVolume(commands, voiceIndex, inOnPhase ? state.currentVolume : 0);
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
    case 'tonePorta':
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
  const commands = state.volumeCommandBuffer;
  commands.length = 0;
  const voiceIndex = state.voiceIndex >= 0 ? state.voiceIndex : undefined;

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
      if (state.volumeColumnSlide !== 0)
        pushVolume(commands, voiceIndex, state.currentVolume);
      break;

    case 'volSlideUp':
      state.volumeColumnSlide = command.value * unit;
      if (state.volumeColumnSlide !== 0)
        pushVolume(commands, voiceIndex, state.currentVolume);
      break;

    case 'fineVolDown':
      state.currentVolume = clampVolume(
        state.currentVolume - command.value * unit,
      );
      pushVolume(commands, voiceIndex, state.currentVolume, 'step');
      break;

    case 'fineVolUp':
      state.currentVolume = clampVolume(
        state.currentVolume + command.value * unit,
      );
      pushVolume(commands, voiceIndex, state.currentVolume, 'step');
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
      pushPan(commands, voiceIndex, state.currentPan);
      break;

    case 'panSlideLeft':
      state.volumeColumnPanSlide = -command.value * state.profile.panSlideUnit;
      break;

    case 'panSlideRight':
      state.volumeColumnPanSlide = command.value * state.profile.panSlideUnit;
      break;

    case 'tonePorta':
      // Sets the speed only; the target is whatever note the row supplied,
      // which processEffectTick0 has already resolved (it is told about this
      // command through its `volumeColumnTonePorta` flag, so the note set a
      // target rather than retriggering). A zero parameter keeps the
      // remembered speed, as 300 does.
      if (command.value > 0) {
        state.tonePortaSpeed = command.value;
        state.lastTonePorta = command.value;
      } else if (state.lastTonePorta > 0) {
        state.tonePortaSpeed = state.lastTonePorta;
      }
      // And, as with 3xx, a row that carries no note keeps sliding towards
      // the target the last one set.
      if (state.lastTonePortaTargetFreq !== undefined) {
        state.targetFrequency = state.lastTonePortaTargetFreq;
      }
      if (state.lastTonePortaTargetPeriod !== undefined) {
        state.targetPeriod = state.lastTonePortaTargetPeriod;
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
  const commands = state.volumeCommandBuffer;
  commands.length = 0;
  if (!command) return { commands };

  const voiceIndex = state.voiceIndex >= 0 ? state.voiceIndex : undefined;

  switch (command.type) {
    case 'volSlideDown':
    case 'volSlideUp': {
      if (state.volumeColumnSlide === 0) break;
      state.currentVolume = clampVolume(
        state.currentVolume + state.volumeColumnSlide,
      );
      pushVolume(commands, voiceIndex, state.currentVolume);
      break;
    }

    case 'panSlideLeft':
    case 'panSlideRight': {
      if (state.volumeColumnPanSlide === 0) break;
      state.currentPan = Math.max(
        -1,
        Math.min(1, state.currentPan + state.volumeColumnPanSlide),
      );
      pushPan(commands, voiceIndex, state.currentPan);
      break;
    }

    case 'vibrato': {
      const frequency = advanceVibrato(state);
      pushPitch(commands, voiceIndex, frequency);
      break;
    }

    case 'tonePorta': {
      // Mx slides on ticks 1..n-1 exactly like the effect column's 3xx. This
      // has to live here: the effect column is usually empty on these rows,
      // and processEffectTickN deliberately does nothing when it is.
      if (!state.tonePortaActive || state.tonePortaSpeed <= 0) break;
      const before = state.currentFrequency;
      const frequency = applyTonePortaStep(state);
      if (state.targetFrequency === state.currentFrequency) {
        state.tonePortaActive = false;
      }
      if (Math.abs(frequency - before) > 1e-9) {
        pushPitch(commands, voiceIndex, frequency);
      }
      break;
    }

    default:
      break;
  }

  return { commands };
}
