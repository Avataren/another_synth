import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { toRaw } from 'vue';
import type { Song } from '@another-synth/tracker-playback';

/**
 * The playback store's replay capability (plan-topbar-play.md): the top-bar
 * play button must be functional from the stopped state, so the store retains
 * the last song a successful load put into an engine (`lastPlaybackSong` /
 * `lastPlaybackMode`, set at the two load choke points `loadSong` and
 * `loadAhxSong`) and re-enters the real `play()` path with it (`playLast`,
 * from the beginning — D-B').
 *
 * This drives the REAL `useTrackerPlaybackStore` (no test had before — every
 * other suite mocks the store wholesale), with the heavy edges mocked: the
 * `PlaybackEngine` class (fake records every transport call), the song bank /
 * tracker / post-fx stores, and the AHX worklet modules (the fake transport
 * answers `load` like the worklet's handshake). The AHX retention test pins
 * that an AHX song records through the same choke point without touching the
 * real worklet.
 *
 * Replay routing (D-A') is asserted on the fake engine's call log: a stopped
 * `playLast()` must `loadSong` the retained song object and `seek(0)` /
 * `play()` — the production start path, not a side door.
 */

const h = vi.hoisted(() => {
  class FakePlaybackEngine {
    calls: string[] = [];
    loadedSongs: object[] = [];
    listeners = new Map<string, Array<(arg: unknown) => void>>();
    constructor(_opts: unknown) {
      state.engineInstances.push(this);
    }
    on(event: string, cb: (arg: unknown) => void): () => void {
      const list = this.listeners.get(event) ?? [];
      list.push(cb);
      this.listeners.set(event, list);
      return () => {
        this.listeners.set(event, (this.listeners.get(event) ?? []).filter((l) => l !== cb));
      };
    }
    emit(event: string, arg: unknown): void {
      for (const cb of this.listeners.get(event) ?? []) cb(arg);
    }
    setLoopCurrentPattern(_loop: boolean): void {
      this.calls.push('setLoopCurrentPattern');
    }
    setLoopSong(_loop: boolean): void {
      this.calls.push('setLoopSong');
    }
    loadSong(song: object, _sequenceIndex: number): void {
      this.calls.push('loadSong');
      this.loadedSongs.push(song);
    }
    async prepareInstruments(): Promise<void> {
      this.calls.push('prepareInstruments');
    }
    setBpm(bpm: number): void {
      this.calls.push(`setBpm:${bpm}`);
    }
    seek(row: number): void {
      this.calls.push(`seek:${row}`);
    }
    async play(): Promise<void> {
      this.calls.push('play');
      this.emit('state', 'playing');
    }
    pause(): void {
      this.calls.push('pause');
      this.emit('state', 'paused');
    }
    stop(): void {
      this.calls.push('stop');
      this.emit('state', 'stopped');
    }
    setPatternLength(_patternId: string | null, _rows: number): void {
      this.calls.push('setPatternLength');
    }
  }

  class FakeAhxTransport {
    calls: string[] = [];
    constructor(_songBank: unknown) {
      state.transportInstances.push(this);
    }
    async load(_bytes: Uint8Array): Promise<{ rejectedInstruments: number[] } | null> {
      this.calls.push('load');
      return { rejectedInstruments: [] };
    }
    isLoaded(_bytes: Uint8Array): boolean {
      return true;
    }
    seek(_position: number, _row: number): void {
      this.calls.push('seek');
    }
    play(): void {
      this.calls.push('play');
    }
    pause(): void {
      this.calls.push('pause');
    }
    stop(): void {
      this.calls.push('stop');
    }
    dispose(): void {
      this.calls.push('dispose');
    }
    setLoopPosition(_loop: boolean): void {
      this.calls.push('setLoopPosition');
    }
    setMuteSolo(_muted: number, _soloed: number): void {
      this.calls.push('setMuteSolo');
    }
    setStopAtEnd(_stop: boolean): void {
      this.calls.push('setStopAtEnd');
    }
    setCapture(_capture: boolean): void {
      this.calls.push('setCapture');
    }
    replaceInstruments(_edits: unknown[]): Array<Promise<unknown>> {
      this.calls.push('replaceInstruments');
      return [];
    }
    async reloadInPlace(): Promise<{ outcome: string; info: { rejectedInstruments: number[] } }> {
      this.calls.push('reloadInPlace');
      return { outcome: 'loaded', info: { rejectedInstruments: [] } };
    }
    onPosition(): () => void {
      return () => undefined;
    }
    onSongEnd(): () => void {
      return () => undefined;
    }
    onWaveforms(): () => void {
      return () => undefined;
    }
    onSeekKind(): () => void {
      return () => undefined;
    }
  }

  const state = {
    engineInstances: [] as FakePlaybackEngine[],
    transportInstances: [] as FakeAhxTransport[],
    ahxSourceBytes: null as Uint8Array | null,
  };

  class FakeAhxReloadScheduler {
    cancel(): void {}
    flush(): void {}
    get pending(): boolean {
      return false;
    }
    get pendingMap(): undefined {
      return undefined;
    }
    schedule(_mapPosition: unknown): void {}
  }

  return { FakePlaybackEngine, FakeAhxTransport, FakeAhxReloadScheduler, state };
});

