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

function periodFromFrequency(freq: number): number {
  return clampProtrackerPeriod(AMIGA_CLOCK / (2 * freq * PAULA_TO_SYNTH_SCALE));
}

function protrackerArpPeriod(
  basePeriod: number,
  semitoneOffset: number,
): number {
  // Higher pitch -> smaller period.
  const shifted = basePeriod / Math.pow(2, semitoneOffset / 12);
  if (shifted < MIN_PROTRACKER_PERIOD) {
    // ProTracker wraps past the top of the table; the first overflow hits 0 (DC).
    return 0;
  }
  return clampProtrackerPeriod(shifted);
}

function updatePitchFromPeriod(state: TrackEffectState, period: number): void {
  const clamped = clampProtrackerPeriod(period);
  state.currentPeriod = clamped;
  const frequency = synthFrequencyFromPeriod(clamped);
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
    const rawPeriod = AMIGA_CLOCK / (2 * frequency * PAULA_TO_SYNTH_SCALE);
    state.currentPeriod = clampProtrackerPeriod(rawPeriod);
  }
}

function applyFinePortamento(
  state: TrackEffectState,
  semitoneDelta: number,
): void {
  const ratio = Math.pow(2, semitoneDelta / (12 * 16));
  if (state.currentPeriod !== undefined) {
    const nextPeriod = state.currentPeriod / ratio;
    updatePitchFromPeriod(state, nextPeriod);
  } else {
    updatePitchFromFrequency(state, state.currentFrequency * ratio);
  }
}

