import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { useJukeboxPlayer } from 'src/composables/useJukeboxPlayer';
import { useJukeboxStore, type JukeboxEntry } from 'src/stores/jukebox-store';
import type { TrackerSongHost } from 'src/composables/useTrackerSongHost';

/**
 * What happens when the jukebox runs out of things to play.
 *
 * The end of a song is not a quiet moment. The engine stops scheduling but
 * deliberately silences nothing -- a release tail has to be allowed to
 * finish -- so the last rows' voices are still sounding, and what normally
 * cuts them is the *next* entry's `play()`. When there is no next entry,
 * either because the playlist ran out or because loading kept failing, that
 * cut never happens and a looped sampler voice drones for the life of the
 * page. So every path that gives up has to stop the transport itself.
 */

function entry(file: string): JukeboxEntry {
  return {
    file,
    url: `/demos/${file}`,
    title: file,
    format: 'MOD',
    channels: 4,
    bytes: 1024,
  };
}

function makeHost(overrides: Partial<Record<string, unknown>> = {}) {
  const host = {
    isLoadingSong: ref(false),
    playbackStore: {
      setLoopSong: vi.fn(),
      isPlaying: false,
      isPaused: false,
    },
    stopPlayback: vi.fn(),
    play: vi.fn(async () => {}),
    loadSongFromUrl: vi.fn(async () => {}),
    applySongFile: vi.fn(async () => {}),
    parseSongBuffer: vi.fn(async () => ({})),
    ...overrides,
  };
  return host as unknown as TrackerSongHost & {
    stopPlayback: ReturnType<typeof vi.fn>;
    play: ReturnType<typeof vi.fn>;
    applySongFile: ReturnType<typeof vi.fn>;
  };
}

/** A `fetch` that fails the first `failures` calls the way being offline does. */
function offlineThenOk(failures: number) {
  let calls = 0;
  return vi.fn(async () => {
    calls += 1;
    if (calls <= failures) throw new TypeError('Failed to fetch');
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      arrayBuffer: async () => new ArrayBuffer(8),
    } as unknown as Response;
  });
}

/** A `fetch` that answers with one HTTP status, forever. */
function respondWith(status: number) {
  return vi.fn(async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      arrayBuffer: async () => new ArrayBuffer(8),
    }) as unknown as Response,
  );
}

describe('the jukebox giving up', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('stops the transport when every load in a row fails', async () => {
    vi.stubGlobal('fetch', respondWith(404));
    const host = makeHost();
    const player = useJukeboxPlayer(host);
    const jukebox = useJukeboxStore();

    jukebox.setEntries([entry('a.mod'), entry('b.mod'), entry('c.mod')]);
    jukebox.setActive(true);

    await player.step(1);

    expect(jukebox.active).toBe(false);
    expect(host.stopPlayback).toHaveBeenCalled();
  });

  it('stops the transport at the end of a playlist that does not repeat', async () => {
    const host = makeHost();
    const player = useJukeboxPlayer(host);
    const jukebox = useJukeboxStore();

    jukebox.setEntries([entry('a.mod')]);
    jukebox.setActive(true);
    jukebox.setRepeat(false);
    jukebox.setCurrentIndex(0);

    await player.step(1);

    expect(jukebox.active).toBe(false);
    expect(host.stopPlayback).toHaveBeenCalled();
  });

  it('leaves the song playing when the user simply leaves jukebox mode', () => {
    const host = makeHost();
    const player = useJukeboxPlayer(host);
    const jukebox = useJukeboxStore();

    jukebox.setEntries([entry('a.mod')]);
    jukebox.setActive(true);

    player.stop();

    expect(jukebox.active).toBe(false);
    expect(host.stopPlayback).not.toHaveBeenCalled();
  });
});

/**
 * A connection that comes and goes is not a broken playlist.
 *
 * A phone loses its signal between two songs all the time. Treating that the
 * way a corrupt module is treated -- skip, skip, skip, give up -- switches the
 * jukebox off over a hiccup that was gone a second later, so a failure below
 * HTTP waits on the entry it was already on instead.
 */
describe('a transient fetch failure', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('waits and retries the same entry instead of ending the session', async () => {
    vi.useFakeTimers();
    const fetchMock = offlineThenOk(2);
    vi.stubGlobal('fetch', fetchMock);

    const host = makeHost();
    const player = useJukeboxPlayer(host);
    const jukebox = useJukeboxStore();

    jukebox.setEntries([entry('a.mod'), entry('b.mod')]);
    jukebox.setActive(true);
    jukebox.setCurrentIndex(0);

    await player.playIndex(0);
    // Offline: nothing played, the ringing voices were cut, and the jukebox
    // is still on -- still sitting on the entry it was asked for.
    expect(host.play).not.toHaveBeenCalled();
    expect(host.stopPlayback).toHaveBeenCalled();
    expect(jukebox.active).toBe(true);
    expect(jukebox.currentIndex).toBe(0);

    // Two backoffs later the fetch succeeds and that same entry plays.
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(jukebox.currentIndex).toBe(0);
    expect(host.play).toHaveBeenCalledWith('song', 0);
    expect(jukebox.active).toBe(true);
  });

  it('treats a 5xx as transient and a 404 as a broken file', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', respondWith(503));

    const host = makeHost();
    const player = useJukeboxPlayer(host);
    const jukebox = useJukeboxStore();

    jukebox.setEntries([entry('a.mod'), entry('b.mod'), entry('c.mod')]);
    jukebox.setActive(true);

    await player.playIndex(0);
    await vi.advanceTimersByTimeAsync(1000);

    // Still on the same entry, still running: a 503 is the server saying
    // "not now", not "never".
    expect(jukebox.currentIndex).toBe(0);
    expect(jukebox.active).toBe(true);

    vi.stubGlobal('fetch', respondWith(404));
    player.stop();
    jukebox.setActive(true);
    await player.playIndex(0);

    // A 404 is a file that is not there: skipped, budget spent, session over.
    expect(jukebox.active).toBe(false);
    expect(host.stopPlayback).toHaveBeenCalled();
  });

  it('lets a user command take over from a pending retry', async () => {
    vi.useFakeTimers();
    const fetchMock = offlineThenOk(1);
    vi.stubGlobal('fetch', fetchMock);

    const host = makeHost();
    const player = useJukeboxPlayer(host);
    const jukebox = useJukeboxStore();

    jukebox.setEntries([entry('a.mod'), entry('b.mod')]);
    jukebox.setActive(true);

    await player.playIndex(0);
    expect(jukebox.currentIndex).toBe(0);

    // Skipping forward while the backoff is ticking wins, and the armed
    // retry does not later drag playback back to the entry it was on.
    await player.step(1);
    expect(jukebox.currentIndex).toBe(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(jukebox.currentIndex).toBe(1);
  });
});
