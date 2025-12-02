/**
 * FastTracker 2-style effect processor for the playback engine.
 * Handles per-tick effect processing for portamento, vibrato, arpeggio, etc.
 */

import type { EffectCommand } from './types';

const AMIGA_CLOCK = 7159090.5;
const PAULA_TO_SYNTH_SCALE = 128; // 2^7, keeps us in synth-domain Hz
const MIN_PROTRACKER_PERIOD = 113; // ~B-3
const MAX_PROTRACKER_PERIOD = 856; // C-1

function clampProtrackerPeriod(period: number): number {
  if (!Number.isFinite(period)) return period;
  if (period < MIN_PROTRACKER_PERIOD) return MIN_PROTRACKER_PERIOD;
  if (period > MAX_PROTRACKER_PERIOD) return MAX_PROTRACKER_PERIOD;
  return period;
}

function synthFrequencyFromPeriod(period: number): number {
  return AMIGA_CLOCK / (2 * period * PAULA_TO_SYNTH_SCALE);
}

function protrackerArpPeriod(basePeriod: number, semitoneOffset: number): number {
  // Higher pitch -> smaller period.
  const shifted = basePeriod / Math.pow(2, semitoneOffset / 12);
  if (shifted < MIN_PROTRACKER_PERIOD) {
    // ProTracker wraps past the top of the table; the first overflow hits 0 (DC).
    return 0;
  }
  return clampProtrackerPeriod(shifted);
}

/**
 * Per-track effect state
 */
export interface TrackEffectState {
  // Current note state
  currentMidi: number;
  currentFrequency: number;
  targetMidi: number;
  targetFrequency: number;
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

  // Tremolo state
  tremoloSpeed: number;
  tremoloDepth: number;
  tremoloPos: number;
  tremoloWaveform: number;

  // Arpeggio state
  arpeggioX: number;
  arpeggioY: number;
  arpeggioTick: number;

  // Volume slide state
  volSlideSpeed: number; // positive = up, negative = down

  // Panning slide state
  panSlideSpeed: number;

  // Retrigger state
  retriggerInterval: number;
  retriggerTick: number;
  retriggerVolChange: number;
  // Tone portamento glissando (E3x)
  glissandoEnabled: boolean;

  // Note cut/delay
  noteCutTick: number;
  noteDelayTick: number;
  delayedNote: {
    midi: number;
    velocity: number;
  } | undefined;

  // Voice tracking
  voiceIndex: number;

  // Effect memory (FT2 remembers last values)
  lastPortaUp: number;
  lastPortaDown: number;
  lastTonePorta: number;
  lastVibrato: number;
  lastTremolo: number;
  lastVolSlide: number;
  lastArpeggio: number;
}

/**
 * Create default track effect state
 */
