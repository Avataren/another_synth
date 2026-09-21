// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia, storeToRefs } from 'pinia';

/**
 * T5 of the AHX editing plan: how an edit to an editable AHX song reaches the
 * engine. The real tracker store, playback store, `AhxTransport`, `AhxPreview`,
 * reload scheduler and edit registry, opened through the real file loader; only
 * the worklet client under the transport (and the preview) is a fake that
 * records what it is sent, in order. Timers are faked after the song is open,
 * so the debounce is read off the clock, not slept through.
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
        return { name: 'x', positionCount: 26, trackLength: 64, channels: 4, droppedChannels: 0, sampleRate: 44100 };
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
  currentAhxSource,
  onAhxStructureChange,
  setCurrentAhxSource,
  type AhxStructureChange,
} from 'src/audio/tracker/ahx-source';
import { ahxNotices, clearAhxNotices, reportAhxNotice } from 'src/audio/tracker/ahx-notices';
import { ahxEditNotice, clearAhxEditNotice } from 'src/audio/tracker/ahx-edit-notice';
import { setAhxNumber } from 'src/audio/tracker/ahx-instrument-edit';
import { AHX_RELOAD_IDLE_MS, AHX_RELOAD_MAX_WAIT_MS } from 'src/audio/tracker/ahx-reload';
import { deletePosition, insertPosition, movePosition, projectAhxPatterns, setStep, type AhxDoc } from 'src/audio/tracker/ahx-doc';
import { parseAhx, type Song } from '@another-synth/tracker-playback';

const karmaBytes = fs.readFileSync(path.resolve(__dirname, '../../public/demos/ahx/karma.ahx'));

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

async function openKarma(host: Host) {
  const file = await host.fileIO.parseSongBuffer(
    karmaBytes.buffer.slice(karmaBytes.byteOffset, karmaBytes.byteOffset + karmaBytes.byteLength) as ArrayBuffer,
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
const preview = () => h.clients.find((c) => c.isPreview && !c.disposed) as FakeClient | undefined;
const loads = (c: FakeClient | undefined) => (c?.calls ?? []).filter((x) => x === 'load').length;

/** The song is open (real timers, the loader has some of its own), playing, and the clock is the test's. */
async function playing(host: Host, at?: { position: number; row: number }) {
  await openKarma(host);
  await settle();
  vi.useFakeTimers();
  await host.playbackStore.play(host.buildSong(), 'song', 0, 0);
  await settle();
  if (at) song()!.emitPosition(at);
}

/** A cell edit as the grid makes it: the track's entries replaced, written back at once. */
function editCell(host: Host, row: number, position = 0, channel = 0) {
  const track = host.trackerStore.patterns[position]!.tracks[channel]!;
  track.entries = [...track.entries.filter((e) => e.row !== row), { row, note: 'C-3', instrument: '01' }];
  host.trackerStore.syncAhxWriteBack();
}

/** A position op the way the position panel will make it: the doc committed with its map, the grid re-projected. */
function commitOp(
  host: Host,
  result: { ok: true; doc: AhxDoc; mapPosition: (old: number) => number | null } | { ok: false; reason: string },
) {
  if (!result.ok) throw new Error(result.reason);
  const store = host.trackerStore;
  store.commitAhxDoc(result.doc, { mapPosition: result.mapPosition });
  store.patterns = projectAhxPatterns(result.doc);
  store.sequence = store.patterns.map((p) => p.id);
  store.primeAhxWriteBack();
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

describe('what the store tells the engine path (structureListeners)', () => {
  it('a doc commit announces itself with its flags and its map; a flush of what already sounds does not', async () => {
    const host = setupHost();
    await openKarma(host);
    await settle();
    const seen: AhxStructureChange[] = [];
    const off = onAhxStructureChange((change) => seen.push(change));
    try {
      editCell(host, 12);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ instrumentsChanged: false, resetEdits: false });
      expect(seen[0]!.mapPosition).toBeUndefined();

      const removed = deletePosition(doc(host), 2);
      commitOp(host, removed);
      expect(seen).toHaveLength(2);
      expect(seen[1]!.mapPosition?.(5)).toBe(4);
      expect(seen[1]!.mapPosition?.(2)).toBeNull();

      const slot = host.trackerStore.instrumentSlots.find((s) => s.slot === 16)!;
      host.trackerStore.updateAhxInstrument(16, setAhxNumber(slot.ahxData!, 'volume', 3));
      host.trackerStore.flushAhxBytes();
      // The bytes moved (the slots feed them) but nothing structural happened.
      expect(seen).toHaveLength(2);
    } finally {
      off();
    }
  });

  it('a commit that leaves the bytes as they were tells nobody', async () => {
    const host = setupHost();
    await openKarma(host);
    await settle();
    const seen: AhxStructureChange[] = [];
    const off = onAhxStructureChange((change) => seen.push(change));
    try {
      const before = currentAhxSource();
      host.trackerStore.flushAhxBytes();
      host.trackerStore.commitAhxDoc(doc(host));
      expect(currentAhxSource()).toBe(before);
      expect(seen).toHaveLength(0);
    } finally {
      off();
    }
  });
});

