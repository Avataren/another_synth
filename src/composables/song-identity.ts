import { sha256Hex } from './bug-report';

/**
 * Identity of the currently loaded module file, for the bug-report tool.
 *
 * The hash is computed once, at load, from the bytes that were actually
 * parsed -- never re-fetched at report time. Module-level rather than store
 * state: it is a single piece of data about the one loaded file, and nothing
 * needs to render it.
 *
 * Only file loads record here. A song that came from the native editor (no
 * raw module bytes) leaves the previous recording in place, which is why
 * `getLoadedSongHash` returning null is the signal for the report's native
 * fallback: the holder starts null and is never promoted by a load that did
 * not have bytes.
 */
let currentHash: string | null = null;
/** Guards against a slow digest from an older load landing after a newer one. */
let captureToken = 0;

/**
 * Compute and retain the sha256 of a loaded module. Fire-and-forget safe:
 * the newest call wins, and a failure leaves the previous value alone.
 */
export function recordLoadedSongHash(data: ArrayBuffer): void {
  const token = ++captureToken;
  void sha256Hex(new Uint8Array(data))
    .then((hash) => {
      if (token === captureToken) currentHash = hash;
    })
    .catch(() => {
      // Without a hash the report falls back to the native-song line.
      if (token === captureToken) currentHash = null;
    });
}

/** The retained hash of the loaded module bytes, or null when none exists. */
export function getLoadedSongHash(): string | null {
  return currentHash;
}

/**
 * Forget the hash, for when the tracker moves to a song whose raw bytes are
 * not retained (the native editor's own song). Any digest still in flight is
 * discarded with it.
 */
export function clearLoadedSongHash(): void {
  captureToken++;
  currentHash = null;
}
