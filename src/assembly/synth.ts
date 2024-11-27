import { BufferOffsets } from './buffer-offsets';

export const TWO_PI: f32 = 6.28318530718;
let phase: f32 = 0;

// Re-export the buffer management functions
export {
  allocateF32Array,
  createBufferOffsets,
  freeBufferOffsets,
} from './buffer-offsets';

function centsToRatio(cents: f32): f32 {
  return Mathf.pow(2.0, cents / 1200.0);
}

export function fillSine(
  offsetsPtr: usize,
  length: i32,
  sampleRate: f32,
): void {
  const offsets = changetype<BufferOffsets>(offsetsPtr);

  let index = 0;
  for (let i = 0; i < length; i++) {
    // Load parameters from memory
    const baseFreq = load<f32>(offsets.frequency + index);
    const gain = load<f32>(offsets.gain + index);
    const detune = load<f32>(offsets.detune + index);

    // Apply detune to frequency
    const frequency = baseFreq * centsToRatio(detune);

    // Calculate phase increment
    const phaseStep: f32 = (TWO_PI * frequency) / sampleRate;

    // Generate sample and apply gain
    store<f32>(offsets.output + index, Mathf.sin(phase) * gain);

    // Update phase
    phase += phaseStep;
    while (phase >= TWO_PI) {
      phase -= TWO_PI;
    }

    index += 4; // Move to next float32
  }
}
