// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia, storeToRefs } from 'pinia';

/**
 * The playback store's routing between `PlaybackEngine` (MOD/XM/S3M/native)
 * and the AHX worklet, driven the way production drives it:
 *
 *  - an AHX song is opened through the real `useTrackerFileIO` (parse, import,
 *    `applySongFile`, `initializePlayback`), so the tracker store and the
 *    source bytes are populated by the real code;
 *  - the `Song` the store plays comes from the real `useTrackerSongBuilder`,
 *    off the real tracker store, not a hand-built literal;
 *  - `AhxTransport` is real; only the worklet-backed client under it
 *    (`createAhxPlayer`) is replaced, and `PlaybackEngine` is replaced by a
 *    fake that emits `state` events the way the real one does, so an engine
 *    event arriving after an AHX song is visible.
 */

const h = vi.hoisted(() => ({
  clients: [] as Array<{
    calls: string[];
    loaded: Uint8Array[];
    stopAtEnd: boolean[];
    disposed: boolean;
    emitPosition: (p: { position: number; row: number; tempo: number; ticks: number }) => void;
    emitEnd: () => void;
  }>,
  /** When set, `loadSong` waits on it instead of resolving at once. */
  gate: null as null | Promise<void>,
  engines: [] as Array<{
    calls: string[];
    emit: (event: string, payload?: unknown) => void;
  }>,
  audioState: { value: 'running' as string },
  bankCalls: [] as string[],
  postFxLoads: [] as string[],
}));

vi.mock('src/audio/tracker/ahx-player', () => ({
  createAhxPlayer: async (audioContext: unknown) => {
    const positionL = new Set<(p: never) => void>();
    const endL = new Set<() => void>();
    const client = {
      audioContext,
      output: { connect: () => {} },
      calls: [] as string[],
      loaded: [] as Uint8Array[],
      stopAtEnd: [] as boolean[],
      disposed: false,
      async loadSong(bytes: Uint8Array) {
        client.calls.push('load');
        client.loaded.push(bytes);
        if (h.gate) await h.gate;
        return {
          name: 'x',
          positionCount: 1,
          trackLength: 64,
          channels: 4,
          droppedChannels: 0,
          sampleRate: 44100,
        };
      },
      play: () => client.calls.push('play'),
      pause: () => client.calls.push('pause'),
      restart: (n: number) => client.calls.push(`restart:${n}`),
      setStopAtEnd: (enabled: boolean) => client.stopAtEnd.push(enabled),
      dispose: () => {
        client.disposed = true;
        client.calls.push('dispose');
      },
      onPosition: (l: (p: never) => void) => {
        positionL.add(l);
        return () => positionL.delete(l);
      },
      onSongEnd: (l: () => void) => {
        endL.add(l);
        return () => endL.delete(l);
      },
      emitPosition: (p: never) => positionL.forEach((l) => l(p)),
      emitEnd: () => endL.forEach((l) => l()),
    };
    h.clients.push(client as never);
    return client;
  },
}));

vi.mock('@another-synth/tracker-playback', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  class FakeEngine {
    calls: string[] = [];
    private listeners = new Map<string, Set<(payload: never) => void>>();
    constructor() {
      h.engines.push(this as never);
    }
    on(event: string, listener: (payload: never) => void) {
      const set = this.listeners.get(event) ?? new Set();
      set.add(listener);
      this.listeners.set(event, set);
      return () => set.delete(listener);
    }
    emit(event: string, payload?: unknown) {
      this.listeners.get(event)?.forEach((l) => l(payload as never));
    }
    setLoopCurrentPattern() {}
    setLoopSong() {}
    loadSong() {
      this.calls.push('loadSong');
    }
    async prepareInstruments() {}
    setBpm() {}
    seek() {
      this.calls.push('seek');
    }
    async play() {
      this.calls.push('play');
      this.emit('state', 'playing');
    }
    pause() {
      this.calls.push('pause');
      this.emit('state', 'paused');
    }
    stop() {
      this.calls.push('stop');
      this.emit('state', 'stopped');
    }
  }
  return { ...actual, PlaybackEngine: FakeEngine };
});

