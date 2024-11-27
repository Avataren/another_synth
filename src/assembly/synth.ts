// src/assembly/synth.ts
export const TWO_PI: f32 = 6.28318530718;
let phase: f32 = 0;

// Instead of exporting a class, we'll work directly with memory offsets
export function allocateF32Array(length: i32): i32 {
  const arr: Float32Array = new Float32Array(length);
  return changetype<i32>(arr);
}

// Create a struct-like object in memory
export function createBufferOffsets(
  output: usize,
  frequency: usize,
  gain: usize,
  detune: usize,
): usize {
  // Allocate space for 4 usizes (32 bytes on 64-bit systems)
  const ptr = heap.alloc(32) as usize;

  // Store the offsets at consecutive memory locations
  store<usize>(ptr, output);
  store<usize>(ptr + 8, frequency);
  store<usize>(ptr + 16, gain);
  store<usize>(ptr + 24, detune);

  return ptr;
}

function centsToRatio(cents: f32): f32 {
  return Mathf.pow(2.0, cents / 1200.0);
}

export function fillSine(
  offsetsPtr: usize,
  length: i32,
  sampleRate: f32,
): void {
  // Read the buffer offsets from memory
  const outputOffset = load<usize>(offsetsPtr);
  const frequencyOffset = load<usize>(offsetsPtr + 8);
  const gainOffset = load<usize>(offsetsPtr + 16);
  const detuneOffset = load<usize>(offsetsPtr + 24);

  let index = 0;

  for (let i = 0; i < length; i++) {
    // Load parameters from memory
    const baseFreq = load<f32>(frequencyOffset + index);
    const gain = load<f32>(gainOffset + index);
    const detune = load<f32>(detuneOffset + index);

    // Apply detune to frequency
    const frequency = baseFreq * centsToRatio(detune);

    // Calculate phase increment
    const phaseStep: f32 = (TWO_PI * frequency) / sampleRate;

    // Generate sample and apply gain
    store<f32>(outputOffset + index, Mathf.sin(phase) * gain);

    // Update phase
    phase += phaseStep;
    while (phase >= TWO_PI) {
      phase -= TWO_PI;
    }

    index += 4; // Move to next float32
  }
}

// Optional: Add a cleanup function
export function freeBufferOffsets(offsetsPtr: usize): void {
  heap.free(offsetsPtr);
}
