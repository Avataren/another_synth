import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { createPinia, setActivePinia, storeToRefs } from 'pinia';
import {
  PlaybackEngine,
  SID_NOTE_COUNT,
  SID_PROFILE,
  createSidPitchModel,
  profileForFormat,
  sidFreqRegToHz,
  sidNoteFreqReg,
  type PitchModel,
  type Song,
} from '@another-synth/tracker-playback';
import { useTrackerStore } from 'src/stores/tracker-store';
import { useTrackerFileIO, type TrackerFileIOContext } from 'src/composables/useTrackerFileIO';
import { useTrackerSongBuilder } from 'src/composables/useTrackerSongBuilder';
import { TrackerSongBank } from 'src/audio/tracker/song-bank';
import type AudioSystem from 'src/audio/AudioSystem';
import { decodeSidFile, parseSidFile, serializeSidFile, setSidRow, type SidDoc } from 'src/audio/tracker/sid-doc';
import { buildSidChainSong, SID_CHAIN_SONG_NAME } from './helpers/sid-chain-song';

/**
 * plan-sid-tracking.md S3: `moduleFormat: 'sid'` through the same chain as
 * 'ahx' (store / useTrackerFileIO -> song-bank.setModuleFormat ->
 * playback-song-builder -> engine), and the SID song file as the hand-off to
 * the Rust player.
 *
 * The real load path, end to end (the jt_letgo rule: nothing stands in for
 * the builder): a SidDoc made through the doc's ops is adopted by a real
 * tracker store, SAVED through the real `handleSaveSongFile` (JSZip .cmod,
 * the picker stubbed to catch the blob), LOADED from those bytes through the
 * real `loadSongFromFile` -> `loadSongFromBuffer` -> `applySongFile` into a second real store, with
 * a real `TrackerSongBank`, the real song builder and a real library
 * `PlaybackEngine`. `initializePlayback` does what `tracker-playback-store`'s
 * `loadSong` does for every non-AHX song (the only branch 'sid' can take:
 * the store routes `moduleFormat === 'ahx'` alone to the worklet):
 * `songBank.setModuleFormat(format, linearFrequency, amigaLimits)` then
 * `engine.loadSong(song)`.
 *
 * The file the second store saves is then compared byte for byte with
 * `rust-wasm/tests/fixtures/sid/s3-chain.asid`, which
 * `rust-wasm/tests/sid_song_chain.rs` parses (byte-exact both ways) and plays
 * on the real S1/S2 chip. So the chip plays exactly what this chain produced;
 * the fixture is its output, pinned, never hand-written. Regenerate it with
 * `UPDATE_SID_CHAIN_FIXTURE=1 npx vitest run src/tests/sid-format-chain.test.ts`.
 */

const FIXTURE = path.resolve(__dirname, '../../rust-wasm/tests/fixtures/sid/s3-chain.asid');

function fakeAudioSystem(): AudioSystem {
  return {
    audioContext: {
      sampleRate: 48000,
      currentTime: 0,
      state: 'running' as const,
      resume: async () => {},
      createGain: () => ({
        gain: {
          value: 1,
          setValueAtTime: vi.fn(),
          cancelScheduledValues: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          setTargetAtTime: vi.fn(),
        },
        connect: vi.fn(),
        disconnect: vi.fn(),
      }),
      destination: { connect: vi.fn() },
    },
    destinationNode: { connect: vi.fn() },
  } as unknown as AudioSystem;
}

interface Harness {
  store: ReturnType<typeof useTrackerStore>;
  bank: TrackerSongBank;
  engine: PlaybackEngine;
  io: ReturnType<typeof useTrackerFileIO>;
  notify: ReturnType<typeof vi.fn>;
  /** What `initializePlayback` last handed the engine. */
  loaded: Song[];
  setModuleFormat: ReturnType<typeof vi.spyOn>;
}

