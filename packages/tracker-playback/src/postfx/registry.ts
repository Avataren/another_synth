/**
 * Registration point between `AudioSystem` and the Pinia post-fx store.
 *
 * `AudioSystem` is constructed before Pinia exists (its own constructor reads
 * localStorage for the same reason), so it *registers* the rack here at
 * construction; the store pushes its state into whatever is registered -- a
 * push, never a pull at construction time (review S3). If the store
 * initializes first, it holds its state and applies it on the first
 * registration callback; the stage meanwhile runs on its constructor
 * defaults.
 */

import type { AmigaLpfStage } from './amiga-lpf-stage';
import type { PostFxRack } from './post-fx-rack';

export interface PostFxRegistration {
  rack: PostFxRack;
  amigaLpf: AmigaLpfStage;
}

let current: PostFxRegistration | null = null;
const listeners = new Set<(registration: PostFxRegistration) => void>();

export function registerPostFxRack(registration: PostFxRegistration): void {
  current = registration;
  for (const listener of [...listeners]) {
    try {
      listener(registration);
    } catch (error) {
      console.error('[PostFx] registration listener failed', error);
    }
  }
}

export function getPostFxRack(): PostFxRegistration | null {
  return current;
}

/** Observe (current or future) registration. Returns an unsubscribe. */
export function onPostFxRackRegistered(
  listener: (registration: PostFxRegistration) => void,
): () => void {
  listeners.add(listener);
  if (current) listener(current);
  return () => listeners.delete(listener);
}

/** Test-only: drop the registration and all listeners. */
export function resetPostFxRegistryForTests(): void {
  current = null;
  listeners.clear();
}