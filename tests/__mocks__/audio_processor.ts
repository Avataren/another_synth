// Mock for WASM audio processor module
// This provides type definitions and mock implementations for testing

export enum WasmModulationType {
  Add = 0,
  Multiply = 1,
  Bipolar = 2,
}

export enum ModulationTransformation {
  Linear = 0,
  Exponential = 1,
  Logarithmic = 2,
}

export enum PortId {
  None = 0,
  Frequency = 1,
  Gain = 2,
  PhaseMod = 3,
  FreqMod = 4,
  // Add other port IDs as needed
}

// Mock other exports as needed
export const mockWasmFunction = () => {};
