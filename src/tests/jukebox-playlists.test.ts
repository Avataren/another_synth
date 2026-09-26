import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { useJukeboxPlayer } from 'src/composables/useJukeboxPlayer';
import { useJukeboxStore } from 'src/stores/jukebox-store';
import type { TrackerSongHost } from 'src/composables/useTrackerSongHost';

/**
 * Which songs a jukebox playlist is built from.
 *
 * The standard playlist -- the one the jukebox starts with, and "All songs" --
 * leaves out the experimental collections: a transcribed .sid only
 * approximates the original, and the default rotation should be the songs
 * that sound right. Each collection can still be played as a playlist of its
 * own, the experimental ones included, since asking for it is opting in.
 */

const manifest = {
  collections: [
    {
      id: 'amiga',
      name: 'Amiga / ProTracker',
      songs: [
        { file: 'amiga/a.mod', title: 'a', format: 'MOD', channels: 4, bytes: 1 },
        { file: 'amiga/b.mod', title: 'b', format: 'MOD', channels: 4, bytes: 1 },
      ],
    },
    {
      id: 'ahx',
      name: 'AHX / HivelyTracker',
      songs: [{ file: 'ahx/c.ahx', title: 'c', format: 'AHX', channels: 4, bytes: 1 }],
    },
    {
      id: 'sid',
      name: 'C64 SID',
      songs: [{ file: 'sid/d.sid', title: 'd', format: 'PSID', channels: 3, bytes: 1 }],
    },
  ],
};

function makeHost(isPlaying = false) {
  const host = {
    isLoadingSong: ref(false),
    playbackStore: { setLoopSong: vi.fn(), isPlaying, isPaused: false },
    stopPlayback: vi.fn(),
    play: vi.fn(async () => {}),
    loadSongFromUrl: vi.fn(async () => {}),
    applySongFile: vi.fn(async () => {}),
    parseSongBuffer: vi.fn(async () => ({})),
  };
  return host as unknown as TrackerSongHost & { play: ReturnType<typeof vi.fn> };
}

const files = () => useJukeboxStore().entries.map((e) => e.file).sort();

describe('jukebox playlists', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => (url.endsWith('index.json') ? manifest : {}),
        arrayBuffer: async () => new ArrayBuffer(8),
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts with every song outside the experimental collections', async () => {
    const player = useJukeboxPlayer(makeHost());
    await player.start();
    expect(files()).toEqual(['ahx/c.ahx', 'amiga/a.mod', 'amiga/b.mod']);
  });

  it('builds a playlist of one collection, experimental ones included', async () => {
    const player = useJukeboxPlayer(makeHost());
    await player.refill('amiga');
    expect(files()).toEqual(['amiga/a.mod', 'amiga/b.mod']);
    await player.refill('sid');
    expect(files()).toEqual(['sid/d.sid']);
    await player.refill();
    expect(files()).toEqual(['ahx/c.ahx', 'amiga/a.mod', 'amiga/b.mod']);
  });

  it('lists each collection as a playlist source, marking the experimental', async () => {
    const player = useJukeboxPlayer(makeHost());
    await player.refill();
    expect(
      player.playlistSources.value.map(({ id, format, count, experimental }) => ({
        id,
        format,
        count,
        experimental,
      })),
    ).toEqual([
      { id: 'amiga', format: 'MOD', count: 2, experimental: false },
      { id: 'ahx', format: 'AHX', count: 1, experimental: false },
      { id: 'sid', format: 'PSID', count: 1, experimental: true },
    ]);
  });

  it('keeps the playing song when it belongs to the new playlist', async () => {
    const host = makeHost(true);
    const player = useJukeboxPlayer(host);
    const jukebox = useJukeboxStore();
    await player.refill('amiga');
    jukebox.setActive(true);
    const playing = jukebox.current!.file;
    await player.refill('amiga');
    expect(jukebox.current!.file).toBe(playing);
    expect(host.play).not.toHaveBeenCalled();
  });

  it('starts the new playlist when the playing song is not in it', async () => {
    const host = makeHost(true);
    const player = useJukeboxPlayer(host);
    const jukebox = useJukeboxStore();
    await player.refill('amiga');
    jukebox.setActive(true);
    await player.refill('ahx');
    expect(jukebox.current!.file).toBe('ahx/c.ahx');
    expect(host.play).toHaveBeenCalledWith('song', 0);
  });
});
