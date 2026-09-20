import { shallowRef, toRaw, type ShallowRef } from 'vue';
import type { AhxSongFormat } from '@another-synth/tracker-playback';
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
 *
 * The bytes travel with what the header says of them, `{ format, version }`: an
 * instrument's wire form and its validity depend on both (HVL's PList entries
 * are wider and hold more commands; a version-0 AHX file drops the high nibble
 * of a filter-toggle parameter), and nothing else in the app records it.
 *
 * A snapshot of the editor's song (the Jukebox keeps one while it plays other
 * songs) carries the edits too (`snapshotAhxSource`), so that putting the song
 * back does not leave it a display model with no sound.
 */
const attached = new WeakMap<TrackerSongFile, AhxSource>();

/** What an AHX/HVL file's header says of it. */
export interface AhxSourceInfo {
  format: AhxSongFormat;
  /** Raw version byte (`buf[3]`): AHX 0..=2, HVL 0..=1. */
  version: number;
}

/** A song's bytes with their header info, and (in a snapshot) the edits made on top. */
export interface AhxSource extends AhxSourceInfo {
  bytes: Uint8Array;
  edits?: readonly AhxInstrumentEdit[];
}

/** The format and version the header names: `THX` is AHX, `HVL` is HVL; anything else reads as AHX 0. */
export function ahxSourceInfoOf(bytes: Uint8Array): AhxSourceInfo {
  const hvl = bytes[0] === 0x48 && bytes[1] === 0x56 && bytes[2] === 0x4c;
  return { format: hvl ? 'hvl' : 'ahx', version: bytes[3] ?? 0 };
}

/** One instrument of the song, replaced: its 1-based number and its wire form. */
export interface AhxInstrumentEdit {
  instrument: number;
  bytes: Uint8Array;
}

let current: Uint8Array | null = null;
/**
 * The current song's header info, reactive: `null` when no AHX song's bytes are
 * current, which is the byte-less state where an edit is kept but cannot be
 * heard (`AhxInstrumentPage` says so).
 */
export const ahxSourceInfo: ShallowRef<AhxSourceInfo | null> = shallowRef(null);
const edits = new Map<number, Uint8Array>();
const changeListeners = new Set<() => void>();
const editListeners = new Set<(edit: AhxInstrumentEdit) => void>();

export function attachAhxSource(
  songFile: TrackerSongFile,
  bytes: Uint8Array,
  info: AhxSourceInfo = ahxSourceInfoOf(bytes),
  editsMade?: readonly AhxInstrumentEdit[],
): void {
  attached.set(toRaw(songFile), {
    bytes,
    format: info.format,
    version: info.version,
    ...(editsMade && editsMade.length > 0 ? { edits: editsMade.map(copyEdit) } : {}),
  });
}

export function ahxSourceOf(songFile: TrackerSongFile): Uint8Array | null {
  return attached.get(toRaw(songFile))?.bytes ?? null;
}

/** Everything attached to `songFile`: bytes, header info and any snapshot edits. */
export function ahxSourceRecordOf(songFile: TrackerSongFile): AhxSource | null {
  // The map is keyed by identity, which a reactive wrapper around the same song
  // file does not have, so look up (and attach) by the raw object.
  return attached.get(toRaw(songFile)) ?? null;
}

const copyEdit = (edit: AhxInstrumentEdit): AhxInstrumentEdit => ({ instrument: edit.instrument, bytes: edit.bytes.slice() });

/** The current song's bytes, header info and edits, for `attachAhxSource` to carry across a stretch where another song is current. `null` when none is. */
export function snapshotAhxSource(): AhxSource | null {
  if (!current || !ahxSourceInfo.value) return null;
  return { bytes: current, ...ahxSourceInfo.value, edits: currentAhxInstrumentEdits().map(copyEdit) };
}

/**
 * The song file of the song the editor has now, with what an AHX/HVL song needs
 * that a song file does not carry: its bytes, header info and instrument edits
 * (the Jukebox keeps this while it plays other songs and applies it on the way
 * out). For any other song it is `store.serializeSong()` as it is.
 */
export function snapshotEditorSong(store: { serializeSong(): TrackerSongFile }): TrackerSongFile {
  const songFile = store.serializeSong();
  const source = snapshotAhxSource();
  if (source) attachAhxSource(songFile, source.bytes, source, source.edits);
  return songFile;
}

/** Called when a song is applied: the new song's bytes, or `null` for any other format. */
export function setCurrentAhxSource(
  bytes: Uint8Array | null,
  extra: { format?: AhxSongFormat; version?: number; edits?: readonly AhxInstrumentEdit[] } = {},
): void {
  // The same song applied again (a jukebox replay of a prefetched file) has its
  // slots read afresh from the song file: instruments as parsed, without the
  // edits made since. A worklet that still holds those edits must not go on
  // playing what the display no longer shows, and loaders tell songs apart by
  // the identity of the bytes, so the re-applied song gets a copy: a new song
  // to every one of them.
  //
  // A snapshot's edits are put back the same way (they are the display's too:
  // the slots were serialized with them), and the worklets pick them up at
  // their next load like any recorded edit.
  const restored = extra.edits ?? [];
  const reapplied = bytes !== null && bytes === current && (edits.size > 0 || restored.length > 0);
  if (bytes === current && !reapplied) return;
  current = reapplied ? bytes.slice() : bytes;
  const header = bytes ? ahxSourceInfoOf(bytes) : null;
  ahxSourceInfo.value = header && { format: extra.format ?? header.format, version: extra.version ?? header.version };
  edits.clear();
  for (const edit of restored) edits.set(edit.instrument, edit.bytes.slice());
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
