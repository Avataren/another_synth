// Mock for WASM audio processor module
// This provides type definitions and mock implementations for testing
import { vi } from 'vitest';

export enum WasmModulationType {
  VCA = 0,
  Bipolar = 1,
  Additive = 2,
}

export enum ModulationTransformation {
  None = 0,
  Invert = 1,
  Square = 2,
  Cube = 3,
}

export enum VoiceNodeType {
  Oscillator = 'oscillator',
  WavetableOscillator = 'wavetable_oscillator',
  Filter = 'filter',
  Envelope = 'envelope',
  LFO = 'lfo',
  Mixer = 'mixer',
  Noise = 'noise',
  Sampler = 'sampler',
}

export class NoiseUpdateParams {
  constructor(
    public noise_type: number,
    public cutoff: number,
    public gain: number,
    public enabled: boolean,
  ) {}
}

export class AudioEngine {
  init() {}
  initWithPatch() {}

  static get_envelope_preview = vi.fn(() => new Float32Array([0, 0.5, 1, 0.5]));
}

export class AutomationAdapter {
  processBlock = vi.fn();
  applyConnectionUpdate = vi.fn();
  free = vi.fn();
}

export class AudioEnginePreview {
  static get_envelope_preview = vi.fn(() => new Float32Array([0, 0.5, 1, 0.5]));
}

export class AnalogOscillatorStateUpdate {
  constructor(
    public phase_mod_amount: number,
    public detune: number,
    public hard_sync: boolean,
    public gain: number,
    public active: boolean,
    public feedback_amount: number,
    public waveform: unknown,
    public unison_voices: number,
    public spread: number,
  ) {}
}

export class WavetableOscillatorStateUpdate {
  constructor(
    public phase_mod_amount: number,
    public detune: number,
    public hard_sync: boolean,
    public gain: number,
    public active: boolean,
    public feedback_amount: number,
    public unison_voices: number,
    public spread: number,
    public wave_index: number,
  ) {}
}

export class WasmLfoUpdateParams {
  constructor(
    public lfoId: string,
    public frequency: number,
    public phaseOffset: number,
    public waveform: number,
    public useAbsolute: boolean,
    public useNormalized: boolean,
    public triggerMode: number,
    public gain: number,
    public active: boolean,
    public loopMode: number,
    public loopStart: number,
    public loopEnd: number,
  ) {}
}

export enum PortId {
  AudioInput0 = 0,
  AudioInput1 = 1,
  AudioInput2 = 2,
  AudioInput3 = 3,
  AudioOutput0 = 4,
  AudioOutput1 = 5,
  AudioOutput2 = 6,
  AudioOutput3 = 7,
  GlobalGate = 8,
  GlobalFrequency = 9,
  GlobalVelocity = 10,
  Frequency = 11,
  FrequencyMod = 12,
  PhaseMod = 13,
  ModIndex = 14,
  CutoffMod = 15,
  ResonanceMod = 16,
  GainMod = 17,
  EnvelopeMod = 18,
  StereoPan = 19,
  FeedbackMod = 20,
  DetuneMod = 21,
  WavetableIndex = 22,
  WetDryMix = 23,
  AttackMod = 24,
  ArpGate = 25,
  CombinedGate = 26,
}

// Mock other exports as needed
export const mockWasmFunction = () => {};