/** A fresh pinia with a real store, bank, builder, engine and file IO over them. */
function harness(): Harness {
  setActivePinia(createPinia());
  const store = useTrackerStore();
  const bank = new TrackerSongBank(fakeAudioSystem());
  const engine = new PlaybackEngine({ instrumentResolver: () => undefined } as ConstructorParameters<typeof PlaybackEngine>[0]);
  const refs = storeToRefs(store);
  const currentPattern = ref(store.patterns.find((p) => p.id === store.currentPatternId));
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
    currentPattern,
    defaultPatternRows: refs.defaultPatternRows,
    instrumentSlots: refs.instrumentSlots,
    songPatches: refs.songPatches,
    songBank: bank,
    normalizeInstrumentId: (id) => id,
    formatInstrumentId: (n) => String(n).padStart(2, '0'),
  });
  const loaded: Song[] = [];
  const setModuleFormat = vi.spyOn(bank, 'setModuleFormat');
  const notify = vi.fn();
  const ctx: TrackerFileIOContext = {
    trackerStore: store,
    songBank: bank,
    currentSong: refs.currentSong,
    playbackMode: ref<'pattern' | 'song'>('song'),
    isLoadingSong: ref(false),
    ensureActiveInstrument: vi.fn(),
    syncSongBankFromSlots: builder.syncSongBankFromSlots,
    initializePlayback: async () => {
      currentPattern.value = store.patterns.find((p) => p.id === store.currentPatternId);
      const song = builder.buildPlaybackSong('song');
      bank.setModuleFormat(song.moduleFormat, song.linearFrequency, song.amigaLimits);
      engine.loadSong(song);
      loaded.push(song);
      return true;
    },
    stopPlayback: vi.fn(),
    resetSequenceIndex: vi.fn(),
    notify,
  };
  return { store, bank, engine, io: useTrackerFileIO(ctx), notify, loaded, setModuleFormat };
}

/** Saves through the real handler; returns the .cmod bytes it wrote. */
async function saveCmod(h: Harness): Promise<ArrayBuffer | null> {
  let blob: Blob | null = null;
  vi.stubGlobal('window', {
    ...window,
    showSaveFilePicker: async () => ({
      createWritable: async () => ({
        write: async (b: Blob) => {
          blob = b;
        },
        close: async () => {},
      }),
    }),
  });
  await h.io.handleSaveSongFile();
  vi.unstubAllGlobals();
  const saved: Blob | null = blob;
  if (saved === null) return null;
  // jsdom's Blob has no `arrayBuffer`; its FileReader reads it.
  return await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(saved);
  });
}

/** The saved bytes as the file picker hands them over (jsdom's `File` has no `arrayBuffer`). */
function cmodFile(bytes: ArrayBuffer | null): File {
  if (bytes === null) throw new Error('nothing was saved');
  return { name: 'song.cmod', arrayBuffer: async () => bytes.slice(0) } as unknown as File;
}

