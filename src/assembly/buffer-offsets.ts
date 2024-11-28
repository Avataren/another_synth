import { OscillatorState } from './oscillator';

@unmanaged
export class BufferOffsets {
  constructor(
    public output: usize = 0,
    public frequency: usize = 0,
    public gain: usize = 0,
    public detune: usize = 0,
    public gate: usize = 0,
    public oscillator1State: usize = 0,
    public oscillator2State: usize = 0,
  ) {}
}

export function allocateF32Array(length: i32): i32 {
  const arr: Float32Array = new Float32Array(length);
  return changetype<i32>(arr);
}

export function createBufferOffsets(
  output: usize,
  frequency: usize,
  gain: usize,
  detune: usize,
  gate: usize,
  oscillator1State: usize,
  oscillator2State: usize,
): usize {
  const offsets = new BufferOffsets(
    output,
    frequency,
    gain,
    detune,
    gate,
    oscillator1State,
    oscillator2State,
  );
  return changetype<usize>(offsets);
}

export function createOscillatorState(): usize {
  const numFloatsInStruct = 2;
  const buffer = new Float32Array(numFloatsInStruct);
  buffer[0] = 0.0;
  buffer[1] = 1.0;
  const ptr = changetype<usize>(buffer);
  return ptr;
}

// export function freeBufferOffsets(ptr: usize): void {
//   __free(changetype<usize>(ptr));
// }
