/**
 * Gated debug logging for the playback and instrument-build hot paths.
 *
 * Shares the `?diag=playback` opt-in with playback-diagnostics.ts. The URL
 * is read once at module init, so a disabled call is a single boolean check:
 * no URL parsing, no console output.
 */

import { isPlaybackDiagEnabled } from 'src/diagnostics/playback-diagnostics';

const enabled = typeof window !== 'undefined' && isPlaybackDiagEnabled(window.location.search);

/** True when `?diag=playback` was present at module load. */
export function isDebugLogEnabled(): boolean {
  return enabled;
}

/** `console.log(...args)` when playback diagnostics are on; no-op otherwise. */
export function debugLog(...args: unknown[]): void {
  if (!enabled) return;
  console.log(...args);
}
