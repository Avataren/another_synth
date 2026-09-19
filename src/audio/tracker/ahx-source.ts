import type { TrackerSongFile } from 'src/stores/tracker-store';

/**
 * The raw bytes behind an imported AHX/HVL song.
 *
 * The other formats are fully expanded into the song file (patterns plus one
 * sampler patch per instrument), so the store holds everything playback needs.
 * An AHX song is not: the Rust engine in the worklet plays the *file*, and the
 * row model built from it is display only. The bytes therefore have to travel
 * alongside the song file from the parse to the player.
 *
 * Two pieces, matching the two moments:
 *  - a `WeakMap` keyed by the parsed `TrackerSongFile`, so bytes parsed ahead
 *    of time by the jukebox's prefetch stay attached to their own song and are
 *    collected with it;
 *  - a single "current" slot, set when a song is applied to the tracker and
 *    read when playback loads the worklet.
 */
const attached = new WeakMap<TrackerSongFile, Uint8Array>();

let current: Uint8Array | null = null;
const changeListeners = new Set<() => void>();

export function attachAhxSource(songFile: TrackerSongFile, bytes: Uint8Array): void {
  attached.set(songFile, bytes);
}

export function ahxSourceOf(songFile: TrackerSongFile): Uint8Array | null {
  return attached.get(songFile) ?? null;
}

/** Called when a song is applied: the new song's bytes, or `null` for any other format. */
export function setCurrentAhxSource(bytes: Uint8Array | null): void {
  if (bytes === current) return;
  current = bytes;
  for (const listener of changeListeners) listener();
}

/**
 * Called whenever the current song's bytes change (a different AHX song, or a
 * non-AHX one). What was built from the old bytes, like the keyboard preview
 * voice, is stale from then on.
 */
export function onCurrentAhxSourceChange(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

export function currentAhxSource(): Uint8Array | null {
  return current;
}
