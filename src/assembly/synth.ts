import { BufferOffsets } from './buffer-offsets';
import { processEnvelope } from './envelope';

export const TWO_PI: f32 = 6.28318530718;
let phase: f32 = 0;

// Re-export the buffer management functions
export {
  allocateF32Array,
  createBufferOffsets,
} from './buffer-offsets';

export {
  createEnvelopeState
} from './envelope';

function centsToRatio(cents: f32): f32 {
  return Mathf.pow(2.0, cents / 1200.0);
}

export function fillSine(
  offsetsPtr: usize,
  envPtr: usize,
  length: i32,
  sampleRate: f32,
): void {
  const offsets = changetype<BufferOffsets>(offsetsPtr);

  let index = 0;
  for (let i = 0; i < length; i++) {
    const baseFreq = load<f32>(offsets.frequency + index);
    const gain = load<f32>(offsets.gain + index);
    const detune = load<f32>(offsets.detune + index);
    const gate = load<f32>(offsets.gate + index);
    //const envValue = processEnvelope(envPtr, sampleRate, gate > 0.5 ? true : false);
    const frequency = baseFreq * centsToRatio(detune);
    const phaseStep: f32 = (TWO_PI * frequency) / sampleRate;

    store<f32>(offsets.output + index, Mathf.sin(phase) * gain * gate);

    phase += phaseStep;
    while (phase >= TWO_PI) phase -= TWO_PI;
    index += 4;
  }
}