const songBankCalls: string[] = [];
const fakeSongBank = {
  audioContext: { state: 'running', baseLatency: 0 },
  ensureAudioContextRunning: async () => {
    songBankCalls.push('ensureAudioContextRunning');
    return true;
  },
  setModuleFormat: () => {
    songBankCalls.push('setModuleFormat');
  },
  cancelAllScheduled: () => {
    songBankCalls.push('cancelAllScheduled');
  },
  allNotesOff: () => {
    songBankCalls.push('allNotesOff');
  },
  notesOffForTrack: () => undefined,
  cutAllVoicesAtTime: () => undefined,
  setUserMasterVolume: () => undefined,
  setMasterVolume: () => undefined,
  prepareInstrument: async () => 'i1',
  setInstrumentGain: () => undefined,
  setInstrumentMacro: () => undefined,
  setVoicePitchAtTime: () => undefined,
  setVoiceVolumeAtTime: () => undefined,
  setVoicePanAtTime: () => undefined,
  setVoiceSampleOffsetAtTime: () => undefined,
  setVoiceEnvelopePositionAtTime: () => undefined,
  retriggerNoteAtTime: () => undefined,
  noteOnAtTime: () => undefined,
  noteOffAtTime: () => undefined,
  noteOn: () => undefined,
  noteOff: () => undefined,
};

const fakeAudioStore = {
  songBank: fakeSongBank,
  setPlaybackState: (playing: boolean) => {
    songBankCalls.push(`setPlaybackState:${playing}`);
  },
};

const fakeTrackerStore = {
  sequence: ['p1'],
  currentPatternId: 'p1',
  ahxDoc: undefined,
  rowsForPattern: (_patternId: string) => 64,
  setCurrentPatternId: (_patternId: string) => undefined,
  flushAhxBytes: () => undefined,
};

vi.mock('@another-synth/tracker-playback', () => ({
  PlaybackEngine: h.FakePlaybackEngine,
}));

vi.mock('src/stores/tracker-audio-store', () => ({
  useTrackerAudioStore: () => fakeAudioStore,
}));

vi.mock('src/stores/tracker-store', () => ({
  useTrackerStore: () => fakeTrackerStore,
}));

vi.mock('src/stores/post-fx-store', () => ({
  usePostFxStore: () => ({ applyEngineEvent: () => undefined, onPlaybackStopped: () => undefined }),
}));

vi.mock('src/audio/device-profile', () => ({
  defaultLookaheadSeconds: () => 0.1,
}));

vi.mock('src/audio/tracker/ahx-transport', () => ({
  AhxTransport: h.FakeAhxTransport,
  AHX_RECOVERY_NOTICE_ID: 'ahx-recovery',
  AHX_RELOAD_FAILED_NOTICE_ID: 'ahx-reload-failed',
}));