describe('stopped and paused: nothing is sent, the next Play loads', () => {
  it('stopped: an edit sends nothing, however long the clock runs; Play then loads once, seeks, plays', async () => {
    const host = setupHost();
    await openKarma(host);
    await settle();
    vi.useFakeTimers();
    const before = song()!.calls.length;
    editCell(host, 12);
    await advance(AHX_RELOAD_MAX_WAIT_MS * 3);
    expect(song()!.calls).toHaveLength(before);
    await host.playbackStore.play(host.buildSong(), 'song', 0, 0);
    await settle();
    expect(song()!.calls.slice(before)).toEqual(['load', 'seek:0:0', 'play']);
    expect(parseAhx(song()!.loaded.at(-1)!).tracks.length).toBeGreaterThan(0);
  });

  it('paused: an edit sends nothing; Play loads what the grid shows (the bytes changed, so it is no resume)', async () => {
    const host = setupHost();
    await playing(host, { position: 3, row: 8 });
    host.playbackStore.pause();
    const before = song()!.calls.length;
    editCell(host, 12);
    await advance(AHX_RELOAD_MAX_WAIT_MS * 2);
    expect(song()!.calls).toHaveLength(before);
    await host.playbackStore.play(host.buildSong(), 'song', 8, 3);
    await settle();
    expect(song()!.calls.slice(before)).toEqual(['load', 'seek:3:8', 'play']);
  });

  it('paused with no edit: Play resumes in place, sending no load and no seek', async () => {
    const host = setupHost();
    await playing(host, { position: 3, row: 8 });
    host.playbackStore.pause();
    const before = song()!.calls.length;
    await host.playbackStore.play(host.buildSong(), 'song', 8, 3);
    await settle();
    expect(song()!.calls.slice(before)).toEqual(['play']);
  });

  it('paused: an edit and then a resume() reloads at the place it was paused at, in one burst', async () => {
    const host = setupHost();
    await playing(host, { position: 3, row: 8 });
    host.playbackStore.pause();
    const before = song()!.calls.length;
    editCell(host, 12);
    await host.playbackStore.resume();
    await settle();
    expect(song()!.calls.slice(before)).toEqual(['play', 'load', 'seek:3:8', 'play']);
  });
});

