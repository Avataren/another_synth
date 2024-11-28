/** Exported memory */
export declare const memory: WebAssembly.Memory;
/**
 * src/assembly/synth/getOscillatorState
 * @param ptr `usize`
 * @returns `src/assembly/oscillator/OscillatorState`
 */
export declare function getOscillatorState(ptr: number): __Internref0;
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
 * @param oscillator1State `usize`
 * @param oscillator2State `usize`
 * @returns `usize`
 */
export declare function createBufferOffsets(output: number, frequency: number, gain: number, detune: number, gate: number, oscillator1State: number, oscillator2State: number): number;
/**
 * src/assembly/buffer-offsets/createOscillatorState
 * @returns `usize`
 */
export declare function createOscillatorState(): number;
/**
 * src/assembly/envelope/createEnvelopeState
 * @param attackTime `f32`
 * @param decayTime `f32`
 * @param sustainLevel `f32`
 * @param releaseTime `f32`
 * @returns `usize`
 */
export declare function createEnvelopeState(attackTime: number, decayTime: number, sustainLevel: number, releaseTime: number): number;
/** src/assembly/oscillator/OscillatorState */
declare class __Internref0 extends Number {
  private __nominal0: symbol;
}
