// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia, storeToRefs } from 'pinia';

/**
 * plan-hvl-editing.md P2, the playback routing test: how an edit to an HVL song
 * reaches the engine, over the same harness as `ahx-engine-sync.test.ts` (the
 * real tracker store, playback store, `AhxTransport`, reload scheduler, opened
 * through the real file loader; only the worklet client is a fake that records
 * what it is sent). The song is meltwater_10ch.hvl and every edit is on channel
 * 10, one the old four-channel loops never saw.
 *
 * Pinned both ways: an unedited HVL song plays the file's own bytes (the very
 * array the loader read, byte-identical), and the engine's bytes change only
 * after an edit, through the debounced live reload; what it is then handed is
 * the edited HVL file with its full instrument set (the doc carries it, P2
 * Option 1).
 */

interface FakeClient {
  isPreview: boolean;
  /** `load`, `seek:<position>:<row>`, `play`, `pause`, `restart:<n>`, in the order they were sent. */
  calls: string[];
  loaded: Uint8Array[];
  disposed: boolean;
  emitPosition: (p: { position: number; row: number; tempo?: number; ticks?: number; seekKind?: 1 | 2 }) => void;
}

const h = vi.hoisted(() => ({
  clients: [] as Array<{
    isPreview: boolean;
    calls: string[];
    loaded: Uint8Array[];
    disposed: boolean;
    emitPosition: (p: { position: number; row: number; tempo?: number; ticks?: number; seekKind?: 1 | 2 }) => void;
  }>,
  /** While set, the SONG player's `loadSong` waits on it (the worklet is busy prewarming). */
  gate: null as null | Promise<void>,
  /** The next this-many SONG player loads are refused by the engine. */
  refuse: 0,
}));

