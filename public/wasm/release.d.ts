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
 * src/assembly/synth/fillSine
 * @param startOffset `usize`
 * @param length `i32`
 * @param frequencyOffset `usize`
 * @param sampleRate `f32`
 */
export declare function fillSine(startOffset: number, length: number, frequencyOffset: number, sampleRate: number): void;
