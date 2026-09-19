// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia, storeToRefs } from 'pinia';

/**
 * How an instrument edit made in the tracker store reaches the worklets: the
 * real store, the real `AhxTransport` / `AhxPreview`, the real edit registry
 * (`ahx-source`), and a fake worklet client under them that records what it is
 * told. The contract under test: an edit commits to the song, so the SONG
 * player is told (coalesced, and on play) as well as the preview (at once).
 */

interface FakeClient {
  isPreview: boolean;
  calls: string[];
  loads: Array<Array<{ instrument: number; bytes: number[] }>>;
  disposed: boolean;
}

const h = vi.hoisted(() => ({
  clients: [] as Array<{
    isPreview: boolean;
    calls: string[];
    loads: Array<Array<{ instrument: number; bytes: number[] }>>;
    disposed: boolean;
  }>,
}));

vi.mock('src/audio/tracker/ahx-player', () => ({
  createAhxPlayer: async (audioContext: unknown) => {
    const client = {
      audioContext,
      output: { connect: () => {} },
      isPreview: false,
      calls: [] as string[],
      loads: [] as Array<Array<{ instrument: number; bytes: number[] }>>,
      disposed: false,
      setPreview: (on: boolean) => {
        client.isPreview = on;
      },
      setHifi: () => {},
      setStopAtEnd: () => {},
      setCapture: () => {},
      setMuteSolo: () => {},
      setLoopPosition: () => {},
      async loadSong(
        _bytes: Uint8Array,
        _stereo?: number,
        instruments: ReadonlyArray<{ instrument: number; bytes: Uint8Array }> = [],
      ) {
        client.calls.push('load');
        client.loads.push(instruments.map((e) => ({ instrument: e.instrument, bytes: Array.from(e.bytes) })));
        return { name: 'x', positionCount: 1, trackLength: 64, channels: 4, droppedChannels: 0, sampleRate: 44100 };
      },
      async replaceInstrument(instrument: number, bytes: Uint8Array) {
        client.calls.push(`replace:${instrument}:${bytes.length}`);
      },
      previewNoteOn: (i: number) => client.calls.push(`on:${i}`),
      previewNoteOff: () => client.calls.push('off'),
      play: () => client.calls.push('play'),
      pause: () => client.calls.push('pause'),
      restart: () => client.calls.push('restart'),
      seek: () => {},
      dispose: () => {
        client.disposed = true;
      },
      onPosition: () => () => {},
      onSongEnd: () => () => {},
      onWaveforms: () => () => {},
    };
    h.clients.push(client);
    return client;
  },
}));

vi.mock('src/stores/tracker-audio-store', () => {
  const audioContext = { state: 'running', resume: () => Promise.resolve() };
  const songBank = {
    audioContext,
    output: {},
    setModuleFormat: () => {},
    resetForNewSong: () => {},
    cancelAllScheduled: () => {},
    allNotesOff: () => {},
    ensureAudioContextRunning: async () => true,
    prepareInstrument: async () => undefined,
    notesOffForTrack: () => {},
  };
  return { useTrackerAudioStore: () => ({ songBank, setPlaybackState: () => {} }) };
});

vi.mock('src/stores/post-fx-store', () => ({
  usePostFxStore: () => ({ onPlaybackStopped: () => {}, applyEngineEvent: () => {}, onSongLoad: () => {} }),
}));

import { computed, ref } from 'vue';
import { useTrackerPlaybackStore } from 'src/stores/tracker-playback-store';
import { useTrackerStore } from 'src/stores/tracker-store';
import { useTrackerAudioStore } from 'src/stores/tracker-audio-store';
import { useTrackerFileIO } from 'src/composables/useTrackerFileIO';
import type { TrackerSongBank } from 'src/audio/tracker/song-bank';
import { useTrackerSongBuilder } from 'src/composables/useTrackerSongBuilder';
import { formatInstrumentId, normalizeInstrumentId } from 'src/audio/tracker/instrument-ids';
import { currentAhxInstrumentEdits, setCurrentAhxSource } from 'src/audio/tracker/ahx-source';
import { setAhxNumber } from 'src/audio/tracker/ahx-instrument-edit';
import type { Song } from '@another-synth/tracker-playback';

const karmaBytes = fs.readFileSync(path.resolve(__dirname, '../../../public/demos/ahx/karma.ahx'));

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
  const buildSong = (mode: 'song' | 'pattern' = 'song'): Song => builder.buildPlaybackSong(mode) as Song;
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

