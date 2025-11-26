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

/** Reset helper for tests or teardown paths */
export function resetSharedAudioSystem(): void {
  sharedAudioSystem = null;
}