function applyPortamentoStep(state: TrackEffectState): void {
  const speed = state.portamentoSpeed;
  if (speed === 0) return;

  if (state.currentPeriod !== undefined) {
    const delta = Math.abs(speed);
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
  volumeSlide: {
    delta: number; // positive = up, negative = down (normalized per tick)
    mode: 'none' | 'normal' | 'fine';
    source: 'volSlide' | 'tonePortaVol' | 'vibratoVol' | null;
  };

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
  delayedNote:
    | {
        midi: number;
        velocity: number;
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

  // Note delay overflow to next row (ProTracker EDx quirk)
  carryDelayedNote: { midi: number; velocity: number } | null;
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

    tremoloSpeed: 0,
    tremoloDepth: 0,
    tremoloPos: 0,
    tremoloWaveform: 0,

    arpeggioX: 0,
    arpeggioY: 0,
    arpeggioTick: 0,

    volumeSlide: { delta: 0, mode: 'none', source: null },
    panSlideSpeed: 0,

    retriggerInterval: 0,
    retriggerTick: 0,
    retriggerVolChange: 0,
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
    state.currentPeriod = periodFromFrequency(state.currentFrequency);
  }

  if (state.currentPeriod !== undefined && state.targetPeriod !== undefined) {
    let nextPeriod = state.currentPeriod;
    if (state.currentPeriod > state.targetPeriod) {
      nextPeriod = Math.max(
        state.targetPeriod,
        state.currentPeriod - state.tonePortaSpeed,
      );
    } else if (state.currentPeriod < state.targetPeriod) {
      nextPeriod = Math.min(
        state.targetPeriod,
        state.currentPeriod + state.tonePortaSpeed,
      );
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
    const snappedMidi = Math.round(frequencyToMidi(state.currentFrequency));
    const snappedFrequency = midiToFrequency(snappedMidi);
    updatePitchFromFrequency(state, snappedFrequency);
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
      const scale = 1 / 128;
      if (effect.paramX) delta = effect.paramX * scale;
      else if (effect.paramY) delta = -effect.paramY * scale;
      else if (state.lastVolSlide) {
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
  | { kind: 'pan'; pan: number }
  | { kind: 'sampleOffset'; offset: number; voiceIndex?: number }
  | { kind: 'retrigger'; midi: number; velocity: number };

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
    commands.push({ kind: 'pan', pan: value });
  };

  const pushNoteOn = (midi: number, velocity: number) => {
    commands.push({
      kind: 'noteOn',
      midi,
      velocity,
      frequency: state.currentFrequency,
      ...(pan !== undefined ? { pan } : {}),
    });
  };

  // Reset per-row volume slide accumulator (effect memory stored separately)
  resetVolumeSlide(state);

  // ProTracker note delay overflow: if previous row had EDx with x >= speed and
  // no new note arrives, trigger the carried note at the start of this row.
  if (!effect && newNote === undefined && state.carryDelayedNote) {
    const carry = state.carryDelayedNote;
    state.carryDelayedNote = null;
    state.currentMidi = carry.midi;
    state.currentFrequency = midiToFrequency(carry.midi);
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
        state.targetPeriod = periodFromFrequency(targetFreq);
      } else {
        state.targetPeriod = undefined;
      }
      state.lastTonePortaTargetFreq = state.targetFrequency;
      state.lastTonePortaTargetPeriod = state.targetPeriod;
      state.tonePortaActive = state.tonePortaSpeed > 0;
    } else {
      if (noteFrequency !== undefined) {
        const rawPeriod =
          AMIGA_CLOCK / (2 * noteFrequency * PAULA_TO_SYNTH_SCALE);
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
      }
    }
  }

  if (newVelocity !== undefined) {
    // newVelocity is in 0-255 range (from MOD importer volume column)
    // Normalize to 0-1 for internal use
    state.currentVolume = newVelocity / 255;
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
      // Apply an initial slide on tick 0 so we don't stop one step short.
      {
        const freq = applyTonePortaStep(state);
        pushPitch(freq);
        if (state.targetFrequency === state.currentFrequency) {
          state.tonePortaActive = false;
        }
      }
      break;

    case 'vibrato':
      if (effect.paramX) state.vibratoSpeed = effect.paramX;
      if (effect.paramY) state.vibratoDepth = effect.paramY;
      state.lastVibrato = (state.vibratoSpeed << 4) | state.vibratoDepth;
      break;

    case 'tonePortaVol':
      // Tone porta continues, volume slide applies
      state.tonePortaSpeed = resolveTonePortaSpeed(
        state,
        effect.paramX,
        effect.paramY,
      );
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
      // Apply an initial slide on tick 0 so we don't stop one step short.
      {
        const freq = applyTonePortaStep(state);
        pushPitch(freq);
        if (state.targetFrequency === state.currentFrequency) {
          state.tonePortaActive = false;
        }
      }
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
        // E5x: Set finetune for current note (approximate, per-row only).
        const nibble = effect.paramY & 0x0f;
        const finetuneSteps = nibble < 8 ? nibble : nibble - 16; // -8..7
        const semitones = finetuneSteps / 8;
        const ratio = Math.pow(2, semitones / 12);
        state.targetFrequency *= ratio;
        state.targetMidi = frequencyToMidi(state.targetFrequency);
        state.targetPeriod = periodFromFrequency(state.targetFrequency);
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
      // 8xx: Set panning (00=left, 80=center, FF=right)
      state.currentPan = (effect.paramX * 16 + effect.paramY - 128) / 128;
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
        commands.push({ kind: 'noteOff' });
      }
      break;

    case 'noteDelay': {
      // EDx: Note delay by x ticks
      state.noteDelayTick = effect.paramY;
      if (newNote !== undefined && newVelocity !== undefined) {
        state.delayedNote = { midi: newNote, velocity: newVelocity };
        // If delay exceeds or equals the current speed, ProTracker spills to the next row.
        if (ticksPerRow !== undefined && state.noteDelayTick >= ticksPerRow) {
          state.carryDelayedNote = state.delayedNote;
          state.delayedNote = undefined;
          state.noteDelayTick = -1;
        }
        // Don't trigger on tick 0
      }
      break;
    }

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

    case 'tremor':
      // Txy: Tremor handled per-tick
      break;

    case 'sampleOffset': {
      const raw = effect.paramX * 16 + effect.paramY; // 0x00-0xFF
      const offsetNorm = Math.max(0, Math.min(1, raw / 255));
      const cmd: ProcessorCommand =
        voiceIndex !== undefined
          ? { kind: 'sampleOffset', offset: offsetNorm, voiceIndex }
          : { kind: 'sampleOffset', offset: offsetNorm };
      commands.push(cmd);
      break;
    }

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

  // Check for note cut
  if (state.noteCutTick === tick) {
    commands.push({ kind: 'noteOff' });
    state.noteCutTick = -1;
  }

  // Check for note delay
  if (state.noteDelayTick === tick && state.delayedNote) {
    const delayed = state.delayedNote;
    commands.push({
      kind: 'noteOn',
      midi: delayed.midi,
      velocity: 127,
      frequency: midiToFrequency(delayed.midi),
    });
    state.currentMidi = delayed.midi;
    state.currentFrequency = midiToFrequency(delayed.midi);
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
      const vibratoOffset = getWaveformValue(
        state.vibratoPos,
        state.vibratoWaveform,
      );
      const vibratoSemitones = (vibratoOffset * state.vibratoDepth) / 16;
      pushPitch(state.currentFrequency * Math.pow(2, vibratoSemitones / 12));
      break;

    case 'vibratoVol':
      // Vibrato + volume slide
      state.vibratoPos += state.vibratoSpeed;
      const vibOffset = getWaveformValue(
        state.vibratoPos,
        state.vibratoWaveform,
      );
      const vibSemitones = (vibOffset * state.vibratoDepth) / 16;
      pushPitch(state.currentFrequency * Math.pow(2, vibSemitones / 12));
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
      const tremoloAmount = (tremoloOffset * state.tremoloDepth) / 64;
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
        const period = protrackerArpPeriod(state.currentPeriod, offset);
        pushPitch(period === 0 ? 0 : synthFrequencyFromPeriod(period));
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
        });
      }
      break;

    case 'tremor':
      // Txy: Sound on for x+1 ticks, off for y+1 ticks
      const onTicks = effect.paramX + 1;
      const offTicks = effect.paramY + 1;
      const tremorCycle = tick % (onTicks + offTicks);
      pushVolume(tremorCycle < onTicks ? state.currentVolume : 0);
      break;

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
  state.tonePortaActive = false;
}
