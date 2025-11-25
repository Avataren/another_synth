/**
 * FastTracker 2-style effect processor for the playback engine.
 * Handles per-tick effect processing for portamento, vibrato, arpeggio, etc.
 */

import type { EffectCommand } from './types';

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

  // Note cut/delay
  noteCutTick: number;
  noteDelayTick: number;
  delayedNote?: {
    midi: number;
    velocity: number;
  };

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
  newVelocity?: number
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
      state.currentFrequency = midiToFrequency(newNote);
      state.targetMidi = newNote;
      state.targetFrequency = state.currentFrequency;
    }
  }

  if (newVelocity !== undefined) {
    state.currentVolume = newVelocity / 127;
  }

  if (!effect) {
    result.frequency = state.currentFrequency;
    return result;
  }

  // Handle effect parameters (use memory if param is 0)
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
      state.tonePortaSpeed = effect.paramX * 16 + effect.paramY || state.lastTonePorta;
      state.lastTonePorta = state.tonePortaSpeed;
      break;

    case 'vibrato':
      if (effect.paramX) state.vibratoSpeed = effect.paramX;
      if (effect.paramY) state.vibratoDepth = effect.paramY;
      state.lastVibrato = (state.vibratoSpeed << 4) | state.vibratoDepth;
      break;

    case 'tonePortaVol':
      // Tone porta continues, volume slide applies
      if (effect.paramX) state.volSlideSpeed = effect.paramX;
      else if (effect.paramY) state.volSlideSpeed = -effect.paramY;
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

    case 'volSlide':
      if (effect.paramX) state.volSlideSpeed = effect.paramX / 64; // Fine adjustment
      else if (effect.paramY) state.volSlideSpeed = -effect.paramY / 64;
      state.lastVolSlide = (effect.paramX << 4) | effect.paramY;
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
      result.frequency = state.currentFrequency;
      break;

    case 'finePortaDown':
      // E2x: Fine portamento down (applied once on tick 0)
      state.currentFrequency /= Math.pow(2, effect.paramY / (12 * 16));
      state.currentMidi = frequencyToMidi(state.currentFrequency);
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
      state.retriggerInterval = effect.paramY;
      state.retriggerVolChange = effect.paramX;
      state.retriggerTick = 0;
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
      state.currentFrequency *= Math.pow(2, state.portamentoSpeed / (12 * 16));
      state.currentMidi = frequencyToMidi(state.currentFrequency);
      result.frequency = state.currentFrequency;
      break;

    case 'portaDown':
      // Slide pitch down
      state.currentFrequency *= Math.pow(2, state.portamentoSpeed / (12 * 16));
      state.currentMidi = frequencyToMidi(state.currentFrequency);
      result.frequency = state.currentFrequency;
      break;

    case 'tonePorta':
    case 'tonePortaVol':
      // Slide toward target note
      if (state.currentFrequency < state.targetFrequency) {
        state.currentFrequency *= Math.pow(2, state.tonePortaSpeed / (12 * 16));
        if (state.currentFrequency > state.targetFrequency) {
          state.currentFrequency = state.targetFrequency;
        }
      } else if (state.currentFrequency > state.targetFrequency) {
        state.currentFrequency /= Math.pow(2, state.tonePortaSpeed / (12 * 16));
        if (state.currentFrequency < state.targetFrequency) {
          state.currentFrequency = state.targetFrequency;
        }
      }
      state.currentMidi = frequencyToMidi(state.currentFrequency);
      result.frequency = state.currentFrequency;

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

    case 'arpeggio':
      // Cycle through base, +x semitones, +y semitones
      state.arpeggioTick = (state.arpeggioTick + 1) % 3;
      let arpeggioNote = state.currentMidi;
      if (state.arpeggioTick === 1) {
        arpeggioNote += state.arpeggioX;
      } else if (state.arpeggioTick === 2) {
        arpeggioNote += state.arpeggioY;
      }
      result.frequency = midiToFrequency(arpeggioNote);
      break;

    case 'volSlide':
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

        // Apply volume change
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