async function openAhx(host: ReturnType<typeof setupHost>) {
  const file = await host.fileIO.parseSongBuffer(
    karmaBytes.buffer.slice(karmaBytes.byteOffset, karmaBytes.byteOffset + karmaBytes.byteLength) as ArrayBuffer,
  );
  await host.fileIO.applySongFile(file);
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
/** Past the sync's 120 ms wait (real time: the file loader has timers of its own). */
const pastDebounce = () => new Promise<void>((resolve) => setTimeout(resolve, 260));
const song = () => h.clients.find((c) => !c.isPreview && !c.disposed) as FakeClient | undefined;
const preview = () => h.clients.find((c) => c.isPreview && !c.disposed) as FakeClient | undefined;
const replaces = (c: FakeClient | undefined) => (c?.calls ?? []).filter((x) => x.startsWith('replace:'));

beforeEach(() => {
  setActivePinia(createPinia());
  h.clients.length = 0;
  setCurrentAhxSource(null);
  // No `dispose()` here: a fresh store keeps the subscriptions the wiring under
  // test lives in (`dispose` is for the end of a test).
});
afterEach(() => {
  useTrackerPlaybackStore().dispose();
});

describe('an AHX instrument edit reaches the song and the preview', () => {
  it('goes to the preview at once, to the song player once the burst is over, and never reloads either', async () => {
    const host = setupHost();
    await openAhx(host);
    await settle();
    await host.playbackStore.play(host.buildSong(), 'song', 0, 0);
    await settle();
    expect(song()).toBeDefined();
    expect(preview()).toBeDefined();
    const songLoads = song()!.loads.length;
    const previewLoads = preview()!.loads.length;

    const slot = host.trackerStore.instrumentSlots.find((s) => s.slot === 16)!;
    for (const volume of [1, 2, 3, 4]) {
      host.trackerStore.updateAhxInstrument(16, setAhxNumber(slot.ahxData!, 'volume', volume));
    }
    await settle();
    // The preview swap is a data write: every edit, at once.
    expect(replaces(preview())).toHaveLength(4);
    // The song player walks the song for a table-changing edit: one send, after the burst.
    expect(replaces(song())).toHaveLength(0);
    await pastDebounce();
    expect(replaces(song())).toHaveLength(1);
    expect(host.trackerStore.instrumentSlots.find((s) => s.slot === 16)!.ahxData!.volume).toBe(4);

    expect(song()!.loads).toHaveLength(songLoads);
    expect(preview()!.loads).toHaveLength(previewLoads);
  });

  it('play sends the song player the edits that are still waiting', async () => {
    const host = setupHost();
    await openAhx(host);
    await host.playbackStore.play(host.buildSong(), 'song', 0, 0);
    await settle();
    host.playbackStore.pause();
    const slot = host.trackerStore.instrumentSlots.find((s) => s.slot === 16)!;
    host.trackerStore.updateAhxInstrument(16, setAhxNumber(slot.ahxData!, 'volume', 5));
    expect(replaces(song())).toHaveLength(0);
    await host.playbackStore.play(host.buildSong(), 'song', 0, 0);
    await settle();
    expect(replaces(song())).toHaveLength(1);
    expect(song()!.calls.indexOf('replace:16:22')).toBeLessThan(song()!.calls.lastIndexOf('play'));
  });

  it('a different song drops the waiting edits and the recorded ones', async () => {
    const host = setupHost();
    await openAhx(host);
    await host.playbackStore.play(host.buildSong(), 'song', 0, 0);
    await settle();
    const slot = host.trackerStore.instrumentSlots.find((s) => s.slot === 16)!;
    host.trackerStore.updateAhxInstrument(16, setAhxNumber(slot.ahxData!, 'volume', 5));
    setCurrentAhxSource(null);
    await pastDebounce();
    expect(replaces(song())).toHaveLength(0);
    expect(currentAhxInstrumentEdits()).toEqual([]);
  });

  it('a refused edit (a slot that is not an AHX instrument) sends nothing', async () => {
    const host = setupHost();
    await openAhx(host);
    await host.playbackStore.play(host.buildSong(), 'song', 0, 0);
    await settle();
    const slot = host.trackerStore.instrumentSlots.find((s) => s.slot === 16)!;
    expect(host.trackerStore.updateAhxInstrument(60, slot.ahxData!)).toBe(false);
    expect(host.trackerStore.updateAhxInstrument(16, { ...slot.ahxData!, volume: 999 })).toBe(false);
    await pastDebounce();
    expect(replaces(song())).toHaveLength(0);
    expect(replaces(preview())).toHaveLength(0);
  });
});
