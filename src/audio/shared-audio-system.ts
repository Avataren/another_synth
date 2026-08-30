import { markRaw } from 'vue';
import AudioSystem from './AudioSystem';

let sharedAudioSystem: AudioSystem | null = null;

/**
 * Retrieve the singleton AudioSystem used across the app.
 * This ensures we only ever create one AudioContext.
 */
export function getSharedAudioSystem(): AudioSystem {
  if (!sharedAudioSystem) {
    sharedAudioSystem = markRaw(new AudioSystem());
  }
  return sharedAudioSystem;
}

/**
 * The AudioSystem if one has been built, without building one.
 *
 * Settings needs to report the rate the engine is actually running at, and
 * asking for the singleton would construct a context purely to read it --
 * before any user gesture, which browsers rightly complain about.
 */
export function peekSharedAudioSystem(): AudioSystem | null {
  return sharedAudioSystem;
}

/** Reset helper for tests or teardown paths */
export function resetSharedAudioSystem(): void {
  sharedAudioSystem = null;
}
