import { computed, ref } from 'vue';
import {
  useJukeboxStore,
  entryFromDemoSong,
} from 'src/stores/jukebox-store';
import { useDemoManifest, type DemoSong } from 'src/composables/useDemoManifest';
import type { TrackerSongHost } from 'src/composables/useTrackerSongHost';
import type { TrackerSongFile } from 'src/stores/tracker-store';

/**
 * Drives the jukebox playlist: which module plays, what comes next, and the
 * fetching and instrument rebuilding in between.
 *
 * The playlist itself lives in the store; this is the part that needs a loaded
 * tracker to work with, so it takes a song host and does everything through
 * it. Kept out of the page so the page is only layout.
 */
export function useJukeboxPlayer(host: TrackerSongHost) {
  const jukebox = useJukeboxStore();
  const { load: loadDemoManifest, allSongs: allDemoSongs } = useDemoManifest();

  /** A song is being fetched and its instruments rebuilt. */
  const busy = ref(false);

  /**
   * Set once the jukebox is being torn down. Every command checks it, so a
   * song-end handover or a retry that was already in flight cannot load a
   * module on top of whatever replaced it.
   */
  let disposed = false;

  /** Either of the two ways this is not ready for another command yet. */
  const isBusy = computed(() => busy.value || host.isLoadingSong.value);

  /**
   * The next module, fetched and parsed while the current one is still
   * playing.
   *
   * Between songs the tracker has to fetch the file, parse it, and rebuild
   * every instrument. Only the rebuild genuinely has to happen in the gap: the
   * other two touch no tracker state and can run ahead of time. Parsing is
   * 35-75ms of synchronous work for a typical module, comfortably inside the
   * scheduler's half-second lookahead, so it is done while the previous song
   * plays and the switch gets to skip straight to the rebuild.
   */
  let prefetchedSong: { file: string; songFile: TrackerSongFile } | null = null;
  let prefetchingFile: string | null = null;

  /** Run in a quiet moment, so the parse does not land on a busy frame. */
  function whenIdle(run: () => void): void {
    const idle = (
      window as unknown as {
        requestIdleCallback?: (
          cb: () => void,
          opts?: { timeout: number },
        ) => void;
      }
    ).requestIdleCallback;
    if (idle) idle(run, { timeout: 2000 });
    else setTimeout(run, 250);
  }

  /** Warm the entry after the current one, so the switch has nothing to fetch. */
  async function prefetchNext(): Promise<void> {
    const nextIndex = jukebox.indexAfter(1);
    if (nextIndex === null) return;
    const entry = jukebox.entries[nextIndex];
    if (!entry) return;
    // Already warm, or already on its way.
    if (prefetchedSong?.file === entry.file || prefetchingFile === entry.file) {
      return;
    }

    prefetchingFile = entry.file;
    try {
      const response = await fetch(entry.url);
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      const data = await response.arrayBuffer();
      prefetchedSong = {
        file: entry.file,
        songFile: await host.parseSongBuffer(data),
      };
    } catch (error) {
      // A failed warm-up costs nothing: the switch just loads it the slow way.
      console.warn(`[Jukebox] Could not prefetch ${entry.file}`, error);
      if (prefetchedSong?.file === entry.file) prefetchedSong = null;
    } finally {
      if (prefetchingFile === entry.file) prefetchingFile = null;
    }
  }

  /** Files already queued, so the browser can show them as such in add mode. */
  const queuedFiles = computed(
    () => new Set(jukebox.entries.map((entry) => entry.file)),
  );

  /**
   * Load a song from the playlist and start it.
   *
   * A module whose bytes are unreachable or unparseable would otherwise stall
   * the jukebox on a song that never plays, so a failure moves on to the next
   * one -- but only so many times, or a playlist of nothing but broken files
   * would spin through itself forever.
   */
  async function playIndex(index: number, attemptsLeft = 3): Promise<void> {
    if (busy.value || disposed) return;
    jukebox.setCurrentIndex(index);
    const entry = jukebox.current;
    if (!entry) return;

    busy.value = true;
    try {
      // Set before loading: initializePlayback re-applies this to the engine.
      host.playbackStore.setLoopSong(false);

      // Claim the warmed song, if this is the one that was warmed. Cleared
      // either way: it is consumed here, and a stale one would be wrong for
      // whatever entry is asked for next.
      const warmed =
        prefetchedSong?.file === entry.file ? prefetchedSong.songFile : null;
      prefetchedSong = null;

      if (warmed) {
        host.isLoadingSong.value = true;
        try {
          await host.applySongFile(warmed);
        } finally {
          host.isLoadingSong.value = false;
        }
      } else {
        await host.loadSongFromUrl(entry.url);
      }

      // A playlist entry always starts at the top of the song.
      await host.play('song', 0);

      // With this song under way, start warming the one after it.
      whenIdle(() => void prefetchNext());
    } catch (error) {
      console.warn(`[Jukebox] Skipping ${entry.file}`, error);
      if (attemptsLeft <= 1) {
        stop();
        return;
      }
      const next = jukebox.indexAfter(1);
      if (next === null) {
        stop();
        return;
      }
      busy.value = false;
      await playIndex(next, attemptsLeft - 1);
      return;
    } finally {
      busy.value = false;
    }
  }

  /** Move `step` places through the playlist and play what is there. */
  async function step(delta: number): Promise<void> {
    if (disposed) return;
    const next = jukebox.indexAfter(delta);
    if (next === null) {
      // The end of a playlist that does not repeat.
      stop();
      return;
    }
    await playIndex(next);
  }

  /** Queue every published demo, in random order. */
  async function fillFromManifest(pinnedFile?: string): Promise<void> {
    await loadDemoManifest();
    jukebox.setEntries(allDemoSongs().map(entryFromDemoSong), true, pinnedFile);
  }

  /** Fill the playlist if it is empty, then play from where it stands. */
  async function start(): Promise<void> {
    if (disposed) return;
    jukebox.setActive(true);
    if (!jukebox.hasEntries) await fillFromManifest();
    await playIndex(Math.max(0, jukebox.currentIndex));
  }

  /**
   * Leave jukebox mode. Playback is left as it is -- the song that is playing
   * keeps playing -- but it goes back to looping on its own rather than
   * handing over to the next entry.
   */
  function stop(): void {
    if (!jukebox.active) return;
    jukebox.setActive(false);
    host.playbackStore.setLoopSong(true);
    // A parsed module is a big object; nothing is going to ask for it now.
    prefetchedSong = null;
  }

  /** The transport's play/pause button: resume or pause whatever is queued. */
  function togglePlayback(): void {
    if (disposed) return;
    if (host.playbackStore.isPlaying) {
      host.playbackStore.pause();
      return;
    }
    if (host.playbackStore.isPaused) {
      void host.play('song', host.playbackStore.playbackRow);
      return;
    }
    void playIndex(Math.max(0, jukebox.currentIndex));
  }

  /**
   * Reorder the queue, then warm whatever is next now.
   *
   * A song already warmed for the old order is not thrown away here -- if it
   * happens to still be next it gets used, and if not it is dropped when the
   * switch finds it does not match.
   */
  function shuffle(): void {
    jukebox.reshuffle();
    whenIdle(() => void prefetchNext());
  }

  function remove(index: number): void {
    const removedPlaying = jukebox.removeAt(index);
    if (!removedPlaying) {
      // What comes next may have changed even though this song plays on.
      whenIdle(() => void prefetchNext());
      return;
    }
    // The song that was playing is no longer in the playlist. Stop it and pick
    // up whatever slid into its place.
    if (!jukebox.hasEntries) {
      host.stopPlayback();
      return;
    }
    if (jukebox.active) void playIndex(jukebox.currentIndex);
  }

  async function refill(): Promise<void> {
    // Pin whatever is playing so refilling the queue does not interrupt it.
    await fillFromManifest(
      host.playbackStore.isPlaying ? jukebox.current?.file : undefined,
    );
    whenIdle(() => void prefetchNext());
  }

  function clear(): void {
    jukebox.clear();
    host.stopPlayback();
  }

  /** Queue one song picked in the demo browser. */
  function addSong(song: DemoSong): number {
    const index = jukebox.add(song);
    whenIdle(() => void prefetchNext());
    return index;
  }

  /**
   * Shut the jukebox down: no further loads, and nothing warmed kept around.
   *
   * Resolves once any load already under way has finished, so a caller that
   * is about to put a different song in place is not racing this one.
   */
  async function dispose(): Promise<void> {
    disposed = true;
    prefetchedSong = null;
    prefetchingFile = null;
    // A load in flight owns the tracker until it is done. Bounded, so a load
    // that never settles cannot hold the page open for ever.
    const deadline = Date.now() + 10_000;
    while (busy.value && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  return {
    jukebox,
    busy,
    isBusy,
    queuedFiles,
    playIndex,
    step,
    start,
    stop,
    togglePlayback,
    shuffle,
    remove,
    refill,
    clear,
    addSong,
    fillFromManifest,
    prefetchNext,
    dispose,
  };
}
