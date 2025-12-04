/**
 * Audio worklet configuration constants
 * These are compile-time constants that affect parameter descriptors and voice allocation
 */

/**
 * Number of AudioEngine instances per worklet
 *
 * Each engine has 8 voices and independent effects chain.
 * Total voices = ENGINES_PER_WORKLET * VOICES_PER_ENGINE
 * Total parameters = (ENGINES_PER_WORKLET * VOICES_PER_ENGINE * 8) + 1 master gain
 *
 * Examples:
 * - 1 engine:  8 voices,  65 params
 * - 2 engines: 16 voices, 129 params
 * - 3 engines: 24 voices, 193 params
 * - 4 engines: 32 voices, 257 params (EXCEEDS 256 LIMIT!)
 *
 * WARNING: AudioWorklets have a hard limit of 256 AudioParams.
 * Maximum safe value is 3 engines (193 params).
 * Do not set this above 3!
 */
export const ENGINES_PER_WORKLET = 2;

/**
 * Number of voices per engine (fixed at 8)
 */
export const VOICES_PER_ENGINE = 8;

/**
 * Number of macro parameters per voice (fixed at 4)
 */
export const MACROS_PER_VOICE = 4;

/**
 * Calculate total number of voices
 */
export const TOTAL_VOICES = ENGINES_PER_WORKLET * VOICES_PER_ENGINE;

/**
 * Calculate total number of parameters
 * Each voice has: gate, frequency, gain, velocity (4 params) + 4 macros = 8 params per voice
 * Plus 1 master gain parameter
 */
export const TOTAL_PARAMS = ENGINES_PER_WORKLET * VOICES_PER_ENGINE * 8 + 1;

// Compile-time validation
if (ENGINES_PER_WORKLET < 1) {
  throw new Error('ENGINES_PER_WORKLET must be at least 1');
}

if (ENGINES_PER_WORKLET > 3) {
  throw new Error(
    `ENGINES_PER_WORKLET is set to ${ENGINES_PER_WORKLET}, but maximum is 3 ` +
      `(would create ${TOTAL_PARAMS} params, exceeding the 256 AudioParam limit). ` +
      'Please set ENGINES_PER_WORKLET to 3 or less.',
  );
}

console.log(
  `[WorkletConfig] ${ENGINES_PER_WORKLET} engines × ${VOICES_PER_ENGINE} voices = ` +
    `${TOTAL_VOICES} total voices, ${TOTAL_PARAMS} AudioParams`,
);