vi.mock('src/stores/tracker-audio-store', () => {
  // One context and bank for the whole run: the transport compares the
  // client's context to the bank's, and a fresh object each time would look
  // like a context change.
  const audioContext = {
    get state() {
      return h.audioState.value;
    },
    // A suspended context never resumes without a gesture.
    resume: () => (h.audioState.value === 'running' ? Promise.resolve() : new Promise(() => {})),
  };
  const songBank = {
    audioContext,
    output: {},
    setModuleFormat: () => {},
    resetForNewSong: () => {},
    cancelAllScheduled: () => {},
    allNotesOff: () => {},
    ensureAudioContextRunning: async () => h.audioState.value === 'running',
    prepareInstrument: async () => undefined,
  };
  return {
    useTrackerAudioStore: () => ({
      songBank,
      setPlaybackState: (playing: boolean) => {
        h.bankCalls.push(`playing:${playing}`);
      },
    }),
  };
});

vi.mock('src/stores/post-fx-store', () => ({
  usePostFxStore: () => ({
    onPlaybackStopped: () => {},
    applyEngineEvent: () => {},
    onSongLoad: (format: string) => h.postFxLoads.push(format),
  }),
}));

import { computed, ref } from 'vue';
import { useTrackerPlaybackStore } from 'src/stores/tracker-playback-store';
import { useTrackerStore } from 'src/stores/tracker-store';
import { useTrackerAudioStore } from 'src/stores/tracker-audio-store';
import { useTrackerFileIO } from 'src/composables/useTrackerFileIO';
import type { TrackerSongBank } from 'src/audio/tracker/song-bank';
import { useTrackerSongBuilder } from 'src/composables/useTrackerSongBuilder';
import { formatInstrumentId, normalizeInstrumentId } from 'src/audio/tracker/instrument-ids';
import { ahxSourceOf, currentAhxSource, setCurrentAhxSource } from 'src/audio/tracker/ahx-source';
import type { Song } from '@another-synth/tracker-playback';

const karmaBytes = fs.readFileSync(path.resolve(__dirname, '../../../public/demos/ahx/karma.ahx'));

/** The wiring `useTrackerSongHost` gives the file IO, over the real stores. */
function setupHost() {
  const trackerStore = useTrackerStore();
  trackerStore.initializeIfNeeded();
  const playbackStore = useTrackerPlaybackStore();
  const songBank = useTrackerAudioStore().songBank as unknown as TrackerSongBank;
  const refs = storeToRefs(trackerStore);
  const builder = useTrackerSongBuilder({
    currentSong: refs.currentSong,
    initialSpeed: refs.initialSpeed,
    linearFrequency: refs.linearFrequency,
    amigaLimits: refs.amigaLimits,
    fastVolumeSlides: refs.fastVolumeSlides,
    initialGlobalVolume: refs.initialGlobalVolume,
    vblankTiming: refs.vblankTiming,
    moduleFormat: refs.moduleFormat,
    patterns: refs.patterns,
    sequence: refs.sequence,
    currentPatternId: refs.currentPatternId,
    currentPattern: computed(() => trackerStore.currentPattern),
    defaultPatternRows: refs.defaultPatternRows,
    instrumentSlots: refs.instrumentSlots,
    songPatches: refs.songPatches,
    songBank,
    normalizeInstrumentId,
    formatInstrumentId,
  });
  /** `buildPlaybackSong`, off whatever the tracker store holds *now*. */
  const buildSong = (mode: 'song' | 'pattern' = 'song'): Song =>
    builder.buildPlaybackSong(mode) as Song;
  const fileIO = useTrackerFileIO({
    trackerStore,
    songBank,
    currentSong: refs.currentSong,
    playbackMode: ref<'pattern' | 'song'>('song'),
    isLoadingSong: ref(false),
    ensureActiveInstrument: () => {},
    syncSongBankFromSlots: async () => {},
    initializePlayback: async (mode) => playbackStore.loadSong(buildSong(mode), mode),
    stopPlayback: () => playbackStore.stop(),
    resetSequenceIndex: () => playbackStore.setSequenceIndex(0),
  });
  return { trackerStore, playbackStore, fileIO, buildSong };
}

/** Open karma.ahx as the app does: bytes -> parse -> apply -> initialise playback. */
async function openAhx(host: ReturnType<typeof setupHost>) {
  const file = await host.fileIO.parseSongBuffer(
    karmaBytes.buffer.slice(
      karmaBytes.byteOffset,
      karmaBytes.byteOffset + karmaBytes.byteLength,
    ) as ArrayBuffer,
  );
  await host.fileIO.applySongFile(file);
  return file;
}