vi.mock('src/audio/tracker/ahx-reload', () => ({
  composeAhxPositionMaps: () => undefined,
  mapAhxPlace: () => ({ position: 0, row: 0 }),
  AhxReloadScheduler: h.FakeAhxReloadScheduler,
}));

vi.mock('src/audio/tracker/ahx-edit-notice', () => ({
  reportAhxEditNotice: () => undefined,
}));

vi.mock('src/audio/tracker/ahx-preview', () => ({
  AhxPreview: class {
    onPListRow(): this {
      return this;
    }
    onOutputNode(): this {
      return this;
    }
  },
}));

vi.mock('src/audio/tracker/ahx-plist-playhead', () => ({
  clearAhxPListPlayhead: () => undefined,
  pushAhxPListReport: () => undefined,
  setAhxPListTimingSource: () => undefined,
}));

vi.mock('src/audio/tracker/ahx-preview-output', () => ({
  setAhxPreviewOutputNode: () => undefined,
}));

vi.mock('src/audio/tracker/plist-playhead-clock', () => ({
  playheadLatencyMs: () => 0,
  playheadTiming: () => ({ lookahead: 0, intervalMs: 25 }),
}));

vi.mock('src/audio/tracker/ahx-source', () => ({
  currentAhxSource: () => h.state.ahxSourceBytes,
  currentAhxPreviewSource: () => null,
  ahxSpeedMultiplierOf: () => 1,
  onAhxInstrumentEdit: () => () => undefined,
  onAhxStructureChange: () => () => undefined,
  onCurrentAhxSourceChange: () => () => undefined,
}));

vi.mock('src/audio/tracker/ahx-instrument-sync', () => ({
  AhxInstrumentSync: class {
    discard(): void {}
    push(_edit: unknown): void {}
    flush(): void {}
  },
}));

vi.mock('src/audio/tracker/ahx-notices', () => ({
  clearAhxNotice: () => undefined,
  clearAhxNotices: () => undefined,
  reportAhxNotice: () => undefined,
  reportRejectedAhxInstruments: () => undefined,
}));

import { useTrackerPlaybackStore } from 'src/stores/tracker-playback-store';

/**
 * Pinia hands back reactive proxies of retained objects, so identity pins go
 * through `toRaw`: the retained song must be THE loaded object, not a copy.
 */
const rawRetained = (store: ReturnType<typeof useTrackerPlaybackStore>): Song | null => {
  const retained = store.lastPlaybackSong;
  return retained === null ? null : toRaw(retained);
};

const makeSong = (): Song => ({
  title: 'Test song',
  author: 'Tester',
  bpm: 125,
  patterns: [{ id: 'p1', length: 64, tracks: [{ id: 't1', steps: [] }] }],
  sequence: ['p1'],
  moduleFormat: 'native',
});

const makeAhxSong = (): Song => ({ ...makeSong(), moduleFormat: 'ahx', patterns: [] });

let activeStore: ReturnType<typeof useTrackerPlaybackStore> | null = null;

