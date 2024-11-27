@unmanaged
export class BufferOffsets {
  constructor(
    public output: usize = 0,
    public frequency: usize = 0,
    public gain: usize = 0,
    public detune: usize = 0,
    public gate: usize = 0,
  ) { }
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
): usize {
  const offsets = new BufferOffsets(output, frequency, gain, detune, gate);
  return changetype<usize>(offsets);
}

// export function freeBufferOffsets(ptr: usize): void {
//   __free(changetype<usize>(ptr));
// }