describe('playing: one burst, in order, no await in between', () => {
  it('waits for the edits to stop, then sends load-song, seek(place), play together', async () => {
    const host = setupHost();
    await playing(host, { position: 4, row: 10 });
    const before = song()!.calls.length;
    let release: () => void = () => {};
    h.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    editCell(host, 12);
    await advance(AHX_RELOAD_IDLE_MS - 1);
    expect(song()!.calls).toHaveLength(before);
    await advance(1);
    // The load has not been answered (the worklet is prewarming), and the seek and the play are already sent.
    expect(song()!.calls.slice(before)).toEqual(['load', 'seek:4:10', 'play']);
    release();
    await settle();
    expect(song()!.calls.slice(before)).toEqual(['load', 'seek:4:10', 'play']);
    // The song it was handed is the edited one.
    const sent = parseAhx(song()!.loaded.at(-1)!);
    const track = doc(host).positions[0]!.track[0]!;
    expect(sent.tracks[track]![12]).toMatchObject({ note: 25, instrument: 1 });
  });

  it('N edits inside the debounce are one burst, sent after the last', async () => {
    const host = setupHost();
    await playing(host, { position: 1, row: 0 });
    const before = loads(song());
    for (const row of [3, 6, 9, 12, 15]) {
      editCell(host, row);
      await advance(AHX_RELOAD_IDLE_MS - 50);
    }
    expect(loads(song())).toBe(before);
    await advance(50);
    expect(loads(song())).toBe(before + 1);
    // All five are in it.
    const sent = parseAhx(song()!.loaded.at(-1)!);
    const track = doc(host).positions[0]!.track[0]!;
    for (const row of [3, 6, 9, 12, 15]) expect(sent.tracks[track]![row]!.note).toBe(25);
    await advance(AHX_RELOAD_MAX_WAIT_MS);
    expect(loads(song())).toBe(before + 1);
  });

  it('a steady run of edits cannot put the burst off past the max wait', async () => {
    const host = setupHost();
    await playing(host, { position: 1, row: 0 });
    const before = loads(song());
    // An edit every 300 ms (inside the 350 ms idle): only the max wait can end it.
    let elapsed = 0;
    let row = 0;
    while (elapsed < AHX_RELOAD_MAX_WAIT_MS - 300) {
      editCell(host, row++ % 60);
      await advance(300);
      elapsed += 300;
      expect(loads(song())).toBe(before);
    }
    editCell(host, 61);
    await advance(AHX_RELOAD_MAX_WAIT_MS - elapsed);
    expect(loads(song())).toBe(before + 1);
  });

  it('an edit that changes no byte sends nothing, and a flush with nothing new keeps the current bytes', async () => {
    const host = setupHost();
    await playing(host, { position: 1, row: 0 });
    const before = loads(song());
    const bytes = currentAhxSource();
    const track = host.trackerStore.patterns[0]!.tracks[0]!;
    track.entries = track.entries.map((entry) => ({ ...entry }));
    host.trackerStore.syncAhxWriteBack();
    host.trackerStore.flushAhxBytes();
    await advance(AHX_RELOAD_MAX_WAIT_MS);
    expect(loads(song())).toBe(before);
    expect(currentAhxSource()).toBe(bytes);
  });

  it('a live instrument-parameter edit reloads nothing, but the bytes it left behind are one load at the next Play (dropout stated, review N2)', async () => {
    const host = setupHost();
    await playing(host, { position: 2, row: 4 });
    const before = loads(song());
    const slot = host.trackerStore.instrumentSlots.find((s) => s.slot === 16)!;
    const bytes = currentAhxSource();
    host.trackerStore.updateAhxInstrument(16, setAhxNumber(slot.ahxData!, 'volume', 7));
    host.trackerStore.flushAhxBytes();
    // The flush swapped `current` (the slots feed the bytes) and reloaded nothing.
    expect(currentAhxSource()).not.toBe(bytes);
    await advance(AHX_RELOAD_MAX_WAIT_MS);
    expect(loads(song())).toBe(before);
    host.playbackStore.pause();
    await host.playbackStore.play(host.buildSong(), 'song', 4, 2);
    await settle();
    expect(loads(song())).toBe(before + 1);

    // With nothing changed since, Pause / Play is a resume in place: no load.
    host.playbackStore.pause();
    await host.playbackStore.play(host.buildSong(), 'song', 4, 2);
    await settle();
    expect(loads(song())).toBe(before + 1);
  });

  it('an undo while playing is a full reset reload: the recorded instrument edits are not sent', async () => {
    const host = setupHost();
    await playing(host, { position: 2, row: 0 });
    const slot = host.trackerStore.instrumentSlots.find((s) => s.slot === 16)!;
    host.trackerStore.updateAhxInstrument(16, setAhxNumber(slot.ahxData!, 'volume', 9));
    host.trackerStore.pushHistory();
    editCell(host, 12);
    await advance(AHX_RELOAD_IDLE_MS);
    const before = loads(song());
    host.trackerStore.undo();
    await advance(AHX_RELOAD_IDLE_MS);
    expect(loads(song())).toBe(before + 1);
    expect(song()!.calls.slice(-3)).toEqual(['load', 'seek:2:0', 'play']);
  });
});

