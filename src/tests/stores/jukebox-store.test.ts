import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useJukeboxStore } from '../../stores/jukebox-store';
import { useTrackerPlaybackStore } from '../../stores/tracker-playback-store';
import type { DemoSong } from '../../composables/useDemoManifest';

function song(file: string): DemoSong {
  return {
    file,
    title: file.replace(/\.mod$/, ''),
    format: 'MOD',
    channels: 4,
    bytes: 1024,
  };
}

function fill(store: ReturnType<typeof useJukeboxStore>, count: number) {
  store.setEntries(
    Array.from({ length: count }, (_, i) => song(`amiga/${i}.mod`)).map(
      (s) => ({
        file: s.file,
        url: `demos/${s.file}`,
        title: s.title,
        format: s.format,
        channels: s.channels,
        bytes: s.bytes,
      }),
    ),
  );
}

describe('jukebox playlist', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts at the first entry and reports it as current', () => {
    const store = useJukeboxStore();
    expect(store.currentIndex).toBe(-1);
    expect(store.current).toBeNull();

    fill(store, 3);
    expect(store.currentIndex).toBe(0);
    expect(store.current?.file).toBe('amiga/0.mod');
    expect(store.hasEntries).toBe(true);
  });

  it('keeps every entry when shuffling, and loses none to duplication', () => {
    const store = useJukeboxStore();
    const files = Array.from({ length: 40 }, (_, i) => `amiga/${i}.mod`);
    store.setEntries(
      files.map((file) => ({
        file,
        url: `demos/${file}`,
        title: file,
        format: 'MOD',
        channels: 4,
        bytes: 1,
      })),
      true,
    );

    expect(store.entries).toHaveLength(files.length);
    expect(new Set(store.entries.map((e) => e.file))).toEqual(new Set(files));
  });

  it('keeps the playing entry at the front across a reshuffle', () => {
    const store = useJukeboxStore();
    fill(store, 10);
    store.setCurrentIndex(6);
    const playing = store.current;

    store.reshuffle();

    expect(store.currentIndex).toBe(0);
    expect(store.current).toBe(playing);
    expect(store.entries).toHaveLength(10);
    expect(new Set(store.entries.map((e) => e.file)).size).toBe(10);
  });

  it('wraps at both ends of a repeating playlist', () => {
    const store = useJukeboxStore();
    fill(store, 3);

    expect(store.indexAfter(1)).toBe(1);
    store.setCurrentIndex(2);
    expect(store.indexAfter(1)).toBe(0);
    expect(store.indexAfter(-1)).toBe(1);
    store.setCurrentIndex(0);
    expect(store.indexAfter(-1)).toBe(2);
  });

  it('stops rather than wrapping when repeat is off', () => {
    const store = useJukeboxStore();
    fill(store, 3);
    store.setRepeat(false);

    store.setCurrentIndex(2);
    expect(store.indexAfter(1)).toBeNull();
    store.setCurrentIndex(0);
    expect(store.indexAfter(-1)).toBeNull();
    expect(store.indexAfter(1)).toBe(1);
  });

  it('has nowhere to go in an empty playlist', () => {
    const store = useJukeboxStore();
    expect(store.indexAfter(1)).toBeNull();
    expect(store.indexAfter(-1)).toBeNull();
  });

  it('adds a song once, however many times it is picked', () => {
    const store = useJukeboxStore();
    fill(store, 2);

    const added = store.add(song('amiga/new.mod'));
    expect(added).toBe(2);
    expect(store.entries).toHaveLength(3);

    // Picking it again just points at the copy already queued.
    expect(store.add(song('amiga/new.mod'))).toBe(2);
    expect(store.entries).toHaveLength(3);
  });

  it('keeps pointing at the playing entry when an earlier one is removed', () => {
    const store = useJukeboxStore();
    fill(store, 5);
    store.setCurrentIndex(3);
    const playing = store.current;

    const removedCurrent = store.removeAt(1);

    expect(removedCurrent).toBe(false);
    expect(store.currentIndex).toBe(2);
    expect(store.current).toBe(playing);
  });

  it('leaves the index on the following song when the playing one is removed', () => {
    const store = useJukeboxStore();
    fill(store, 4);
    store.setCurrentIndex(1);

    const removedCurrent = store.removeAt(1);

    expect(removedCurrent).toBe(true);
    expect(store.currentIndex).toBe(1);
    expect(store.current?.file).toBe('amiga/2.mod');
  });

  it('wraps to the top when the last entry is removed while playing', () => {
    const store = useJukeboxStore();
    fill(store, 3);
    store.setCurrentIndex(2);

    expect(store.removeAt(2)).toBe(true);
    expect(store.currentIndex).toBe(0);
    expect(store.current?.file).toBe('amiga/0.mod');
  });

  it('has no current entry once the playlist is emptied', () => {
    const store = useJukeboxStore();
    fill(store, 1);
    expect(store.removeAt(0)).toBe(true);
    expect(store.currentIndex).toBe(-1);
    expect(store.current).toBeNull();
    expect(store.hasEntries).toBe(false);
  });

  it('ignores a removal outside the playlist', () => {
    const store = useJukeboxStore();
    fill(store, 2);
    expect(store.removeAt(5)).toBe(false);
    expect(store.removeAt(-1)).toBe(false);
    expect(store.entries).toHaveLength(2);
  });

  it('advances off a song that ends by looping back to its start', () => {
    // The engine-side half lives in tracker-song-end.test.ts: a module whose
    // last pattern carries a Bxx back to an earlier order position ends a
    // non-looping song rather than repeating from the jump, so the engine's
    // songEnd event fires. This is the store half of the same handover -- the
    // listener here is the shape of what JukeboxPage wires with
    // playbackStore.onSongEnd -- which must move the playlist on when it
    // arrives.
    setActivePinia(createPinia());
    const store = useJukeboxStore();
    fill(store, 2);
    store.setActive(true);
    store.setCurrentIndex(0);

    const onSongEnd = () => {
      if (!store.active) return;
      const next = store.indexAfter(1);
      if (next !== null) store.setCurrentIndex(next);
    };
    const playbackStore = useTrackerPlaybackStore();
    const offSongEnd = playbackStore.onSongEnd(onSongEnd);

    // What a songEnd from the engine triggers: the playlist moves on.
    playbackStore.emitSongEndForTest();
    expect(store.currentIndex).toBe(1);
    expect(store.current?.file).toBe('amiga/1.mod');

    // The last song of a non-repeating playlist has nowhere to go.
    store.setRepeat(false);
    playbackStore.emitSongEndForTest();
    expect(store.currentIndex).toBe(1);
    expect(store.indexAfter(1)).toBeNull();

    // A jukebox that has been left does not advance at all.
    store.setRepeat(true);
    store.setActive(false);
    playbackStore.emitSongEndForTest();
    expect(store.currentIndex).toBe(1);

    offSongEnd();
  });
});
