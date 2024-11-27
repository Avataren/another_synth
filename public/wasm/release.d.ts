/** Exported memory */
export declare const memory: WebAssembly.Memory;
/** src/assembly/synth/TWO_PI */
export declare const TWO_PI: {
  /** @type `f32` */
  get value(): number
};
/**
 * src/assembly/synth/allocateF32Array
 * @param length `i32`
 * @returns `i32`
 */
export declare function allocateF32Array(length: number): number;
/**
 * src/assembly/synth/createBufferOffsets
 * @param output `usize`
 * @param frequency `usize`
 * @param gain `usize`
 * @param detune `usize`
 * @returns `usize`
 */
export declare function createBufferOffsets(output: number, frequency: number, gain: number, detune: number): number;
/**
 * src/assembly/synth/fillSine
 * @param offsetsPtr `usize`
 * @param length `i32`
 * @param sampleRate `f32`
 */
export declare function fillSine(offsetsPtr: number, length: number, sampleRate: number): void;
/**
 * src/assembly/synth/freeBufferOffsets
 * @param offsetsPtr `usize`
 */
export declare function freeBufferOffsets(offsetsPtr: number): void;