vi.mock('src/audio/tracker/ahx-player', () => ({
  createAhxPlayer: async (audioContext: unknown) => {
    const positionL = new Set<(p: never) => void>();
    const client = {
      audioContext,
      output: { connect: () => {} },
      isPreview: false,
      calls: [] as string[],
      loaded: [] as Uint8Array[],
      disposed: false,
      setPreview: (on: boolean) => {
        client.isPreview = on;
      },
      setHifi: () => {},
      setStopAtEnd: () => {},
      setCapture: () => {},
      setMuteSolo: () => {},
      setLoopPosition: () => {},
      async loadSong(bytes: Uint8Array) {
        client.calls.push('load');
        client.loaded.push(bytes);
        if (!client.isPreview) {
          if (h.gate) await h.gate;
          if (h.refuse > 0) {
            h.refuse--;
            throw new Error('AHX load failed: refused by the test');
          }
        }
        const parsed = parseAhx(bytes);
        return { name: 'x', positionCount: parsed.positionNr, trackLength: parsed.trackLength, channels: parsed.channels, droppedChannels: 0, sampleRate: 44100 };
      },
      async replaceInstrument() {},
      replaceInstruments(edits: ReadonlyArray<unknown>) {
        return edits.map(() => Promise.resolve());
      },
      onPListRow: () => () => {},
      previewNoteOn: (i: number) => client.calls.push(`on:${i}`),
      previewNoteOff: () => client.calls.push('off'),
      play: () => client.calls.push('play'),
      pause: () => client.calls.push('pause'),
      restart: (n: number) => client.calls.push(`restart:${n}`),
      seek: (position: number, row: number) => client.calls.push(`seek:${position}:${row}`),
      dispose: () => {
        client.disposed = true;
      },
      onPosition: (l: (p: never) => void) => {
        positionL.add(l);
        return () => positionL.delete(l);
      },
      onSongEnd: () => () => {},
      onWaveforms: () => () => {},
      emitPosition: (p: { position: number; row: number; tempo?: number; ticks?: number; seekKind?: 1 | 2 }) =>
        positionL.forEach((l) => l({ tempo: 6, ticks: 0, ...p } as never)),
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
import {
  ahxSourceInfo,
  currentAhxSource,
  onAhxStructureChange,
  setCurrentAhxSource,
  type AhxStructureChange,
} from 'src/audio/tracker/ahx-source';
import { clearAhxNotices } from 'src/audio/tracker/ahx-notices';
import { clearAhxEditNotice } from 'src/audio/tracker/ahx-edit-notice';
import { AHX_RELOAD_IDLE_MS, AHX_RELOAD_MAX_WAIT_MS } from 'src/audio/tracker/ahx-reload';
import { docChannels, type AhxDoc } from 'src/audio/tracker/ahx-doc';
import { parseAhx, type Song } from '@another-synth/tracker-playback';

const hvlFile = new Uint8Array(fs.readFileSync(path.resolve(__dirname, '../../public/demos/ahx/meltwater_10ch.hvl')));
const source = parseAhx(hvlFile);
/** Channel 10 (index 9): past the old four-channel loops. */
const LAST = 9;

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
type Host = ReturnType<typeof setupHost>;

async function openHvl(host: Host) {
  const file = await host.fileIO.parseSongBuffer(
    hvlFile.buffer.slice(hvlFile.byteOffset, hvlFile.byteOffset + hvlFile.byteLength) as ArrayBuffer,
  );
  await host.fileIO.applySongFile(file);
}

const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const advance = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
};
const song = () => h.clients.find((c) => !c.isPreview && !c.disposed) as FakeClient | undefined;

/** The song is open (real timers, the loader has some of its own), playing, and the clock is the test's. */
async function playing(host: Host, at?: { position: number; row: number }) {
  await openHvl(host);
  await settle();
  vi.useFakeTimers();
  await host.playbackStore.play(host.buildSong(), 'song', 0, 0);
  await settle();
  if (at) song()!.emitPosition(at);
}

/** A cell edit as the grid makes it: the track's entries replaced, written back at once. */
function editCell(host: Host, row: number, position = 0, channel = LAST) {
  const track = host.trackerStore.patterns[position]!.tracks[channel]!;
  track.entries = [...track.entries.filter((e) => e.row !== row), { row, note: 'C-3', instrument: '01' }];
  host.trackerStore.syncAhxWriteBack();
}

const doc = (host: Host): AhxDoc => host.trackerStore.ahxDoc as AhxDoc;

beforeEach(() => {
  setActivePinia(createPinia());
  h.clients.length = 0;
  h.gate = null;
  h.refuse = 0;
  clearAhxNotices();
  clearAhxEditNotice();
  setCurrentAhxSource(null);
});
afterEach(() => {
  vi.useRealTimers();
  h.gate = null;
  useTrackerPlaybackStore().dispose();
});

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
/** What a published file must still be: this song, at its width, with every instrument it came with. */
function expectWholeSong(bytes: Uint8Array) {
  const parsed = parseAhx(bytes);
  expect([parsed.format, parsed.channels]).toEqual(['hvl', 10]);
  expect(parsed.instrumentNr).toBe(source.instrumentNr);
  expect(parsed.instruments).toEqual(source.instruments);
  return parsed;
}

describe('an unedited HVL song plays the file\'s own bytes', () => {
  it('loads editable at 10 channels; the worklet is handed the file byte for byte, tagged HVL, and Play keeps it', async () => {
    const host = setupHost();
    await openHvl(host);
    await settle();
    expect(doc(host).format).toBe('hvl');
    expect(docChannels(doc(host))).toBe(10);
    expect(host.trackerStore.isAhxEditable).toBe(true);
    expect(sameBytes(currentAhxSource()!, hvlFile)).toBe(true);
    expect(ahxSourceInfo.value?.format).toBe('hvl');
    const held = currentAhxSource();
    await host.playbackStore.play(host.buildSong(), 'song', 0, 0);
    await settle();
    expect(song()!.calls).toEqual(['load', 'seek:0:0', 'play']);
    expect(sameBytes(song()!.loaded[0]!, hvlFile)).toBe(true);
    // Play flushed the editor into the bytes: nothing was edited, so they are the same array.
    expect(currentAhxSource()).toBe(held);
  });

  it('every flush point (flush, snapshot, save, stop and Play again) leaves the bytes alone; no reload is scheduled', async () => {
    const host = setupHost();
    await playing(host, { position: 2, row: 4 });
    const held = currentAhxSource();
    const announced: AhxStructureChange[] = [];
    const off = onAhxStructureChange((change) => announced.push(change));
    const before = song()!.calls.length;
    host.trackerStore.flushAhxBytes();
    host.trackerStore.createSnapshot();
    host.trackerStore.serializeSong();
    await advance(AHX_RELOAD_MAX_WAIT_MS * 2);
    off();
    expect(announced).toEqual([]);
    expect(song()!.calls).toHaveLength(before);
    expect(currentAhxSource()).toBe(held);
    host.playbackStore.stop();
    await host.playbackStore.play(host.buildSong(), 'song', 0, 0);
    await settle();
    // The worklet already holds these bytes: no new load (a seek and a play only).
    expect(song()!.loaded).toHaveLength(1);
    expect(sameBytes(song()!.loaded[0]!, hvlFile)).toBe(true);
  });
});

describe('an edited HVL song publishes its bytes and reloads through the debounce', () => {
  it('playing: an edit on channel 10 is announced, then one burst (load-song, seek(place), play) of the edited HVL file with all its instruments', async () => {
    const host = setupHost();
    await playing(host, { position: 0, row: 6 });
    const held = currentAhxSource();
    const announced: AhxStructureChange[] = [];
    const off = onAhxStructureChange((change) => announced.push(change));
    const before = song()!.calls.length;
    editCell(host, 12);
    off();
    // The store published at once (the engine's bytes are new), the reload waits for the debounce.
    expect(announced).toHaveLength(1);
    expect(currentAhxSource()).not.toBe(held);
    expect(ahxSourceInfo.value?.format).toBe('hvl');
    await advance(AHX_RELOAD_IDLE_MS - 1);
    expect(song()!.calls).toHaveLength(before);
    await advance(1);
    expect(song()!.calls.slice(before)).toEqual(['load', 'seek:0:6', 'play']);
    const sent = song()!.loaded.at(-1)!;
    expect(sent).toBe(currentAhxSource());
    const parsed = expectWholeSong(sent);
    const track = doc(host).positions[0]!.track[LAST]!;
    expect(parsed.tracks[track]![12]).toMatchObject({ note: 25, instrument: 1 });
    // Nothing else of the song moved.
    expect(parsed.positions).toHaveLength(source.positions.length);
    expect(parsed.positions.map((p) => p.transpose)).toEqual(source.positions.map((p) => p.transpose));
  });

  it('stopped: the edit sends nothing however long the clock runs; the next Play loads the edited file once', async () => {
    const host = setupHost();
    await openHvl(host);
    await settle();
    vi.useFakeTimers();
    // What the loader handed the worklet at open is the file's own bytes.
    expect(song()!.loaded.every((bytes) => sameBytes(bytes, hvlFile))).toBe(true);
    const before = song()!.calls.length;
    editCell(host, 12);
    await advance(AHX_RELOAD_MAX_WAIT_MS * 3);
    expect(song()!.calls).toHaveLength(before);
    await host.playbackStore.play(host.buildSong(), 'song', 0, 0);
    await settle();
    expect(song()!.calls.slice(before)).toEqual(['load', 'seek:0:0', 'play']);
    expect(sameBytes(song()!.loaded.at(-1)!, hvlFile)).toBe(false);
    expectWholeSong(song()!.loaded.at(-1)!);
  });

  it('an undo while playing reloads the file\'s own structure again (still every instrument)', async () => {
    const host = setupHost();
    await playing(host, { position: 1, row: 3 });
    const before = song()!.calls.length;
    host.trackerStore.pushHistory();
    editCell(host, 12);
    await advance(AHX_RELOAD_MAX_WAIT_MS);
    expect(song()!.calls.slice(before)).toEqual(['load', 'seek:1:3', 'play']);
    host.trackerStore.undo();
    await advance(AHX_RELOAD_MAX_WAIT_MS);
    expect(song()!.calls.slice(before)).toEqual(['load', 'seek:1:3', 'play', 'load', 'seek:1:3', 'play']);
    const back = expectWholeSong(song()!.loaded.at(-1)!);
    expect(back).toEqual(source);
  });
});
