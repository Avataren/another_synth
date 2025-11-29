// Mock for WASM audio processor module
// This provides type definitions and mock implementations for testing

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
