import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import {
  useTrackerStore,
  CURRENT_SONG_FILE_VERSION,
  type TrackerSongFile,
  type SerializedInstrumentSlot,
  type InstrumentSlot,
} from 'src/stores/tracker-store';
import type { Patch } from 'src/audio/types/preset-types';
import { createDefaultPatchMetadata, createEmptySynthState } from 'src/audio/types/preset-types';

function slot(n: number, o: Partial<SerializedInstrumentSlot> = {}): InstrumentSlot {
  // Old files hold the legacy 'mod' type; the cast is the loader's input contract.
  return { slot: n, bankName: '', patchName: '', instrumentName: '', ...o } as InstrumentSlot;
}

function patch(id: string, instrumentType?: 'synth' | 'sampler' | 'mod'): Patch {
  const metadata = createDefaultPatchMetadata(id);
  metadata.id = id;
  if (instrumentType) metadata.instrumentType = instrumentType;
  return { metadata, synthState: createEmptySynthState(), audioAssets: {} };
}

function file(
  version: TrackerSongFile['version'],
  data: Partial<TrackerSongFile['data']>,
): TrackerSongFile {
  return {
    version,
    data: {
      currentSong: { title: 'T', author: 'A', bpm: 120 },
      patternRows: 64,
      stepSize: 1,
      patterns: [],
      sequence: [],
      currentPatternId: null,
      instrumentSlots: [],
      activeInstrumentId: null,
      currentInstrumentPage: 0,
      songPatches: {},
      ...data,
    },
  };
}

describe('song file v4: instrument tags', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('is version 4', () => {
    expect(CURRENT_SONG_FILE_VERSION).toBe(4);
  });

  it.each([
    [3, 'protracker'],
    [3, 'xm'],
    [3, 's3m'],
    [2, 'protracker'],
  ] as const)("migrates a v%i 'mod' slot in a %s song to sampler/%s", (version, format) => {
    const store = useTrackerStore();
    store.loadSongFile(
      file(version, {
        moduleFormat: format,
        instrumentSlots: [slot(1, { instrumentType: 'mod', patchId: 'p1' })],
        songPatches: { p1: patch('p1', 'mod') },
      }),
    );
    const s = store.instrumentSlots[0]!;
    expect(s.instrumentType).toBe('sampler');
    expect(s.instrumentFormat).toBe(format);
    // The patch's own alias is rewritten too.
    expect(store.songPatches.p1?.metadata.instrumentType).toBe('sampler');
  });

  it("migrates a v1 'mod' song (no moduleFormat) to sampler/protracker", () => {
    const store = useTrackerStore();
    store.loadSongFile(
      file(1, { instrumentSlots: [slot(1, { instrumentType: 'mod', patchId: 'p1' })] }),
    );
    expect(store.moduleFormat).toBe('protracker');
    expect(store.instrumentSlots[0]).toMatchObject({
      instrumentType: 'sampler',
      instrumentFormat: 'protracker',
    });
  });

  it('migrates synth and untyped patch slots to synth/native, empty slots stay untagged', () => {
    const store = useTrackerStore();
    store.loadSongFile(
      file(3, {
        instrumentSlots: [
          slot(1, { instrumentType: 'synth', patchId: 'a' }),
          slot(2, { patchId: 'b' }),
        ],
        songPatches: { a: patch('a', 'synth'), b: patch('b') },
      }),
    );
    for (const i of [0, 1]) {
      expect(store.instrumentSlots[i]).toMatchObject({
        instrumentType: 'synth',
        instrumentFormat: 'native',
      });
    }
    expect(store.instrumentSlots[2]!.instrumentType).toBeUndefined();
    expect(store.instrumentSlots[2]!.instrumentFormat).toBeUndefined();
  });

  it("migrates an AdLib slot ('mod' + oplData, no patch) to opl/s3m and keeps its data", () => {
    const store = useTrackerStore();
    const oplData = { kind: 'melody' as const, registers: [0x20, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
    store.loadSongFile(
      file(3, {
        moduleFormat: 's3m',
        instrumentSlots: [slot(1, { instrumentType: 'mod', oplData: oplData as never })],
      }),
    );
    expect(store.instrumentSlots[0]).toMatchObject({
      instrumentType: 'opl',
      instrumentFormat: 's3m',
    });
    expect(store.instrumentSlots[0]!.patchId).toBeUndefined();
    expect(store.instrumentSlots[0]!.oplData).toEqual(oplData);
  });

  it('round-trips v4 tags through serialize and load', () => {
    const store = useTrackerStore();
    store.loadSongFile(
      file(3, {
        moduleFormat: 'xm',
        instrumentSlots: [slot(1, { instrumentType: 'mod', patchId: 'p1' })],
        songPatches: { p1: patch('p1', 'mod') },
      }),
    );
    const saved = store.serializeSong();
    expect(saved.version).toBe(4);
    expect(saved.data.instrumentSlots[0]).toMatchObject({
      instrumentType: 'sampler',
      instrumentFormat: 'xm',
    });
    store.resetToNewSong();
    store.loadSongFile(JSON.parse(JSON.stringify(saved)));
    expect(store.instrumentSlots[0]).toMatchObject({
      instrumentType: 'sampler',
      instrumentFormat: 'xm',
    });
  });

  it('stamps synth/native on a patch assigned to a slot, and clears the tags with the slot', () => {
    const store = useTrackerStore();
    store.assignPatchToSlot(1, patch('n1'), 'Song');
    expect(store.instrumentSlots[0]).toMatchObject({
      instrumentType: 'synth',
      instrumentFormat: 'native',
    });
    store.clearSlot(1);
    expect(store.instrumentSlots[0]!.instrumentType).toBeUndefined();
    expect(store.instrumentSlots[0]!.instrumentFormat).toBeUndefined();
  });

  it("re-tags a module slot when a synth patch replaces it (no stale 'sampler')", () => {
    const store = useTrackerStore();
    store.loadSongFile(
      file(3, {
        moduleFormat: 'xm',
        instrumentSlots: [slot(1, { instrumentType: 'mod', patchId: 'p1' })],
        songPatches: { p1: patch('p1', 'mod') },
      }),
    );
    store.assignPatchToSlot(1, patch('n1'), 'Song');
    expect(store.instrumentSlots[0]).toMatchObject({
      instrumentType: 'synth',
      instrumentFormat: 'native',
    });
  });
});
