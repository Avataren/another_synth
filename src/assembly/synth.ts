// index.ts

// Our audio constants
export const TWO_PI: f32 = 6.28318530718;
let phase: f32 = 0;

export function allocateF32Array(length: i32): i32 {
  const arr: Float32Array = new Float32Array(length);
  return changetype<i32>(arr); // return the pointer
}

// Write our sine wave data directly to memory at the given offset
export function fillSine(startOffset: usize, length: i32, frequencyOffset: usize, sampleRate: f32): void {
  // Calculate phase increment per sample
  let index = 0;
  // Write each sample directly to memory
  for (let i = 0; i < length; i++) {

    const frequency = load<f32>(frequencyOffset + index);
    const phaseStep: f32 = TWO_PI * frequency / sampleRate;

    // Write the sine value directly to memory
    store<f32>(startOffset + index, Mathf.sin(phase));

    // Update phase for next sample
    phase += phaseStep;
    while (phase >= TWO_PI) {
      phase -= TWO_PI;
    }
    index += 4;
  }
}