/** The doc a store holds, as its saved file's bytes (the .cmod's `data.sidFile`). */
function savedBytes(h: Harness): Uint8Array {
  const file = h.store.serializeSong().data.sidFile;
  const decoded = decodeSidFile(file);
  if (!decoded.ok) throw new Error(decoded.reason);
  return decoded.bytes;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe("the 'sid' format profile and pitch model (GT note table)", () => {
  it('profileForFormat gives SID_PROFILE, with the SID pitch model', () => {
    expect(profileForFormat('sid')).toBe(SID_PROFILE);
    expect(SID_PROFILE.format).toBe('sid');
    expect(SID_PROFILE.pitch.kind).toBe('linear');
    // GT's pattern commands with a neutral equivalent; F = tempo, no F00 stop, no pattern arpeggio.
    expect(SID_PROFILE.effectCommands).toEqual({ 1: 'portaUp', 2: 'portaDown', 3: 'tonePorta', 4: 'vibrato' });
    expect(SID_PROFILE.plainSpeedCommandByte).toBe(0xf);
    expect(SID_PROFILE.f00StopsSong).toBe(false);
    expect(SID_PROFILE.arpeggioCommandByte).toBe(0xff);
  });

  it('the note table: the same registers the Rust player pins (C-0 278, A-4 7493, G#7 56576)', () => {
    expect(SID_NOTE_COUNT).toBe(93);
    expect(sidNoteFreqReg(0)).toBe(278);
    expect(sidNoteFreqReg(57)).toBe(7493);
    expect(sidNoteFreqReg(92)).toBe(56576);
    expect(sidFreqRegToHz(7493)).toBeCloseTo(440.0291, 4);
  });

  it('a note sounds its register; periods round-trip; larger is lower; arpeggio walks the table', () => {
    const pitch: PitchModel = createSidPitchModel();
    const periodOf = (index: number) => (92 - index) * 64;
    for (const i of [0, 12, 57, 91, 92]) {
      expect(pitch.frequencyFromPeriod(periodOf(i))).toBeCloseTo(sidFreqRegToHz(sidNoteFreqReg(i)), 9);
      expect(pitch.periodFromFrequency(sidFreqRegToHz(sidNoteFreqReg(i)))).toBeCloseTo(periodOf(i), 9);
    }
    for (const p of [1, 100.5, 3000, 5887]) {
      expect(pitch.rawPeriodFromFrequency(pitch.frequencyFromPeriod(p))).toBeCloseTo(p, 6);
      expect(pitch.frequencyFromPeriod(p + 1)).toBeLessThan(pitch.frequencyFromPeriod(p));
    }
    expect(pitch.arpeggioPeriod(periodOf(48), 7)).toBe(periodOf(55));
    expect(pitch.arpeggioPeriod(periodOf(90), 7)).toBe(0);
    expect(pitch.snapPeriod(periodOf(57) + 20)).toBe(periodOf(57));
    // Half-way between two notes the register is half-way too (a SID portamento is linear in the register).
    const mid = pitch.frequencyFromPeriod(periodOf(57) - 32);
    expect(mid).toBeCloseTo(sidFreqRegToHz((sidNoteFreqReg(57) + sidNoteFreqReg(58)) / 2), 9);
  });

  it('the song bank takes the SID pitch model from the profile, and gives it to instruments it holds', () => {
    const bank = new TrackerSongBank(fakeAudioSystem());
    const setPitchModel = vi.fn();
    (Reflect.get(bank as object, 'instruments') as Map<string, unknown>).set('01', {
      instrument: { setPitchModel },
      patchId: 'p',
      patchReuseKey: null,
      hasPortamento: false,
    });
    bank.setModuleFormat('sid');
    expect(setPitchModel).toHaveBeenCalledWith(SID_PROFILE.pitch);
  });
});

describe('a SID song through the store, the .cmod and the playback chain', () => {
  it('save -> load: the doc, grid, tempo and slots come back, and the engine plays it as SID', async () => {
    const doc = buildSidChainSong();
    const a = harness();
    a.store.adoptSidDoc(doc);
    expect(a.store.moduleFormat).toBe('sid');
    expect(a.store.sidDoc).toBe(doc);
    expect(a.store.isSidSong).toBe(true);
    // S4 opened the grid: a SID song with a doc is editable.
    expect(a.store.isReadOnly).toBe(false);
    expect(a.store.currentSong.title).toBe(SID_CHAIN_SONG_NAME);

    const cmod = await saveCmod(a);
    expect(cmod).not.toBeNull();
    expect(a.notify).not.toHaveBeenCalled();

    const b = harness();
    await b.io.loadSongFromFile(cmodFile(cmod));

    // The store: the doc is the one saved (equal, not the same object), and the grid is its projection.
    expect(b.store.moduleFormat).toBe('sid');
    expect(b.store.sidDoc).not.toBe(doc);
    expect(b.store.sidDoc).toEqual(doc);
    expect(b.store.patterns.map((p) => [p.id, p.rows])).toEqual([
      ['sid-pos-0', 16],
      ['sid-pos-1', 16],
    ]);
    expect(b.store.sequence).toEqual(['sid-pos-0', 'sid-pos-1']);
    expect([b.store.currentSong.bpm, b.store.initialSpeed]).toEqual([125, 6]);
    expect(b.store.instrumentSlots.slice(0, 5).map((s) => [s.instrumentName, s.instrumentFormat])).toEqual([
      ['Tri lead', 'sid'],
      ['Arp pulse', 'sid'],
      ['Filt saw', 'sid'],
      ['Vib lead', 'sid'],
      ['', undefined],
    ]);

    // song-bank.setModuleFormat: applySongFile's call and the playback load's, both 'sid'.
    expect(b.setModuleFormat.mock.calls.map((c) => c[0])).toEqual(['sid', 'sid']);
    expect(Reflect.get(b.bank as object, 'formatProfile')).toBe(SID_PROFILE);

    // playback-song-builder -> engine: a 'sid' PlaybackSong, and the engine's profile is SID's.
    const song = b.loaded.at(-1)!;
    expect(song.moduleFormat).toBe('sid');
    expect(song.sequence).toEqual(['sid-pos-0', 'sid-pos-1']);
    expect([song.bpm, song.initialSpeed]).toEqual([125, 6]);
    expect(b.engine.getModuleFormat()).toBe('sid');
    expect(b.engine.getFormatProfile()).toBe(SID_PROFILE);
    // The first step of voice 1 is A-4 at the chip's own pitch.
    const step = song.patterns[0]!.tracks[0]!.steps.find((s) => s.row === 0)!;
    expect(step.midi).toBe(69);
    expect(step.frequency).toBeCloseTo(440.0291, 4);
  });

  it('the file the chain saves is the Rust fixture, byte for byte (the chip plays exactly this)', async () => {
    const a = harness();
    a.store.adoptSidDoc(buildSidChainSong());
    const cmod = await saveCmod(a);
    const b = harness();
    await b.io.loadSongFromFile(cmodFile(cmod));
    const bytes = savedBytes(b);
    // Save -> load -> save is byte-exact.
    expect(bytes).toEqual(savedBytes(a));
    if (process.env.UPDATE_SID_CHAIN_FIXTURE === '1') {
      fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
      fs.writeFileSync(FIXTURE, bytes);
    }
    expect(new Uint8Array(fs.readFileSync(FIXTURE))).toEqual(bytes);
    // And it is the chain song's own file: the model, the tag and every table.
    expect(parseSidFile(bytes)).toEqual(buildSidChainSong());
    expect(bytes[5]).toBe(1); // 6581
  });

  it('edit -> save -> load: an op on the loaded doc survives the round trip', async () => {
    const a = harness();
    a.store.adoptSidDoc(buildSidChainSong());
    const edited = setSidRow(a.store.sidDoc as SidDoc, 2, 3, { note: 30, instrument: 1, command: 0xd, param: 0x0a });
    if (!edited.ok) throw new Error(edited.reason);
    a.store.commitSidDoc(edited.doc);
    expect(a.store.sidDoc).toBe(edited.doc);
    // The grid follows the doc: voice 3's row 3 (twice: the pattern repeats).
    expect(a.store.patterns[0]!.tracks[2]!.entries.find((e) => e.row === 3)).toMatchObject({ macro: 'D0A', instrument: '01' });

    const b = harness();
    await b.io.loadSongFromFile(cmodFile(await saveCmod(a)));
    expect(b.store.sidDoc).toEqual(edited.doc);
    expect(savedBytes(b)).toEqual(serializeSidFile(edited.doc));
  });

  it('a SID song whose doc did not load is refused on save, with a notice, and plays nothing new', async () => {
    const a = harness();
    a.store.adoptSidDoc(buildSidChainSong());
    const file = a.store.serializeSong();
    delete file.data.sidFile;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const b = harness();
    b.store.loadSongFile(file);
    expect(b.store.moduleFormat).toBe('sid');
    expect(b.store.sidDoc).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/no embedded song file/));
    expect(await saveCmod(b)).toBeNull();
    expect(b.notify).toHaveBeenCalledWith("This SID song can't be saved: its song data didn't load.");
    // A corrupt file is kept as a display too.
    b.store.loadSongFile({ ...file, data: { ...file.data, sidFile: btoa('ASID') } });
    expect(b.store.sidDoc).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/embedded file is unusable/));
    warn.mockRestore();
  });

  it('a SID song keeps three voices; loading or resetting another song clears the doc; other songs carry no sidFile', () => {
    const h = harness();
    h.store.adoptSidDoc(buildSidChainSong());
    expect(h.store.addTrack()).toBe(false);
    expect(h.store.removeTrack(2)).toBe(false);
    h.store.resetToNewSong();
    expect(h.store.sidDoc).toBeNull();
    expect(h.store.moduleFormat).toBe('native');
    expect(h.store.isReadOnly).toBe(false);
    const native = h.store.serializeSong();
    expect(native.data.sidFile).toBeUndefined();
    expect(native.data.moduleFormat).toBe('native');
    h.store.adoptSidDoc(buildSidChainSong());
    h.store.loadSongFile(native);
    expect(h.store.sidDoc).toBeNull();
    expect(h.store.moduleFormat).toBe('native');
  });
});
