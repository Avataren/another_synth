import { BufferOffsets } from './buffer-offsets';
import { processEnvelope } from './envelope';
import { Oscillator, OscillatorState } from './oscillator';

const osc1 = new Oscillator();
const osc2 = new Oscillator();

// Re-export the buffer management functions
export {
  allocateF32Array,
  createBufferOffsets,
  createOscillatorState,
} from './buffer-offsets';

export { createEnvelopeState } from './envelope';

export function getOscillatorState(ptr: usize): OscillatorState {
  return load<OscillatorState>(ptr);
}

export function fillSine(
  offsetsPtr: usize,
  envPtr: usize,
  length: i32,
  sampleRate: f32,
): void {
  const offsets = changetype<BufferOffsets>(offsetsPtr);
  const osc1StatePtr = load<usize>(offsets.oscillator1State);
  const osc1State = changetype<OscillatorState>(osc1StatePtr);
  const osc2StatePtr = load<usize>(offsets.oscillator2State);
  const osc2State = changetype<OscillatorState>(osc2StatePtr);

  let index = 0;
  for (let i = 0; i < length; i++) {
    const baseFreq = load<f32>(offsets.frequency + index);
    const gain = load<f32>(offsets.gain + index);
    const detune = load<f32>(offsets.detune + index);
    const gate = load<f32>(offsets.gate + index);
    const envValue = processEnvelope(
      envPtr,
      sampleRate,
      gate > 0.5 ? true : false,
    );

    const sample = osc1.processSample(osc1State, baseFreq, sampleRate, detune);
    const sample2 = osc2.processSample(
      osc2State,
      baseFreq * 1.5,
      sampleRate,
      detune,
    );
    store<f32>(offsets.output + index, (sample + sample2) * gain * envValue);
    index += 4;
  }
}