describe('playback store replay (top-bar play from stopped, plan-topbar-play.md)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    h.state.engineInstances.length = 0;
    h.state.transportInstances.length = 0;
    h.state.ahxSourceBytes = null;
    songBankCalls.length = 0;
  });

  afterEach(() => {
    // Module-level singletons (engine, transport) outlive a pinia; drop them
    // so the next test starts clean.
    activeStore?.dispose();
    activeStore = null;
    document.body.innerHTML = '';
  });

  it('a successful load records the song and mode; canReplay turns true while stopped', async () => {
    const store = useTrackerPlaybackStore();
    activeStore = store;
    const song = makeSong();
    const loaded = await store.loadSong(song, 'song');
    expect(loaded).toBe(true);
    expect(rawRetained(store)).toBe(song); // identity: the loaded object, not a copy
    expect(store.lastPlaybackSong).toStrictEqual(song);
    expect(store.lastPlaybackMode).toBe('song');
    expect(store.canReplay).toBe(true);
    expect(store.isPlaying).toBe(false);
    expect(store.isPaused).toBe(false);
  });

  it('playLast() while stopped re-enters the real play path: retained song, mode, row 0, position 0', async () => {
    const store = useTrackerPlaybackStore();
    activeStore = store;
    const song = makeSong();
    await store.loadSong(song, 'song');
    await store.playLast();
    // One engine, started through the production path with the retained song.
    expect(h.state.engineInstances).toHaveLength(1);
    const engine = h.state.engineInstances[0];
    if (!engine) throw new Error('playLast did not create an engine');
    expect(engine.calls).toContain('loadSong');
    expect(engine.calls).toContain('prepareInstruments');
    expect(engine.calls).toContain('setBpm:125');
    expect(engine.calls).toContain('seek:0'); // from the beginning (D-B')
    expect(engine.calls).toContain('play');
    // The engine loaded the song twice: once from `loadSong` directly, once
    // from `playLast`'s re-entry into `play`. The second is the replay's.
    expect(engine.loadedSongs).toHaveLength(2);
    const replayed = engine.loadedSongs[1];
    if (!replayed) throw new Error('the replay load did not reach the engine');
    expect(toRaw(replayed)).toBe(song); // identity again
    expect(store.isPlaying).toBe(true);
    expect(store.canReplay).toBe(false);
  });

  it('playLast() is a no-op while playing and while paused (resume covers mid-song)', async () => {
    const store = useTrackerPlaybackStore();
    activeStore = store;
    const song = makeSong();
    await store.loadSong(song, 'song');
    await store.playLast();
    const engine = h.state.engineInstances[0];
    if (!engine) throw new Error('playLast did not create an engine');
    const started = [...engine.calls];
    // Playing: no second start.
    await store.playLast();
    expect(engine.calls).toEqual(started);
    // Paused: still no start — the paused toggle is resume's job.
    store.pause();
    const pausedCalls = [...engine.calls];
    await store.playLast();
    expect(engine.calls).toEqual(pausedCalls);
    // Two loads total — the direct load and the first playLast's replay. The
    // playing and paused no-op attempts must not have added a third.
    expect(engine.calls.filter((c) => c === 'loadSong')).toHaveLength(2);
    expect(engine.calls.filter((c) => c === 'play')).toHaveLength(1);
  });

  it('playLast() with nothing ever loaded does nothing — no engine is even created (S1)', async () => {
    const store = useTrackerPlaybackStore();
    activeStore = store;
    expect(store.canReplay).toBe(false);
    await store.playLast();
    expect(h.state.engineInstances).toHaveLength(0);
    expect(store.isPlaying).toBe(false);
  });

  it('stop() leaves the retention intact: canReplay is true again, same song object', async () => {
    const store = useTrackerPlaybackStore();
    activeStore = store;
    const song = makeSong();
    await store.loadSong(song, 'song');
    await store.playLast();
    store.stop();
    expect(store.isPlaying).toBe(false);
    expect(rawRetained(store)).toBe(song);
    expect(store.lastPlaybackSong).toStrictEqual(song);
    expect(store.canReplay).toBe(true);
    // And the replay after stop starts from the top again.
    await store.playLast();
    const engine = h.state.engineInstances[0];
    if (!engine) throw new Error('playLast did not create an engine');
    expect(engine.calls.filter((c) => c === 'seek:0')).toHaveLength(2);
  });

  it('an AHX song records through the same choke point (loadAhxSong)', async () => {
    h.state.ahxSourceBytes = new Uint8Array([1, 2, 3]);
    const store = useTrackerPlaybackStore();
    activeStore = store;
    const song = makeAhxSong();
    const loaded = await store.loadSong(song, 'song');
    expect(loaded).toBe(true);
    expect(h.state.transportInstances).toHaveLength(1);
    const transport = h.state.transportInstances[0];
    if (!transport) throw new Error('the AHX load did not create a transport');
    expect(transport.calls).toContain('load');
    expect(rawRetained(store)).toBe(song);
    expect(store.lastPlaybackSong).toStrictEqual(song);
    expect(store.lastPlaybackMode).toBe('song');
    expect(store.canReplay).toBe(true);
  });
});
