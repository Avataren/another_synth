import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  demoSongUrl,
  type DemoSong,
} from '../composables/useDemoManifest';

/**
 * One song queued for playback.
 *
 * A copy of the manifest entry rather than a reference into it, so a playlist
 * survives a manifest reload -- and so an entry the user removed does not come
 * back when the manifest is re-read.
 */
export interface JukeboxEntry {
  /** Path relative to the demo base, and the playlist's identity for an entry. */
  file: string;
  /** URL the module is fetched from. */
  url: string;
  title: string;
  format: string;
  channels: number;
  bytes: number;
}

/**
 * Fisher-Yates, returning a new array.
 *
 * `sort(() => Math.random() - 0.5)` is the obvious-looking version and it is
 * biased: the comparator is inconsistent, so the result depends on the sort's
 * internals and leaves elements near where they started.
 */
function shuffled<T>(items: readonly T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function entryFromDemoSong(song: DemoSong): JukeboxEntry {
  return {
    file: song.file,
    url: demoSongUrl(song),
    title: song.title,
    format: song.format,
    channels: song.channels,
    bytes: song.bytes,
  };
}

/**
 * The jukebox playlist: which demo modules to play, in what order, and where
 * in that order playback currently is.
 *
 * Only the list lives here. Actually loading and starting a module needs the
 * tracker page's file-loading and instrument-rebuilding machinery, so the page
 * drives playback and reports back with `setCurrentIndex`.
 */
export const useJukeboxStore = defineStore('jukebox', () => {
  /** Whether the jukebox is running: on song end, advance to the next entry. */
  const active = ref(false);

  const entries = ref<JukeboxEntry[]>([]);

  /** Index into `entries`, or -1 when nothing is playing. */
  const currentIndex = ref(-1);

  /** Whether the playlist restarts after its last entry. */
  const repeat = ref(true);

  const current = computed<JukeboxEntry | null>(
    () => entries.value[currentIndex.value] ?? null,
  );

  const hasEntries = computed(() => entries.value.length > 0);

  /**
   * Replace the playlist, optionally in random order.
   *
   * `pinnedFile` names a song to place first and leave current -- the song
   * playing right now, so that rebuilding or reshuffling the queue around it
   * does not interrupt it. Without one the list simply starts from the top.
   */
  function setEntries(
    next: readonly JukeboxEntry[],
    shuffle = false,
    pinnedFile?: string,
  ): void {
    const pinned = pinnedFile
      ? next.find((entry) => entry.file === pinnedFile)
      : undefined;
    const rest = pinned ? next.filter((entry) => entry !== pinned) : next;
    const ordered = shuffle ? shuffled(rest) : rest.slice();
    if (pinned) ordered.unshift(pinned);
    entries.value = ordered;
    currentIndex.value = ordered.length > 0 ? 0 : -1;
  }

  /**
   * Reorder the existing playlist, keeping the entry that is playing at the
   * front so the reshuffle does not interrupt it.
   */
  function reshuffle(): void {
    setEntries(entries.value, true, current.value?.file);
  }

  /**
   * Index of the entry `step` places away, or null when that runs off the end
   * of a non-repeating playlist.
   */
  function indexAfter(step: number): number | null {
    const count = entries.value.length;
    if (count === 0) return null;
    // From "nothing playing", forward means the first entry and back the last.
    const from = currentIndex.value < 0 ? (step >= 0 ? -1 : 0) : currentIndex.value;
    const next = from + step;
    if (next >= 0 && next < count) return next;
    if (!repeat.value) return null;
    return ((next % count) + count) % count;
  }

  function setCurrentIndex(index: number): void {
    const count = entries.value.length;
    currentIndex.value =
      count === 0 ? -1 : Math.max(0, Math.min(index, count - 1));
  }

  /**
   * Append a song unless it is already queued. Returns the index it sits at,
   * whether it was just added or was already there.
   */
  function add(song: DemoSong): number {
    const existing = entries.value.findIndex((e) => e.file === song.file);
    if (existing >= 0) return existing;
    entries.value = [...entries.value, entryFromDemoSong(song)];
    if (currentIndex.value < 0) currentIndex.value = 0;
    return entries.value.length - 1;
  }

  /**
   * Remove an entry.
   *
   * Removing something *before* the current entry shifts it down a slot, so
   * the index has to move with it or playback would appear to jump. Removing
   * the current entry itself leaves the index pointing at whatever slid into
   * its place -- the next song -- which is what the caller wants when it goes
   * on to start playing again.
   *
   * Returns true when the entry removed was the one playing.
   */
  function removeAt(index: number): boolean {
    if (index < 0 || index >= entries.value.length) return false;
    const wasCurrent = index === currentIndex.value;
    entries.value = entries.value.filter((_, i) => i !== index);
    if (entries.value.length === 0) {
      currentIndex.value = -1;
    } else if (index < currentIndex.value) {
      currentIndex.value -= 1;
    } else if (currentIndex.value >= entries.value.length) {
      // The list is shorter than the index now: wrap to the top.
      currentIndex.value = repeat.value ? 0 : entries.value.length - 1;
    }
    return wasCurrent;
  }

  function clear(): void {
    entries.value = [];
    currentIndex.value = -1;
  }

  function setActive(value: boolean): void {
    active.value = value;
  }

  function setRepeat(value: boolean): void {
    repeat.value = value;
  }

  return {
    active,
    entries,
    currentIndex,
    repeat,
    current,
    hasEntries,
    setEntries,
    reshuffle,
    indexAfter,
    setCurrentIndex,
    add,
    removeAt,
    clear,
    setActive,
    setRepeat,
  };
});