function modSong(): Song {
  return {
    title: 'M',
    author: 'x',
    bpm: 125,
    moduleFormat: 'protracker',
    patterns: [{ id: 'm1', length: 64, tracks: [] }],
    sequence: ['m1'],
  } as Song;
}

const lastClient = () => h.clients[h.clients.length - 1]!;

beforeEach(() => {
  setActivePinia(createPinia());
  h.clients.length = 0;
  h.engines.length = 0;
  h.bankCalls.length = 0;
  h.postFxLoads.length = 0;
  h.audioState.value = 'running';
  h.gate = null;
  setCurrentAhxSource(null);
  useTrackerPlaybackStore().dispose();
});

describe('AHX song opened through the real load path', () => {
  it('parses to an AHX row model that the builder turns into an ahx Song', async () => {
    const host = setupHost();
    const file = await openAhx(host);
    expect(host.trackerStore.moduleFormat).toBe('ahx');
    expect(host.trackerStore.isReadOnly).toBe(true);
    expect(currentAhxSource()).toBe(ahxSourceOf(file));
    expect(h.postFxLoads).toEqual(['ahx']);
    const song = host.buildSong();
    expect(song.moduleFormat).toBe('ahx');
    expect(song.sequence.length).toBeGreaterThan(1);
  });

  it('goes to the worklet client and never touches PlaybackEngine', async () => {
    const host = setupHost();
    const file = await openAhx(host);
    await host.playbackStore.play(host.buildSong(), 'song', 0, 0);

    expect(h.engines).toHaveLength(0);
    const client = lastClient();
    expect(client.loaded[0]).toBe(ahxSourceOf(file));
    expect(client.calls).toContain('play');
    expect(host.playbackStore.isPlaying).toBe(true);
    expect(host.playbackStore.hasSongLoaded).toBe(true);
    expect(h.bankCalls.at(-1)).toBe('playing:true');
  });

  it('mirrors worklet positions into row, sequence index and current pattern', async () => {
    const host = setupHost();
    await openAhx(host);
    await host.playbackStore.play(host.buildSong(), 'song', 0, 0);
    const seen: Array<[number, string | undefined]> = [];
    host.playbackStore.onPosition((row, id) => seen.push([row, id]));

    lastClient().emitPosition({ position: 3, row: 5, tempo: 6, ticks: 0 });

    const expectedId = host.trackerStore.sequence[3];
    expect(host.playbackStore.currentSequenceIndex).toBe(3);
    expect(host.playbackStore.playbackRow).toBe(5);
    expect(host.trackerStore.currentPatternId).toBe(expectedId);
    expect(seen).toEqual([[5, expectedId]]);
  });

  it('ignores a position report that arrives after stop', async () => {
    const host = setupHost();
    await openAhx(host);
    await host.playbackStore.play(host.buildSong(), 'song', 0, 0);
    host.playbackStore.stop();
    lastClient().emitPosition({ position: 2, row: 9, tempo: 6, ticks: 0 });
    expect(host.playbackStore.playbackRow).toBe(0);
    expect(host.playbackStore.currentSequenceIndex).toBe(0);
    expect(host.playbackStore.isPlaying).toBe(false);
  });

  it('pauses, resumes without rewinding, and stops', async () => {
    const host = setupHost();
    await openAhx(host);
    const store = host.playbackStore;
    await store.play(host.buildSong(), 'song', 0, 0);
    lastClient().emitPosition({ position: 1, row: 7, tempo: 6, ticks: 0 });

    store.pause();
    expect(store.isPaused).toBe(true);
    expect(store.isPlaying).toBe(false);
    expect(lastClient().calls.at(-1)).toBe('pause');

    await store.resume();
    expect(store.isPlaying).toBe(true);
    expect(lastClient().calls.at(-1)).toBe('play');
    expect(store.currentSequenceIndex).toBe(1);

    // The jukebox resumes through play() at the paused row: still a resume.
    store.pause();
    const restartsBefore = lastClient().calls.filter((c) => c.startsWith('restart')).length;
    await store.play(host.buildSong(), 'song', store.playbackRow, store.currentSequenceIndex);
    expect(lastClient().calls.filter((c) => c.startsWith('restart')).length).toBe(restartsBefore);
    expect(store.currentSequenceIndex).toBe(1);

    store.stop();
    expect(store.isPlaying).toBe(false);
    expect(store.isPaused).toBe(false);
    expect(store.playbackRow).toBe(0);
    expect(lastClient().calls.slice(-2)).toEqual(['pause', 'restart:0']);
  });

  it('a fresh play() rewinds to the top', async () => {
    const host = setupHost();
    await openAhx(host);
    const store = host.playbackStore;
    await store.play(host.buildSong(), 'song', 0, 0);
    lastClient().emitPosition({ position: 4, row: 2, tempo: 6, ticks: 0 });
    await store.play(host.buildSong(), 'song', 0, 0);
    expect(store.currentSequenceIndex).toBe(0);
    expect(store.playbackRow).toBe(0);
    expect(lastClient().calls.slice(-3)).toEqual(['pause', 'restart:0', 'play']);
  });

  it('song end: a non-looping song stops and fires the listeners; a looping one does not', async () => {
    const host = setupHost();
    await openAhx(host);
    const store = host.playbackStore;
    const ended = vi.fn();
    store.onSongEnd(ended);

    store.setLoopSong(true);
    await store.play(host.buildSong(), 'song', 0, 0);
    lastClient().emitEnd();
    expect(ended).not.toHaveBeenCalled();
    expect(store.isPlaying).toBe(true);

    store.setLoopSong(false);
    lastClient().emitEnd();
    expect(ended).toHaveBeenCalledOnce();
    expect(store.isPlaying).toBe(false);
    expect(lastClient().calls.slice(-2)).toEqual(['pause', 'restart:0']);
  });

  it('asks the worklet to stop at the end exactly when the song is not looping', async () => {
    const host = setupHost();
    const store = host.playbackStore;
    // The jukebox sets this before it loads.
    store.setLoopSong(false);
    await openAhx(host);
    await store.play(host.buildSong(), 'song', 0, 0);
    // Applied when the client is made (the store's loop flag was already off)...
    expect(lastClient().stopAtEnd).toEqual([true]);
    // ...and re-applied when the flag flips.
    store.setLoopSong(true);
    store.setLoopSong(false);
    expect(lastClient().stopAtEnd).toEqual([true, false, true]);
  });

  it('seek, setBpm and setPatternLength do not reach a PlaybackEngine left from another song', async () => {
    const host = setupHost();
    const store = host.playbackStore;
    await store.play(modSong(), 'song', 0, 0);
    const engine = h.engines[0]!;
    await openAhx(host);
    await store.play(host.buildSong(), 'song', 0, 0);
    engine.calls.length = 0;
    store.seek(4);
    store.setBpm(140);
    store.setPatternLength('m1', 32);
    expect(engine.calls).toEqual([]);
  });

  it('refuses to play (without throwing) when the source bytes are missing', async () => {
    const host = setupHost();
    await openAhx(host);
    setCurrentAhxSource(null); // e.g. a .cmod saved from an AHX song
    await host.playbackStore.play(host.buildSong(), 'song', 0, 0);
    expect(host.playbackStore.isPlaying).toBe(false);
    expect(h.clients.flatMap((c) => c.calls)).not.toContain('play');
  });

  it('does not wait on the worklet while the context is suspended, but play does', async () => {
    const host = setupHost();
    h.audioState.value = 'suspended';
    // The client's load never settles until the context runs.
    h.gate = new Promise(() => {});
    // The deep-link path: applySongFile -> initializePlayback -> loadSong.
    await expect(
      Promise.race([openAhx(host), new Promise((r) => setTimeout(() => r('hung'), 3000))]),
    ).resolves.not.toBe('hung');
    expect(host.playbackStore.hasSongLoaded).toBe(true);
    // Not started: playing needs a running context.
    await host.playbackStore.play(host.buildSong(), 'song', 0, 0);
    expect(host.playbackStore.isPlaying).toBe(false);
  });
});

