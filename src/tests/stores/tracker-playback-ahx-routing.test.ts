import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

/**
 * The playback store's routing between `PlaybackEngine` (MOD/XM/S3M/native)
 * and the AHX worklet transport. Both engines are replaced with recorders: the
 * point is which one a given song reaches, and what the store mirrors back.
 */

const h = vi.hoisted(() => ({
  transports: [] as Array<{
    calls: string[];
    loaded: Uint8Array[];
    emitPosition: (p: { position: number; row: number; tempo: number; ticks: number }) => void;
    emitEnd: () => void;
    loadResolves: boolean;
  }>,
  engines: [] as Array<{ calls: string[] }>,
  audioState: { value: 'running' as string },
  bankCalls: [] as string[],
  loadResolves: true,
}));

vi.mock('src/audio/tracker/ahx-transport', () => ({
  AhxTransport: class {
    calls: string[] = [];
    loaded: Uint8Array[] = [];
    posL: (p: unknown) => void = () => {};
    endL: () => void = () => {};
    loadResolves = h.loadResolves;
    emitPosition(p: unknown) {
      this.posL(p);
    }
    emitEnd() {
      this.endL();
    }
    constructor() {
      h.transports.push(this as never);
    }
    get onPosition() {
      return (l: (p: unknown) => void) => {
        this.posL = l;
        return () => {};
      };
    }
    get onSongEnd() {
      return (l: () => void) => {
        this.endL = l;
        return () => {};
      };
    }
    load(bytes: Uint8Array) {
      this.calls.push('load');
      this.loaded.push(bytes);
      return this.loadResolves ? Promise.resolve({}) : new Promise(() => {});
    }
    play() {
      this.calls.push('play');
    }
    pause() {
      this.calls.push('pause');
    }
    stop() {
      this.calls.push('stop');
    }
    dispose() {
      this.calls.push('dispose');
    }
  },
}));

vi.mock('@another-synth/tracker-playback', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  class FakeEngine {
    calls: string[] = [];
    constructor() {
      h.engines.push(this);
    }
    on() {
      return () => {};
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
    }
    pause() {
      this.calls.push('pause');
    }
    stop() {
      this.calls.push('stop');
    }
  }
  return { ...actual, PlaybackEngine: FakeEngine };
});

vi.mock('src/stores/tracker-audio-store', () => ({
  useTrackerAudioStore: () => ({
    songBank: {
      get audioContext() {
        return { state: h.audioState.value };
      },
      output: {},
      setModuleFormat: () => {},
      cancelAllScheduled: () => {},
      allNotesOff: () => {},
      ensureAudioContextRunning: async () => h.audioState.value === 'running',
      prepareInstrument: async () => undefined,
    },
    setPlaybackState: (playing: boolean) => {
      h.bankCalls.push(`playing:${playing}`);
    },
  }),
}));

vi.mock('src/stores/post-fx-store', () => ({
  usePostFxStore: () => ({ onPlaybackStopped: () => {}, applyEngineEvent: () => {} }),
}));

import { useTrackerPlaybackStore } from 'src/stores/tracker-playback-store';
import { useTrackerStore } from 'src/stores/tracker-store';
import { importAhxToTrackerSong } from 'src/audio/tracker/ahx-import';
import { ahxSourceOf, setCurrentAhxSource } from 'src/audio/tracker/ahx-source';
import type { Song } from '@another-synth/tracker-playback';

const karma = fs.readFileSync(path.resolve(__dirname, '../../../public/demos/ahx/karma.ahx'));

