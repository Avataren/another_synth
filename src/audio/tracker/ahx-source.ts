import type { TrackerSongFile } from 'src/stores/tracker-store';

/**
 * The raw bytes behind an imported AHX/HVL song, and the instrument edits made
 * to it since.
 *
 * The other formats are fully expanded into the song file (patterns plus one
 * sampler patch per instrument), so the store holds everything playback needs.
 * An AHX song is not: the Rust engine in the worklet plays the *file*, and the
 * row model built from it is display only. The bytes therefore have to travel
 * alongside the song file from the parse to the player.
 *
 * Three pieces, matching the three moments:
 *  - a `WeakMap` keyed by the parsed `TrackerSongFile`, so bytes parsed ahead
 *    of time by the jukebox's prefetch stay attached to their own song and are
 *    collected with it;
 *  - a single "current" slot, set when a song is applied to the tracker and
 *    read when playback loads the worklet;
 *  - the instrument edits of the current song, as instrument wire forms (see
 *    `serializeAhxInstrument`). The bytes are the file as it was imported and
 *    never change; an edit is an instrument replaced *on top of them*. Every
 *    worklet that loads the song (the song player, the keyboard preview, either
 *    of them again after a reload) is handed these to apply right after the
 *    load, so no worklet plays a song that lacks an edit, and one that is
 *    already loaded is sent the edit as a live command. The edits belong to the
 *    current bytes: a different song (or a non-AHX one) drops them.
 */
const attached = new WeakMap<TrackerSongFile, Uint8Array>();

/** One instrument of the song, replaced: its 1-based number and its wire form. */
export interface AhxInstrumentEdit {
  instrument: number;
  bytes: Uint8Array;
}

let current: Uint8Array | null = null;
const edits = new Map<number, Uint8Array>();
const changeListeners = new Set<() => void>();
const editListeners = new Set<(edit: AhxInstrumentEdit) => void>();

export function attachAhxSource(songFile: TrackerSongFile, bytes: Uint8Array): void {
  attached.set(songFile, bytes);
}

export function ahxSourceOf(songFile: TrackerSongFile): Uint8Array | null {
  return attached.get(songFile) ?? null;
}

/** Called when a song is applied: the new song's bytes, or `null` for any other format. */
export function setCurrentAhxSource(bytes: Uint8Array | null): void {
  // The same song applied again (a jukebox replay of a prefetched file) has its
  // slots read afresh from the song file: instruments as parsed, without the
  // edits made since. A worklet that still holds those edits must not go on
  // playing what the display no longer shows, and loaders tell songs apart by
  // the identity of the bytes, so the re-applied song gets a copy: a new song
  // to every one of them.
  const reapplied = bytes !== null && bytes === current && edits.size > 0;
  if (bytes === current && !reapplied) return;
  current = reapplied ? bytes.slice() : bytes;
  edits.clear();
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

/**
 * Record that instrument `instrument` of the current song is now `bytes` (its
 * wire form) and tell whoever is listening (`onAhxInstrumentEdit`). Returns
 * `false`, recording nothing, when no AHX song is current: a song loaded from a
 * saved file carries no bytes to edit on top of.
 */
export function recordAhxInstrumentEdit(instrument: number, bytes: Uint8Array): boolean {
  if (!current) return false;
  const copy = bytes.slice();
  edits.set(instrument, copy);
  for (const listener of editListeners) listener({ instrument, bytes: copy });
  return true;
}

/** Every edit of the current song, in instrument order: what a worklet applies after loading it. */
export function currentAhxInstrumentEdits(): AhxInstrumentEdit[] {
  return [...edits.entries()]
    .sort(([a], [b]) => a - b)
    .map(([instrument, bytes]) => ({ instrument, bytes }));
}

/** Called for each `recordAhxInstrumentEdit`; the edit's bytes are the listener's to keep. */
export function onAhxInstrumentEdit(listener: (edit: AhxInstrumentEdit) => void): () => void {
  editListeners.add(listener);
  return () => editListeners.delete(listener);
}