describe('position ops move the place, once, at burst time', () => {
  it('an op moves the place the burst seeks to', async () => {
    const host = setupHost();
    await playing(host, { position: 5, row: 3 });
    const before = song()!.calls.length;
    commitOp(host, deletePosition(doc(host), 2));
    await advance(AHX_RELOAD_IDLE_MS);
    expect(song()!.calls.slice(before)).toEqual(['load', 'seek:4:3', 'play']);
  });

  it('several ops coalesced into one burst apply their composed map, once', async () => {
    const host = setupHost();
    await playing(host, { position: 5, row: 3 });
    const before = song()!.calls.length;
    commitOp(host, deletePosition(doc(host), 2)); // 5 -> 4
    await advance(100);
    commitOp(host, deletePosition(doc(host), 1)); // 4 -> 3
    await advance(100);
    commitOp(host, insertPosition(doc(host), 0, { kind: 'blank' })); // 3 -> 4
    await advance(100);
    commitOp(host, movePosition(doc(host), 4, 0)); // 4 -> 0
    await advance(AHX_RELOAD_IDLE_MS);
    expect(song()!.calls.slice(before)).toEqual(['load', 'seek:0:3', 'play']);
  });

  it('a position deleted under the playhead lands on row 0 of the one now at that index, whatever comes after', async () => {
    const host = setupHost();
    await playing(host, { position: 5, row: 7 });
    const before = song()!.calls.length;
    commitOp(host, deletePosition(doc(host), 5));
    await advance(50);
    commitOp(host, insertPosition(doc(host), 0, { kind: 'blank' })); // null stays null
    await advance(AHX_RELOAD_IDLE_MS);
    expect(song()!.calls.slice(before)).toEqual(['load', 'seek:5:0', 'play']);
  });

  it('a place past the end of a shorter song is clamped to its last position', async () => {
    const host = setupHost();
    await openKarma(host);
    await settle();
    const last = doc(host).positions.length - 1;
    vi.useFakeTimers();
    await host.playbackStore.play(host.buildSong(), 'song', 0, 0);
    await settle();
    song()!.emitPosition({ position: last, row: 2 });
    const before = song()!.calls.length;
    commitOp(host, deletePosition(doc(host), last));
    await advance(AHX_RELOAD_IDLE_MS);
    expect(song()!.calls.slice(before)).toEqual(['load', `seek:${last - 1}:0`, 'play']);
  });

  it('during the debounce a worklet report highlights the remapped pattern, not the re-projected one', async () => {
    const host = setupHost();
    await playing(host, { position: 4, row: 0 });
    const playback = host.playbackStore;
    commitOp(host, deletePosition(doc(host), 2));
    // The worklet still plays the old song: its position 4 is the editor's 3.
    song()!.emitPosition({ position: 4, row: 9 });
    expect(playback.currentSequenceIndex).toBe(3);
    expect(host.trackerStore.currentPatternId).toBe(host.trackerStore.sequence[3]);
    // The position that was deleted has no place in the new order: no highlight rather than a wrong one.
    song()!.emitPosition({ position: 2, row: 1 });
    expect(playback.currentSequenceIndex).toBe(3);
    // Positions before the deleted one are where they were.
    song()!.emitPosition({ position: 1, row: 1 });
    expect(playback.currentSequenceIndex).toBe(1);
  });

  it('the highlight map holds while the reload is in flight and lets go when the new song answers', async () => {
    const host = setupHost();
    await playing(host, { position: 4, row: 0 });
    let release: () => void = () => {};
    h.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    commitOp(host, deletePosition(doc(host), 2));
    await advance(AHX_RELOAD_IDLE_MS);
    // Sent, not answered: reports are still the old song's.
    song()!.emitPosition({ position: 4, row: 2 });
    expect(host.playbackStore.currentSequenceIndex).toBe(3);
    release();
    await settle();
    // The new song reports in its own terms.
    song()!.emitPosition({ position: 4, row: 3 });
    expect(host.playbackStore.currentSequenceIndex).toBe(4);
  });

  it('currentPatternId follows the op, and a deleted current position falls to the one now at its index', async () => {
    const host = setupHost();
    await openKarma(host);
    await settle();
    host.trackerStore.currentPatternId = 'ahx-pos-4';
    commitOp(host, deletePosition(doc(host), 2));
    expect(host.trackerStore.currentPatternId).toBe('ahx-pos-3');
    host.trackerStore.currentPatternId = 'ahx-pos-3';
    commitOp(host, deletePosition(doc(host), 3));
    expect(host.trackerStore.currentPatternId).toBe('ahx-pos-3');
    const last = doc(host).positions.length - 1;
    host.trackerStore.currentPatternId = `ahx-pos-${last}`;
    commitOp(host, deletePosition(doc(host), last));
    expect(host.trackerStore.currentPatternId).toBe(`ahx-pos-${last - 1}`);
  });

  it('not playing, the selection moves with the op (nothing else would move it)', async () => {
    const host = setupHost();
    await openKarma(host);
    await settle();
    host.playbackStore.setSequenceIndex(6);
    commitOp(host, deletePosition(doc(host), 2));
    expect(host.playbackStore.currentSequenceIndex).toBe(5);
    commitOp(host, insertPosition(doc(host), 0, { kind: 'blank' }));
    expect(host.playbackStore.currentSequenceIndex).toBe(6);
  });
});