describe('a load in flight', () => {
  /** Open karma while the worklet's load is held; resolves to the release and the open. */
  async function openHeld(host: ReturnType<typeof setupHost>) {
    let release!: () => void;
    h.gate = new Promise<void>((r) => (release = r));
    const opening = openAhx(host);
    await vi.waitFor(() => expect(h.clients.length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(lastClient().calls).toContain('load'));
    return { release, opening };
  }

  it('a stop() during the worklet load takes the AHX branch, and the load does not mark the song loaded', async () => {
    const host = setupHost();
    const store = host.playbackStore;
    const { release, opening } = await openHeld(host);

    store.stop();
    // Not the engine's branch: no PlaybackEngine was made for a stop.
    expect(h.engines).toHaveLength(0);
    expect(store.isPlaying).toBe(false);

    release();
    await opening;
    expect(store.hasSongLoaded).toBe(false);
  });

  it('a MOD load during the worklet load wins: the engine plays it and the AHX load is dropped', async () => {
    const host = setupHost();
    const store = host.playbackStore;
    const { release, opening } = await openHeld(host);
    const client = lastClient();

    await store.play(modSong(), 'song', 0, 0);
    // The transport was handed back, so the worklet client is gone...
    expect(client.disposed).toBe(true);
    release();
    // ...and the late AHX answer changes nothing.
    await opening.catch(() => undefined);
    store.pause();
    expect(h.engines[0]!.calls.at(-1)).toBe('pause');
    expect(client.calls).not.toContain('play');
    expect(store.isPaused).toBe(true);
  });
});

describe('other formats', () => {
  it('a MOD never creates the AHX client and uses PlaybackEngine as before', async () => {
    const store = useTrackerPlaybackStore();
    await store.play(modSong(), 'song', 0, 0);
    expect(h.clients).toHaveLength(0);
    expect(h.engines).toHaveLength(1);
    expect(h.engines[0]!.calls).toEqual(expect.arrayContaining(['loadSong', 'play']));
    store.pause();
    expect(h.engines[0]!.calls.at(-1)).toBe('pause');
    await store.resume();
    expect(h.engines[0]!.calls.at(-1)).toBe('play');
    store.stop();
    expect(h.engines[0]!.calls.at(-1)).toBe('stop');
    expect(h.clients).toHaveLength(0);
  });

  it('after an AHX song, a MOD hands the transport back: the worklet is freed, the engine plays, and engine state events drive isPlaying', async () => {
    const host = setupHost();
    await openAhx(host);
    const store = host.playbackStore;
    await store.play(host.buildSong(), 'song', 0, 0);
    const client = lastClient();
    expect(store.isPlaying).toBe(true);

    await store.play(modSong(), 'song', 0, 0);
    expect(client.calls).toContain('dispose');
    expect(h.engines[0]!.calls).toContain('play');
    // The engine's own `state` events now own the flags.
    expect(store.isPlaying).toBe(true);
    expect(store.isPaused).toBe(false);

    // And pause/stop drive the engine, not the worklet.
    const before = client.calls.length;
    store.pause();
    expect(store.isPaused).toBe(true);
    expect(store.isPlaying).toBe(false);
    store.stop();
    expect(store.isPaused).toBe(false);
    expect(store.isPlaying).toBe(false);
    expect(client.calls).toHaveLength(before);
  });

  it('MOD then AHX: the engine is stopped and its "stopped" event does not leave the AHX song looking stopped', async () => {
    const host = setupHost();
    const store = host.playbackStore;
    await store.play(modSong(), 'song', 0, 0);
    expect(store.isPlaying).toBe(true);

    await openAhx(host);
    await store.play(host.buildSong(), 'song', 0, 0);
    expect(h.engines[0]!.calls.at(-1)).toBe('stop');
    expect(store.isPlaying).toBe(true);
    expect(store.isPaused).toBe(false);
  });
});

describe('a read-only song', () => {
  it('refuses structural edits and history', async () => {
    const host = setupHost();
    await openAhx(host);
    const t = host.trackerStore;
    const before = JSON.stringify([t.sequence, t.patterns.length, t.patterns[0]?.tracks.length]);

    t.pushHistory();
    expect(t.undoStack).toHaveLength(0);
    expect(t.addTrack()).toBe(false);
    expect(t.removeTrack(0)).toBe(false);
    t.addPatternToSequence(t.sequence[0]!);
    t.removePatternFromSequence(0);
    t.moveSequenceItem(0, 1);
    t.setPatternRows(8);
    t.deletePattern(t.sequence[0]!);
    t.undo();
    t.redo();

    expect(JSON.stringify([t.sequence, t.patterns.length, t.patterns[0]?.tracks.length])).toBe(
      before,
    );
  });

  it('is editable again once a different format is loaded', () => {
    setActivePinia(createPinia());
    const t = useTrackerStore();
    t.initializeIfNeeded();
    expect(t.isReadOnly).toBe(false);
    const rows = t.patterns.length;
    t.createPattern();
    expect(t.patterns.length).toBe(rows + 1);
  });
});
