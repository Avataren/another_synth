/** Exported memory */
export declare const memory: WebAssembly.Memory;
/** src/assembly/synth/TWO_PI */
export declare const TWO_PI: {
  /** @type `f32` */
  get value(): number
};
/**
 * src/assembly/synth/fillSine
 * @param offsetsPtr `usize`
 * @param envPtr `usize`
 * @param length `i32`
 * @param sampleRate `f32`
 */
export declare function fillSine(offsetsPtr: number, envPtr: number, length: number, sampleRate: number): void;
/**
 * src/assembly/buffer-offsets/allocateF32Array
 * @param length `i32`
 * @returns `i32`
 */
export declare function allocateF32Array(length: number): number;
/**
 * src/assembly/buffer-offsets/createBufferOffsets
 * @param output `usize`
 * @param frequency `usize`
 * @param gain `usize`
 * @param detune `usize`
 * @param gate `usize`
 * @returns `usize`
 */
export declare function createBufferOffsets(output: number, frequency: number, gain: number, detune: number, gate: number): number;
/**
 * src/assembly/envelope/createEnvelopeState
 * @param attackTime `f32`
 * @param decayTime `f32`
 * @param sustainLevel `f32`
 * @param releaseTime `f32`
 * @returns `usize`
 */
export declare function createEnvelopeState(attackTime: number, decayTime: number, sustainLevel: number, releaseTime: number): number;