describe('the keyboard preview has its own bytes (review B2)', () => {
  it('a cell edit and a key press do not reload the preview, nor dispose it; an added instrument does once; an undo does once', async () => {
    const host = setupHost();
    await playing(host, { position: 1, row: 0 });
    await host.playbackStore.previewAhxNoteOn(1, 60);
    await settle();
    const p = preview()!;
    expect(loads(p)).toBe(1);

    editCell(host, 12);
    await advance(AHX_RELOAD_IDLE_MS);
    await host.playbackStore.previewAhxNoteOn(1, 62);
    await settle();
    expect(loads(p)).toBe(1);
    editCell(host, 14);
    await advance(AHX_RELOAD_IDLE_MS);
    await host.playbackStore.previewAhxNoteOn(1, 64);
    await settle();
    expect(loads(p)).toBe(1);
    expect(p.disposed).toBe(false);
    expect(preview()).toBe(p);

    // An instrument added: the list the preview plays from changed.
    const next = setStep(doc(host), doc(host).positions[0]!.track[0]!, 20, { note: 20, instrument: 1, fx: 0, fxParam: 0, fxb: 0, fxbParam: 0 });
    if (!next.ok) throw new Error(next.reason);
    host.trackerStore.commitAhxDoc(next.doc, { instrumentsChanged: true });
    await settle();
    expect(loads(p)).toBe(2);
    await host.playbackStore.previewAhxNoteOn(1, 60);
    await settle();
    expect(loads(p)).toBe(2);

    // An undo starts the instruments over.
    host.trackerStore.pushHistory();
    editCell(host, 30);
    host.trackerStore.undo();
    await settle();
    expect(loads(p)).toBe(3);
    await host.playbackStore.previewAhxNoteOn(1, 60);
    await settle();
    expect(loads(p)).toBe(3);
  });

  it('a different song still disposes the preview (the "same song" rule is only for structure edits)', async () => {
    const host = setupHost();
    await playing(host, { position: 1, row: 0 });
    await host.playbackStore.previewAhxNoteOn(1, 60);
    await settle();
    const p = preview()!;
    setCurrentAhxSource(new Uint8Array(karmaBytes.subarray(0, karmaBytes.length - 1)));
    await settle();
    expect(p.disposed).toBe(true);
  });
});

describe('races: a reload that is no longer wanted drops itself', () => {
  it('stop during the debounce: no burst', async () => {
    const host = setupHost();
    await playing(host, { position: 1, row: 0 });
    const before = song()!.calls.length;
    editCell(host, 12);
    await advance(AHX_RELOAD_IDLE_MS - 100);
    host.playbackStore.stop();
    await advance(AHX_RELOAD_MAX_WAIT_MS);
    expect(song()!.calls.slice(before).filter((c) => c === 'load')).toEqual([]);
    expect(host.playbackStore.isPlaying).toBe(false);
  });

  it('pause during the debounce: no burst, and the next Play loads', async () => {
    const host = setupHost();
    await playing(host, { position: 1, row: 0 });
    const before = loads(song());
    editCell(host, 12);
    host.playbackStore.pause();
    await advance(AHX_RELOAD_MAX_WAIT_MS);
    expect(loads(song())).toBe(before);
    await host.playbackStore.play(host.buildSong(), 'song', 0, 1);
    await settle();
    expect(loads(song())).toBe(before + 1);
  });

  it('stop while the reload is in flight: the answer changes nothing', async () => {
    const host = setupHost();
    await playing(host, { position: 1, row: 0 });
    let release: () => void = () => {};
    h.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    editCell(host, 12);
    await advance(AHX_RELOAD_IDLE_MS);
    host.playbackStore.stop();
    release();
    await settle();
    expect(host.playbackStore.isPlaying).toBe(false);
    expect(host.playbackStore.isPaused).toBe(false);
  });

  it('a different song while an edit is waiting: the reload is not sent', async () => {
    const host = setupHost();
    await playing(host, { position: 1, row: 0 });
    const before = loads(song());
    editCell(host, 12);
    setCurrentAhxSource(null);
    await advance(AHX_RELOAD_MAX_WAIT_MS);
    expect(loads(song())).toBe(before);
  });

  it('an edit that lands while Play is loading is reloaded once playing', async () => {
    const host = setupHost();
    await openKarma(host);
    await settle();
    vi.useFakeTimers();
    const before = loads(song());
    let release: () => void = () => {};
    h.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    editCell(host, 11);
    const started = host.playbackStore.play(host.buildSong(), 'song', 0, 0);
    await settle();
    editCell(host, 12);
    h.gate = null;
    release();
    await started;
    await settle();
    // The first load carried the first edit; the second was made during it.
    expect(loads(song())).toBe(before + 2);
    const sent = parseAhx(song()!.loaded.at(-1)!);
    const track = doc(host).positions[0]!.track[0]!;
    expect(sent.tracks[track]![12]!.note).toBe(25);
  });
});