function ahxSong(): Song {
  const store = useTrackerStore();
  return {
    title: 'Karma',
    author: 'x',
    bpm: 125,
    moduleFormat: 'ahx',
    patterns: store.patterns.map((p) => ({ id: p.id, length: p.rows, tracks: [] })),
    sequence: [...store.sequence],
  } as Song;
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

/** What `applySongFile` does to the stores for an AHX song, minus the audio graph. */
function applyAhxSong() {
  const store = useTrackerStore();
  const file = importAhxToTrackerSong(
    karma.buffer.slice(karma.byteOffset, karma.byteOffset + karma.byteLength) as ArrayBuffer,
  );
  store.loadSongFile(file);
  setCurrentAhxSource(ahxSourceOf(file));
  return file;
}

beforeEach(() => {
  setActivePinia(createPinia());
  h.transports.length = 0;
  h.engines.length = 0;
  h.bankCalls.length = 0;
  h.audioState.value = 'running';
  h.loadResolves = true;
  setCurrentAhxSource(null);
  useTrackerPlaybackStore().dispose();
});

describe('AHX song', () => {
  it('goes to the worklet transport and never touches PlaybackEngine', async () => {
    const file = applyAhxSong();
    const store = useTrackerPlaybackStore();
    await store.loadSong(ahxSong());
    await store.play(ahxSong(), 'song', 0, 0);

    expect(h.engines).toHaveLength(0);
    const t = h.transports[0]!;
    expect(t.loaded[0]).toBe(ahxSourceOf(file));
    expect(t.calls).toContain('play');
    expect(store.isPlaying).toBe(true);
    expect(store.hasSongLoaded).toBe(true);
    expect(h.bankCalls.at(-1)).toBe('playing:true');
  });

  it('mirrors worklet positions into row, sequence index and current pattern', async () => {
    applyAhxSong();
    const tracker = useTrackerStore();
    const store = useTrackerPlaybackStore();
    await store.play(ahxSong(), 'song', 0, 0);
    const seen: Array<[number, string | undefined]> = [];
    store.onPosition((row, id) => seen.push([row, id]));

    h.transports[0]!.emitPosition({ position: 3, row: 5, tempo: 6, ticks: 0 });

    const expectedId = tracker.sequence[3];
    expect(store.currentSequenceIndex).toBe(3);
    expect(store.playbackRow).toBe(5);
    expect(tracker.currentPatternId).toBe(expectedId);
    expect(seen).toEqual([[5, expectedId]]);
  });

  it('ignores a position report that arrives after stop', async () => {
    applyAhxSong();
    const store = useTrackerPlaybackStore();
    await store.play(ahxSong(), 'song', 0, 0);
    store.stop();
    h.transports[0]!.emitPosition({ position: 2, row: 9, tempo: 6, ticks: 0 });
    expect(store.playbackRow).toBe(0);
    expect(store.currentSequenceIndex).toBe(0);
    expect(store.isPlaying).toBe(false);
  });

  it('pauses, resumes without rewinding, and stops', async () => {
    applyAhxSong();
    const store = useTrackerPlaybackStore();
    await store.play(ahxSong(), 'song', 0, 0);
    h.transports[0]!.emitPosition({ position: 1, row: 7, tempo: 6, ticks: 0 });

    store.pause();
    expect(store.isPaused).toBe(true);
    expect(store.isPlaying).toBe(false);
    expect(h.transports[0]!.calls.at(-1)).toBe('pause');

    await store.resume();
    expect(store.isPlaying).toBe(true);
    expect(h.transports[0]!.calls.at(-1)).toBe('play');
    expect(store.currentSequenceIndex).toBe(1);

    // The jukebox resumes through play() at the paused row: still a resume.
    store.pause();
    const stopsBefore = h.transports[0]!.calls.filter((c) => c === 'stop').length;
    await store.play(ahxSong(), 'song', store.playbackRow, store.currentSequenceIndex);
    expect(h.transports[0]!.calls.filter((c) => c === 'stop').length).toBe(stopsBefore);
    expect(store.currentSequenceIndex).toBe(1);

    store.stop();
    expect(store.isPlaying).toBe(false);
    expect(store.isPaused).toBe(false);
    expect(store.playbackRow).toBe(0);
    expect(h.transports[0]!.calls.at(-1)).toBe('stop');
  });

  it('a fresh play() rewinds to the top', async () => {
    applyAhxSong();
    const store = useTrackerPlaybackStore();
    await store.play(ahxSong(), 'song', 0, 0);
    h.transports[0]!.emitPosition({ position: 4, row: 2, tempo: 6, ticks: 0 });
    await store.play(ahxSong(), 'song', 0, 0);
    expect(store.currentSequenceIndex).toBe(0);
    expect(store.playbackRow).toBe(0);
    expect(h.transports[0]!.calls.at(-2)).toBe('stop');
    expect(h.transports[0]!.calls.at(-1)).toBe('play');
  });

  it('song end: a non-looping song stops and fires the listeners; a looping one does not', async () => {
    applyAhxSong();
    const store = useTrackerPlaybackStore();
    const ended = vi.fn();
    store.onSongEnd(ended);

    store.setLoopSong(true);
    await store.play(ahxSong(), 'song', 0, 0);
    h.transports[0]!.emitEnd();
    expect(ended).not.toHaveBeenCalled();
    expect(store.isPlaying).toBe(true);

    store.setLoopSong(false);
    h.transports[0]!.emitEnd();
    expect(ended).toHaveBeenCalledOnce();
    expect(store.isPlaying).toBe(false);
    expect(h.transports[0]!.calls.at(-1)).toBe('stop');
  });

  it('seek, setBpm and setPatternLength do not reach a PlaybackEngine left from another song', async () => {
    const store = useTrackerPlaybackStore();
    await store.play(modSong(), 'song', 0, 0);
    const engine = h.engines[0]!;
    applyAhxSong();
    await store.play(ahxSong(), 'song', 0, 0);
    engine.calls.length = 0;
    store.seek(4);
    store.setBpm(140);
    store.setPatternLength('m1', 32);
    expect(engine.calls).toEqual([]);
  });

  it('refuses to play (without throwing) when the source bytes are missing', async () => {
    applyAhxSong();
    setCurrentAhxSource(null); // e.g. a .cmod saved from an AHX song
    const store = useTrackerPlaybackStore();
    await store.play(ahxSong(), 'song', 0, 0);
    expect(store.isPlaying).toBe(false);
    expect(h.transports.flatMap((t) => t.calls)).not.toContain('play');
  });

  it('does not wait on the worklet while the context is suspended, but play does', async () => {
    applyAhxSong();
    h.audioState.value = 'suspended';
    const store = useTrackerPlaybackStore();
    // The transport's load never settles until the context runs.
    h.loadResolves = false;
    const loaded = store.loadSong(ahxSong());
    // Not the transport's promise: must resolve on its own.
    await expect(Promise.race([loaded, new Promise((r) => setTimeout(() => r('hung'), 200))])).resolves.toBe(true);
    expect(store.hasSongLoaded).toBe(true);
    // Not started: playing needs a running context.
    await store.play(ahxSong(), 'song', 0, 0);
    expect(store.isPlaying).toBe(false);
  });
});

describe('other formats', () => {
  it('a MOD never creates the AHX transport and uses PlaybackEngine as before', async () => {
    const store = useTrackerPlaybackStore();
    await store.play(modSong(), 'song', 0, 0);
    expect(h.transports).toHaveLength(0);
    expect(h.engines).toHaveLength(1);
    expect(h.engines[0]!.calls).toEqual(expect.arrayContaining(['loadSong', 'play']));
    store.pause();
    expect(h.engines[0]!.calls.at(-1)).toBe('pause');
    await store.resume();
    expect(h.engines[0]!.calls.at(-1)).toBe('play');
    store.stop();
    expect(h.engines[0]!.calls.at(-1)).toBe('stop');
    expect(h.transports).toHaveLength(0);
  });

  it('after an AHX song, a MOD hands the transport back: the worklet stops, the engine plays', async () => {
    applyAhxSong();
    const store = useTrackerPlaybackStore();
    await store.play(ahxSong(), 'song', 0, 0);
    const t = h.transports[0]!;

    await store.play(modSong(), 'song', 0, 0);
    expect(t.calls.at(-1)).toBe('stop');
    expect(h.engines[0]!.calls).toContain('play');

    // And pause/stop now drive the engine, not the worklet.
    t.calls.length = 0;
    store.pause();
    store.stop();
    expect(t.calls).toEqual([]);
  });
});