export function createTrackEffectState(): TrackEffectState {
  return {
    currentMidi: 60,
    currentFrequency: 261.63,
    targetMidi: 60,
    targetFrequency: 261.63,
    currentVolume: 1.0,
    currentPan: 0,

    portamentoSpeed: 0,
    tonePortaSpeed: 0,

    vibratoSpeed: 0,
    vibratoDepth: 0,
    vibratoPos: 0,
    vibratoWaveform: 0,

    tremoloSpeed: 0,
    tremoloDepth: 0,
    tremoloPos: 0,
    tremoloWaveform: 0,

    arpeggioX: 0,
    arpeggioY: 0,
    arpeggioTick: 0,

    volSlideSpeed: 0,
    panSlideSpeed: 0,

    retriggerInterval: 0,
    retriggerTick: 0,
    retriggerVolChange: 0,
    glissandoEnabled: false,

    noteCutTick: -1,
    noteDelayTick: -1,
    delayedNote: undefined,

    voiceIndex: -1,

    lastPortaUp: 0,
    lastPortaDown: 0,
    lastTonePorta: 0,
    lastVibrato: 0,
    lastTremolo: 0,
    lastVolSlide: 0,
    lastArpeggio: 0
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
  paramY: number
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
  if (state.currentFrequency < state.targetFrequency) {
    state.currentFrequency *= Math.pow(2, state.tonePortaSpeed / (12 * 16));
    if (state.currentFrequency >= state.targetFrequency) {
      state.currentFrequency = state.targetFrequency;
    }
  } else if (state.currentFrequency > state.targetFrequency) {
    state.currentFrequency /= Math.pow(2, state.tonePortaSpeed / (12 * 16));
    if (state.currentFrequency <= state.targetFrequency) {
      state.currentFrequency = state.targetFrequency;
    }
  }
  state.currentMidi = frequencyToMidi(state.currentFrequency);
  // When glissando control is enabled (E3x), snap to semitone grid.
  if (state.glissandoEnabled) {
    const snappedMidi = Math.round(state.currentMidi);
    state.currentMidi = snappedMidi;
    state.currentFrequency = midiToFrequency(snappedMidi);
  }
  if (state.currentPeriod !== undefined) {
    const derived = AMIGA_CLOCK / (2 * state.currentFrequency * PAULA_TO_SYNTH_SCALE);
    state.currentPeriod = clampProtrackerPeriod(derived);
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

/**
 * Effect processor result for a single tick
 */
export interface TickEffectResult {
  frequency?: number;
  volume?: number;
  pan?: number;
  triggerNote?: { midi: number; velocity: number };
  cutNote?: boolean;
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
): TickEffectResult {
  const result: TickEffectResult = {};

  // Update current note if we have a new one
  if (newNote !== undefined) {
    // For tone portamento, new note sets target, not current
    if (effect?.type === 'tonePorta' || effect?.type === 'tonePortaVol') {
      state.targetMidi = newNote;
      state.targetFrequency = midiToFrequency(newNote);
    } else {
      state.currentMidi = newNote;
      state.currentFrequency = noteFrequency ?? midiToFrequency(newNote);
      state.targetMidi = newNote;
      state.targetFrequency = state.currentFrequency;

      // For ProTracker MODs with exact frequencies, calculate period for authentic portamento
      if (noteFrequency !== undefined) {
        const rawPeriod = AMIGA_CLOCK / (2 * noteFrequency * PAULA_TO_SYNTH_SCALE);
        state.currentPeriod = clampProtrackerPeriod(rawPeriod);
      } else {
        // Native tracker songs don't use period-based portamento
        state.currentPeriod = undefined;
      }
    }
  }

  if (newVelocity !== undefined) {
    state.currentVolume = newVelocity / 127;
  }

  if (!effect) {
    result.frequency = state.currentFrequency;
    return result;
  }

  // Handle effect parameters (use memory if param is 0 where applicable)
  switch (effect.type) {
    case 'portaUp':
      state.portamentoSpeed = effect.paramX * 16 + effect.paramY || state.lastPortaUp;
      state.lastPortaUp = state.portamentoSpeed;
      break;

    case 'portaDown':
      state.portamentoSpeed = -(effect.paramX * 16 + effect.paramY || state.lastPortaDown);
      state.lastPortaDown = Math.abs(state.portamentoSpeed);
      break;

    case 'tonePorta':
      state.tonePortaSpeed = resolveTonePortaSpeed(state, effect.paramX, effect.paramY);
      // Apply an initial slide on tick 0 so we don't stop one step short.
      result.frequency = applyTonePortaStep(state);
      break;

    case 'vibrato':
      if (effect.paramX) state.vibratoSpeed = effect.paramX;
      if (effect.paramY) state.vibratoDepth = effect.paramY;
      state.lastVibrato = (state.vibratoSpeed << 4) | state.vibratoDepth;
      break;

    case 'tonePortaVol':
      // Tone porta continues, volume slide applies
      state.tonePortaSpeed = resolveTonePortaSpeed(state, effect.paramX, effect.paramY);
      if (effect.paramX) state.volSlideSpeed = effect.paramX;
      else if (effect.paramY) state.volSlideSpeed = -effect.paramY;
      // Apply an initial slide on tick 0 so we don't stop one step short.
      result.frequency = applyTonePortaStep(state);
      break;

    case 'vibratoVol':
      // Vibrato continues, volume slide applies
      if (effect.paramX) state.volSlideSpeed = effect.paramX;
      else if (effect.paramY) state.volSlideSpeed = -effect.paramY;
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
      result.frequency = state.currentFrequency;
      break;

    case 'volSlide': {
      // Distinguish between normal Axy volume slide and fine EAx/EBx slides.
      if (effect.extSubtype === 'fineVolUp') {
        // EAx: Fine volume slide up (tick 0 only, x = amount)
        const amount = effect.paramY / 64;
        state.currentVolume = Math.max(0, Math.min(1, state.currentVolume + amount));
        result.volume = state.currentVolume;
        // Do not alter volSlideSpeed / lastVolSlide so Axy memory stays intact.
      } else if (effect.extSubtype === 'fineVolDown') {
        // EBx: Fine volume slide down (tick 0 only, x = amount)
        const amount = effect.paramY / 64;
        state.currentVolume = Math.max(0, Math.min(1, state.currentVolume - amount));
        result.volume = state.currentVolume;
      } else {
        // Axy: Per-tick volume slide (x=up, y=down)
        if (effect.paramX) state.volSlideSpeed = effect.paramX / 64; // Fine adjustment
        else if (effect.paramY) state.volSlideSpeed = -effect.paramY / 64;
        state.lastVolSlide = (effect.paramX << 4) | effect.paramY;
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
        // E5x: Set finetune for current note (approximate, per-row only).
        const nibble = effect.paramY & 0x0f;
        const finetuneSteps = nibble < 8 ? nibble : nibble - 16; // -8..7
        const semitones = finetuneSteps / 8;
        const ratio = Math.pow(2, semitones / 12);
        state.currentFrequency *= ratio;
        state.targetFrequency *= ratio;
        state.currentMidi = frequencyToMidi(state.currentFrequency);
        if (state.currentPeriod !== undefined) {
          state.currentPeriod = clampProtrackerPeriod(state.currentPeriod / ratio);
        }
        result.frequency = state.currentFrequency;
      }
      break;

    case 'setVolume':
      // Cxx: Set volume (00-40 in FT2, we scale to 0-1)
      state.currentVolume = Math.min(1, (effect.paramX * 16 + effect.paramY) / 64);
      result.volume = state.currentVolume;
      break;

    case 'setPan':
      // 8xx: Set panning (00=left, 80=center, FF=right)
      state.currentPan = ((effect.paramX * 16 + effect.paramY) - 128) / 128;
      result.pan = state.currentPan;
      break;

    case 'finePortaUp':
      // E1x: Fine portamento up (applied once on tick 0)
      state.currentFrequency *= Math.pow(2, effect.paramY / (12 * 16));
      state.currentMidi = frequencyToMidi(state.currentFrequency);
      if (state.currentPeriod !== undefined) {
        state.currentPeriod = clampProtrackerPeriod(
          AMIGA_CLOCK / (2 * state.currentFrequency * PAULA_TO_SYNTH_SCALE)
        );
      }
      result.frequency = state.currentFrequency;
      break;

    case 'finePortaDown':
      // E2x: Fine portamento down (applied once on tick 0)
      state.currentFrequency /= Math.pow(2, effect.paramY / (12 * 16));
      state.currentMidi = frequencyToMidi(state.currentFrequency);
      if (state.currentPeriod !== undefined) {
        state.currentPeriod = clampProtrackerPeriod(
          AMIGA_CLOCK / (2 * state.currentFrequency * PAULA_TO_SYNTH_SCALE)
        );
      }
      result.frequency = state.currentFrequency;
      break;

    case 'setVibratoWave':
      state.vibratoWaveform = effect.paramY & 3;
      break;

    case 'setTremoloWave':
      state.tremoloWaveform = effect.paramY & 3;
      break;

    case 'noteCut':
      // ECx: Note cut after x ticks
      state.noteCutTick = effect.paramY;
      if (state.noteCutTick === 0) {
        result.cutNote = true;
      }
      break;

    case 'noteDelay':
      // EDx: Note delay by x ticks
      state.noteDelayTick = effect.paramY;
      if (newNote !== undefined && newVelocity !== undefined) {
        state.delayedNote = { midi: newNote, velocity: newVelocity };
        // Don't trigger on tick 0
      }
      break;

    case 'retrigVol':
      // Rxy: Retrigger with volume slide
      // E9x: Retrigger without volume slide (mapped via extSubtype === 'retrigger')
      state.retriggerInterval = effect.paramY;
      state.retriggerTick = 0;
      state.retriggerVolChange =
        effect.extSubtype === 'retrigger' ? 0 : effect.paramX;
      break;

    case 'keyOff':
      // Kxx: Key off after xx ticks
      if (effect.paramX * 16 + effect.paramY === 0) {
        result.cutNote = true;
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

    case 'tremor':
      // Txy: Tremor handled per-tick
      break;

    default:
      break;
  }

  // Default frequency if not set
  if (result.frequency === undefined) {
    result.frequency = state.currentFrequency;
  }

  return result;
}

/**
 * Process effect for ticks 1-N of a row
 */
export function processEffectTickN(
  state: TrackEffectState,
  effect: EffectCommand | undefined,
  tick: number,
  _ticksPerRow: number
): TickEffectResult {
  const result: TickEffectResult = {};

  // Check for note cut
  if (state.noteCutTick === tick) {
    result.cutNote = true;
    state.noteCutTick = -1;
  }

  // Check for note delay
  if (state.noteDelayTick === tick && state.delayedNote) {
    result.triggerNote = state.delayedNote;
    state.currentMidi = state.delayedNote.midi;
    state.currentFrequency = midiToFrequency(state.delayedNote.midi);
    state.currentVolume = state.delayedNote.velocity / 127;
    state.delayedNote = undefined;
    state.noteDelayTick = -1;
  }

  if (!effect) {
    return result;
  }

  switch (effect.type) {
    case 'portaUp':
      // Slide pitch up
      // For ProTracker MODs, use period-based portamento for authentic behavior
      if (state.currentPeriod !== undefined) {
        // ProTracker: subtract from period (makes pitch go up)
        const periodChange = Math.abs(state.portamentoSpeed);
        state.currentPeriod -= periodChange;
        state.currentPeriod = clampProtrackerPeriod(state.currentPeriod);
        state.currentFrequency = synthFrequencyFromPeriod(state.currentPeriod);
        state.currentMidi = frequencyToMidi(state.currentFrequency);
        result.frequency = state.currentFrequency;
      } else {
        // Standard semitone-based portamento
        state.currentFrequency *= Math.pow(2, state.portamentoSpeed / (12 * 16));
        state.currentMidi = frequencyToMidi(state.currentFrequency);
        result.frequency = state.currentFrequency;
      }
      break;

    case 'portaDown':
      // Slide pitch down
      // For ProTracker MODs, use period-based portamento for authentic behavior
      if (state.currentPeriod !== undefined) {
        // ProTracker: add to period (makes pitch go down)
        const periodChange = Math.abs(state.portamentoSpeed);
        state.currentPeriod += periodChange;
        state.currentPeriod = clampProtrackerPeriod(state.currentPeriod);
        state.currentFrequency = synthFrequencyFromPeriod(state.currentPeriod);
        state.currentMidi = frequencyToMidi(state.currentFrequency);
        result.frequency = state.currentFrequency;
      } else {
        // Standard semitone-based portamento
        state.currentFrequency *= Math.pow(2, state.portamentoSpeed / (12 * 16));
        state.currentMidi = frequencyToMidi(state.currentFrequency);
        result.frequency = state.currentFrequency;
      }
      break;

    case 'tonePorta':
    case 'tonePortaVol':
      result.frequency = applyTonePortaStep(state);

      // Handle volume slide for 5xy
      if (effect.type === 'tonePortaVol') {
        state.currentVolume = Math.max(0, Math.min(1, state.currentVolume + state.volSlideSpeed));
        result.volume = state.currentVolume;
      }
      break;

    case 'vibrato':
    case 'fineVibrato':
      // Apply vibrato
      state.vibratoPos += state.vibratoSpeed;
      const vibratoOffset = getWaveformValue(state.vibratoPos, state.vibratoWaveform);
      const vibratoSemitones = vibratoOffset * state.vibratoDepth / 16;
      result.frequency = state.currentFrequency * Math.pow(2, vibratoSemitones / 12);
      break;

    case 'vibratoVol':
      // Vibrato + volume slide
      state.vibratoPos += state.vibratoSpeed;
      const vibOffset = getWaveformValue(state.vibratoPos, state.vibratoWaveform);
      const vibSemitones = vibOffset * state.vibratoDepth / 16;
      result.frequency = state.currentFrequency * Math.pow(2, vibSemitones / 12);
      state.currentVolume = Math.max(0, Math.min(1, state.currentVolume + state.volSlideSpeed));
      result.volume = state.currentVolume;
      break;

    case 'tremolo':
      // Apply tremolo (volume oscillation)
      state.tremoloPos += state.tremoloSpeed;
      const tremoloOffset = getWaveformValue(state.tremoloPos, state.tremoloWaveform);
      const tremoloAmount = tremoloOffset * state.tremoloDepth / 64;
      result.volume = Math.max(0, Math.min(1, state.currentVolume + tremoloAmount));
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
        const period = protrackerArpPeriod(state.currentPeriod, offset);
        result.frequency = period === 0 ? 0 : synthFrequencyFromPeriod(period);
      } else {
        let arpeggioNote = state.currentMidi;
        arpeggioNote += offset;
        result.frequency = midiToFrequency(arpeggioNote);
      }
      break;
    }

    case 'volSlide':
      // Skip per-tick processing for EAx/EBx fine slides – they are tick-0 only.
      if (effect.extSubtype === 'fineVolUp' || effect.extSubtype === 'fineVolDown') {
        break;
      }
      state.currentVolume = Math.max(0, Math.min(1, state.currentVolume + state.volSlideSpeed));
      result.volume = state.currentVolume;
      break;

    case 'panSlide':
      state.currentPan = Math.max(-1, Math.min(1, state.currentPan + state.panSlideSpeed));
      result.pan = state.currentPan;
      break;

    case 'retrigVol':
      // Retrigger note
      state.retriggerTick++;
      if (state.retriggerInterval > 0 && state.retriggerTick >= state.retriggerInterval) {
        state.retriggerTick = 0;

        // Apply volume change (Rxy only; E9x uses extSubtype 'retrigger' and keeps volume)
        if (effect.extSubtype !== 'retrigger') {
          switch (state.retriggerVolChange) {
            case 1: state.currentVolume -= 1/64; break;
            case 2: state.currentVolume -= 2/64; break;
            case 3: state.currentVolume -= 4/64; break;
            case 4: state.currentVolume -= 8/64; break;
            case 5: state.currentVolume -= 16/64; break;
            case 6: state.currentVolume *= 2/3; break;
            case 7: state.currentVolume *= 0.5; break;
            case 9: state.currentVolume += 1/64; break;
            case 10: state.currentVolume += 2/64; break;
            case 11: state.currentVolume += 4/64; break;
            case 12: state.currentVolume += 8/64; break;
            case 13: state.currentVolume += 16/64; break;
            case 14: state.currentVolume *= 1.5; break;
            case 15: state.currentVolume *= 2; break;
          }
          state.currentVolume = Math.max(0, Math.min(1, state.currentVolume));
        }

        result.triggerNote = {
          midi: state.currentMidi,
          velocity: Math.round(state.currentVolume * 127)
        };
      }
      break;

    case 'tremor':
      // Txy: Sound on for x+1 ticks, off for y+1 ticks
      const onTicks = effect.paramX + 1;
      const offTicks = effect.paramY + 1;
      const tremorCycle = tick % (onTicks + offTicks);
      result.volume = tremorCycle < onTicks ? state.currentVolume : 0;
      break;

    case 'keyOff':
      const keyOffTick = effect.paramX * 16 + effect.paramY;
      if (tick === keyOffTick) {
        result.cutNote = true;
      }
      break;

    default:
      break;
  }

  return result;
}

/**
 * Reset effect state for a new note
 */
export function resetEffectStateForNote(state: TrackEffectState): void {
  state.vibratoPos = 0;
  state.tremoloPos = 0;
  state.arpeggioTick = 0;
  state.retriggerTick = 0;
  state.noteCutTick = -1;
  state.noteDelayTick = -1;
  state.delayedNote = undefined;
}