describe('what the seek said', () => {
  it('kind 2 after a reload is told to the user; kind 1, and a seek that is no reload, are not', async () => {
    const host = setupHost();
    await playing(host, { position: 1, row: 0 });
    editCell(host, 12);
    await advance(AHX_RELOAD_IDLE_MS);
    song()!.emitPosition({ position: 1, row: 0, seekKind: 1 });
    expect(ahxEditNotice.value).toBeNull();

    editCell(host, 14);
    await advance(AHX_RELOAD_IDLE_MS);
    song()!.emitPosition({ position: 1, row: 0, seekKind: 2 });
    expect(ahxEditNotice.value?.message).toMatch(/no longer reaches the row that was playing/);

    clearAhxEditNotice();
    song()!.emitPosition({ position: 1, row: 4, seekKind: 2 });
    expect(ahxEditNotice.value).toBeNull();
  });
});

describe('a reload the engine refuses', () => {
  it('puts the last accepted version back in the same burst shape, says so, and clears only its own notice once a reload is accepted', async () => {
    const host = setupHost();
    await playing(host, { position: 3, row: 5 });
    reportAhxNotice('Some other problem the instrument page lists.');
    const acceptedBytes = song()!.loaded.at(-1)!;
    const before = song()!.calls.length;
    h.refuse = 1;
    editCell(host, 12);
    await advance(AHX_RELOAD_IDLE_MS);
    expect(song()!.calls.slice(before)).toEqual(['load', 'seek:3:5', 'play', 'load', 'seek:3:5', 'play']);
    // The recovery loaded the version the engine had accepted.
    expect(song()!.loaded.at(-1)).toBe(acceptedBytes);
    expect(ahxNotices.value.some((n) => /could not be loaded by the engine/.test(n))).toBe(true);
    expect(host.playbackStore.isPlaying).toBe(true);

    // The next edit is accepted: the recovery notice goes, the other one stays.
    editCell(host, 14);
    await advance(AHX_RELOAD_IDLE_MS);
    expect(ahxNotices.value.some((n) => /could not be loaded by the engine/.test(n))).toBe(false);
    expect(ahxNotices.value).toContain('Some other problem the instrument page lists.');
  });

  it('refused twice: playback stops, the notice says so, and nothing loops', async () => {
    const host = setupHost();
    await playing(host, { position: 3, row: 5 });
    const before = loads(song());
    h.refuse = 2;
    editCell(host, 12);
    await advance(AHX_RELOAD_IDLE_MS);
    await advance(AHX_RELOAD_MAX_WAIT_MS * 2);
    expect(loads(song())).toBe(before + 2);
    expect(host.playbackStore.isPlaying).toBe(false);
    expect(ahxNotices.value.some((n) => /playback stopped/.test(n))).toBe(true);
  });

  it('while the grid and the sound disagree, the highlight still follows the old song through the map', async () => {
    const host = setupHost();
    await playing(host, { position: 4, row: 0 });
    h.refuse = 1;
    commitOp(host, deletePosition(doc(host), 2));
    await advance(AHX_RELOAD_IDLE_MS);
    // The worklet plays the old song again: its position 4 is still the editor's 3.
    song()!.emitPosition({ position: 4, row: 6 });
    expect(host.playbackStore.currentSequenceIndex).toBe(3);
  });
});
