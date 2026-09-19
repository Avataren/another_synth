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
    capture: boolean[];
    muteSolo: Array<[number, number]>;
    hifi: boolean[];
    loop: boolean[];
    disposed: boolean;
    emitWaveforms: (w: { channels: number; points: number; data: Int16Array }) => void;
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
    const waveL = new Set<(w: never) => void>();
    const client = {
      audioContext,
      output: { connect: () => {} },
      calls: [] as string[],
      loaded: [] as Uint8Array[],
      stopAtEnd: [] as boolean[],
      capture: [] as boolean[],
      muteSolo: [] as Array<[number, number]>,
      hifi: [] as boolean[],
      loop: [] as boolean[],
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
      seek: (position: number, row: number) => client.calls.push(`seek:${position}:${row}`),
      setLoopPosition: (enabled: boolean) => client.loop.push(enabled),
      setStopAtEnd: (enabled: boolean) => client.stopAtEnd.push(enabled),
      setCapture: (enabled: boolean) => client.capture.push(enabled),
      setMuteSolo: (mute: number, solo: number) => client.muteSolo.push([mute, solo]),
      setHifi: (enabled: boolean) => client.hifi.push(enabled),
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
      onWaveforms: (l: (w: never) => void) => {
        waveL.add(l);
        return () => waveL.delete(l);
      },
      emitWaveforms: (w: never) => waveL.forEach((l) => l(w)),
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
    notesOffForTrack: (track: number) => h.bankCalls.push(`off:${track}`),
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

  it('a fresh play() from the top seeks to the top; it is never a restart', async () => {
    const host = setupHost();
    await openAhx(host);
    const store = host.playbackStore;
    await store.play(host.buildSong(), 'song', 0, 0);
    lastClient().emitPosition({ position: 4, row: 2, tempo: 6, ticks: 0 });
    await store.play(host.buildSong(), 'song', 0, 0);
    expect(store.currentSequenceIndex).toBe(0);
    expect(store.playbackRow).toBe(0);
    expect(lastClient().calls.slice(-2)).toEqual(['seek:0:0', 'play']);
    expect(lastClient().calls.filter((c) => c.startsWith('restart'))).toEqual([]);
  });

  it('play-from-here seeks the engine to that position and row', async () => {
    const host = setupHost();
    await openAhx(host);
    const store = host.playbackStore;
    await store.play(host.buildSong(), 'song', 12, 3);
    expect(lastClient().calls.slice(-2)).toEqual(['seek:3:12', 'play']);
    expect(store.currentSequenceIndex).toBe(3);
    expect(store.playbackRow).toBe(12);
    expect(store.isPlaying).toBe(true);
    expect(lastClient().calls.filter((c) => c.startsWith('restart'))).toEqual([]);

    // With no index given it plays from the selected position.
    store.setSequenceIndex(5);
    await store.play(host.buildSong(), 'song', 0);
    expect(lastClient().calls.slice(-2)).toEqual(['seek:5:0', 'play']);
  });

  it('clamps a position or row that is out of range instead of asking the engine for it', async () => {
    const host = setupHost();
    await openAhx(host);
    const store = host.playbackStore;
    const last = host.trackerStore.sequence.length - 1;
    const rows = host.trackerStore.rowsForPattern(host.trackerStore.sequence[last]);
    await store.play(host.buildSong(), 'song', 9999, 9999);
    expect(lastClient().calls.slice(-2)).toEqual([`seek:${last}:${rows - 1}`, 'play']);
  });

  it('pause then play at the paused place resumes: no seek, no restart', async () => {
    const host = setupHost();
    await openAhx(host);
    const store = host.playbackStore;
    await store.play(host.buildSong(), 'song', 0, 0);
    lastClient().emitPosition({ position: 2, row: 9, tempo: 6, ticks: 0 });
    store.pause();
    const before = lastClient().calls.length;
    await store.play(host.buildSong(), 'song', 9, 2);
    expect(lastClient().calls.slice(before)).toEqual(['play']);
    expect(store.isPlaying).toBe(true);
    expect(store.currentSequenceIndex).toBe(2);
    expect(store.playbackRow).toBe(9);
  });

  it('pause in song mode and "play pattern" at the same place resumes and only flips the loop', async () => {
    const host = setupHost();
    await openAhx(host);
    const store = host.playbackStore;
    await store.play(host.buildSong(), 'song', 0, 0);
    lastClient().emitPosition({ position: 2, row: 9, tempo: 6, ticks: 0 });
    store.pause();
    const before = lastClient().calls.length;
    await store.play(host.buildSong('pattern'), 'pattern', 9, 2);
    expect(lastClient().calls.slice(before)).toEqual(['play']);
    expect(lastClient().loop.at(-1)).toBe(true);
    expect(store.playbackMode).toBe('pattern');
  });

  it('a paused song played from somewhere else seeks there', async () => {
    const host = setupHost();
    await openAhx(host);
    const store = host.playbackStore;
    await store.play(host.buildSong(), 'song', 0, 0);
    lastClient().emitPosition({ position: 2, row: 9, tempo: 6, ticks: 0 });
    store.pause();
    await store.play(host.buildSong(), 'song', 20, 2);
    expect(lastClient().calls.slice(-2)).toEqual(['seek:2:20', 'play']);
    store.pause();
    await store.play(host.buildSong(), 'song', 20, 4);
    expect(lastClient().calls.slice(-2)).toEqual(['seek:4:20', 'play']);
  });

  it('another position picked while paused is a seek, even at the paused row number', async () => {
    const host = setupHost();
    await openAhx(host);
    const store = host.playbackStore;
    await store.play(host.buildSong(), 'song', 0, 0);
    lastClient().emitPosition({ position: 1, row: 50, tempo: 6, ticks: 0 });
    store.pause();
    // The user picks position 5 in the sequence list: the selection moves, the
    // engine does not, and row 50 is where the cursor already was.
    store.setSequenceIndex(5);
    expect(store.currentSequenceIndex).toBe(5);
    await store.play(host.buildSong(), 'song', 50, 5);
    expect(lastClient().calls.slice(-2)).toEqual(['seek:5:50', 'play']);
    // ...and picking the paused position again is the resume it always was.
    store.pause();
    lastClient().emitPosition({ position: 5, row: 50, tempo: 6, ticks: 0 });
    store.setSequenceIndex(2);
    store.setSequenceIndex(5);
    const before = lastClient().calls.length;
    await store.play(host.buildSong(), 'song', 50, 5);
    expect(lastClient().calls.slice(before)).toEqual(['play']);
  });

  it('a different song is never a resume, even at the paused row', async () => {
    const host = setupHost();
    await openAhx(host);
    const store = host.playbackStore;
    await store.play(host.buildSong(), 'song', 0, 0);
    lastClient().emitPosition({ position: 0, row: 0, tempo: 6, ticks: 0 });
    store.pause();
    // Same bytes, but not the ones the worklet holds.
    setCurrentAhxSource(new Uint8Array(karmaBytes));
    await store.play(host.buildSong(), 'song', 0, 0);
    expect(lastClient().calls.filter((c) => c === 'load')).toHaveLength(2);
    expect(lastClient().calls.slice(-2)).toEqual(['seek:0:0', 'play']);
  });

  it('play pattern loops the position on the engine; play song does not; the flag is set before the seek', async () => {
    const host = setupHost();
    await openAhx(host);
    const store = host.playbackStore;
    await store.play(host.buildSong('pattern'), 'pattern', 4, 1);
    expect(lastClient().loop).toEqual([true]);
    expect(store.playbackMode).toBe('pattern');
    await store.play(host.buildSong(), 'song', 4, 1);
    expect(lastClient().loop).toEqual([true, false]);
    expect(store.playbackMode).toBe('song');
    // A pattern loop is not a song end and never reaches the jukebox handover.
    expect(lastClient().calls.filter((c) => c.startsWith('restart'))).toEqual([]);
  });

  it('a client made later is told to loop (handed back to the sampler and re-opened)', async () => {
    const host = setupHost();
    await openAhx(host);
    const store = host.playbackStore;
    await store.play(host.buildSong('pattern'), 'pattern', 0, 0);
    await store.play(modSong(), 'song', 0, 0);
    await store.play(host.buildSong('pattern'), 'pattern', 0, 0);
    expect(lastClient().loop.at(-1)).toBe(true);
  });

  it('seek(row) moves the engine within the current position and keeps playing', async () => {
    const host = setupHost();
    await openAhx(host);
    const store = host.playbackStore;
    await store.play(host.buildSong(), 'song', 0, 2);
    const before = lastClient().calls.length;
    store.seek(30);
    expect(lastClient().calls.slice(before)).toEqual(['seek:2:30']);
    expect(store.playbackRow).toBe(30);
    expect(store.isPlaying).toBe(true);
    store.seek(9999);
    const rows = host.trackerStore.rowsForPattern(host.trackerStore.sequence[2]);
    expect(lastClient().calls.at(-1)).toBe(`seek:2:${rows - 1}`);
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

describe('AHX per-voice scopes', () => {
  /** Two voices of three points each: voice 0 = 1,2,3 and voice 1 = 4,5,6. */
  const snapshot = () => ({ channels: 2, points: 3, data: Int16Array.from([1, 2, 3, 4, 5, 6]) });

  it('the worklet records nothing until the page asks; then it is asked, and again for a new client', async () => {
    const host = setupHost();
    await openAhx(host);
    const store = host.playbackStore;
    await store.play(host.buildSong(), 'song', 0, 0);
    expect(lastClient().capture).toEqual([]);

    store.setAhxScopesEnabled(true);
    expect(lastClient().capture).toEqual([true]);
    store.setAhxScopesEnabled(false);
    expect(lastClient().capture).toEqual([true, false]);

    // The wish outlives the client: one made later starts recording at once.
    store.setAhxScopesEnabled(true);
    store.stop();
    await store.loadSong(modSong(), 'song'); // hands the transport back: the client is freed
    await openAhx(host);
    await store.play(host.buildSong(), 'song', 0, 0);
    expect(h.clients.length).toBeGreaterThan(1);
    expect(lastClient().capture).toEqual([true]);
  });

  it('serves each voice its own run of the newest snapshot while playing', async () => {
    const host = setupHost();
    await openAhx(host);
    const store = host.playbackStore;
    await store.play(host.buildSong(), 'song', 0, 0);
    store.setAhxScopesEnabled(true);
    expect(store.getAhxChannelWaveform(0)).toBeNull(); // nothing has arrived yet

    lastClient().emitWaveforms(snapshot());
    expect(Array.from(store.getAhxChannelWaveform(0) ?? [])).toEqual([1, 2, 3]);
    expect(Array.from(store.getAhxChannelWaveform(1) ?? [])).toEqual([4, 5, 6]);
    expect(store.getAhxChannelWaveform(2)).toBeNull(); // no such voice
  });

  it('goes flat (null) on pause and stop, and drops a snapshot already in flight', async () => {
    const host = setupHost();
    await openAhx(host);
    const store = host.playbackStore;
    await store.play(host.buildSong(), 'song', 0, 0);
    lastClient().emitWaveforms(snapshot());

    store.pause();
    expect(store.getAhxChannelWaveform(0)).toBeNull();
    lastClient().emitWaveforms(snapshot());
    expect(store.getAhxChannelWaveform(0)).toBeNull();

    // Resuming does not bring the pre-pause picture back.
    await store.resume();
    expect(store.getAhxChannelWaveform(0)).toBeNull();
    lastClient().emitWaveforms(snapshot());
    expect(store.getAhxChannelWaveform(0)).not.toBeNull();

    store.stop();
    expect(store.getAhxChannelWaveform(0)).toBeNull();
  });

  it('turning the scopes off, or leaving for another format, clears them', async () => {
    const host = setupHost();
    await openAhx(host);
    const store = host.playbackStore;
    await store.play(host.buildSong(), 'song', 0, 0);
    lastClient().emitWaveforms(snapshot());
    store.setAhxScopesEnabled(false);
    expect(store.getAhxChannelWaveform(0)).toBeNull();

    lastClient().emitWaveforms(snapshot());
    expect(store.getAhxChannelWaveform(0)).not.toBeNull();
    await store.loadSong(modSong(), 'song');
    expect(store.getAhxChannelWaveform(0)).toBeNull();
  });
});

describe('AHX hi-fi rendering', () => {
  it('is always on: the first client is told before the song plays', async () => {
    const host = setupHost();
    await openAhx(host);
    await host.playbackStore.play(host.buildSong(), 'song', 0, 0);
    expect(lastClient().hifi).toEqual([true]);
  });

  it('a client made later (handed back to the sampler and re-opened) is told too', async () => {
    const host = setupHost();
    await openAhx(host);
    const store = host.playbackStore;
    await store.play(host.buildSong(), 'song', 0, 0);

    store.stop();
    await store.loadSong(modSong(), 'song');
    await openAhx(host);
    await store.play(host.buildSong(), 'song', 0, 0);
    expect(lastClient().hifi).toEqual([true]);
  });
});

describe('AHX per-voice mute and solo', () => {
  it('sends the masks the UI state implies, and leaves the sampler notes-off alone', async () => {
    const host = setupHost();
    await openAhx(host);
    const store = host.playbackStore;
    await store.play(host.buildSong(), 'song', 0, 0);
    // Nothing set yet: whatever the worklet has been told is "nothing".
    expect(lastClient().muteSolo.flat().every((x) => x === 0)).toBe(true);

    store.toggleMute(1, 4);
    expect(lastClient().muteSolo.at(-1)).toEqual([0b0010, 0]);
    store.toggleMute(3, 4);
    expect(lastClient().muteSolo.at(-1)).toEqual([0b1010, 0]);
    store.toggleSolo(2, 4);
    expect(lastClient().muteSolo.at(-1)).toEqual([0b1010, 0b0100]);
    // The audibility the buttons show is the state the masks carry.
    expect([0, 1, 2, 3].map((i) => store.isTrackAudible(i))).toEqual([false, false, true, false]);

    store.toggleSolo(2, 4);
    store.toggleMute(1, 4);
    store.toggleMute(3, 4);
    expect(lastClient().muteSolo.at(-1)).toEqual([0, 0]);
    expect(h.bankCalls.filter((c) => c.startsWith('off:'))).toEqual([]);
  });

  it('a client made later starts with the state; a song with fewer voices drops the stale part', async () => {
    const host = setupHost();
    await openAhx(host);
    const store = host.playbackStore;
    await store.play(host.buildSong(), 'song', 0, 0);
    store.toggleMute(0, 4);
    store.toggleSolo(6, 8); // a voice karma does not have

    store.stop();
    await store.loadSong(modSong(), 'song'); // hands the transport back
    await openAhx(host);
    await store.play(host.buildSong(), 'song', 0, 0);
    // Voice 6 does not exist in a 4-voice song: its solo is gone, else it would silence all four.
    expect(store.soloedTracks.size).toBe(0);
    expect(store.mutedTracks.has(0)).toBe(true);
    expect(lastClient().muteSolo.at(-1)).toEqual([0b0001, 0]);
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

  it('mute and solo on a MOD still go to the sampler tracks and never reach the AHX worklet', async () => {
    const store = useTrackerPlaybackStore();
    await store.play(modSong(), 'song', 0, 0);
    store.toggleMute(1, 4);
    store.toggleSolo(2, 4);
    expect(h.bankCalls.filter((c) => c.startsWith('off:'))).toEqual(['off:1', 'off:0', 'off:3']);
    expect(store.isTrackAudible(2)).toBe(true);
    expect(store.isTrackAudible(1)).toBe(false);
    expect(h.clients).toHaveLength(0);
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
