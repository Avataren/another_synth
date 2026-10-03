import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
// Relative on purpose: the `app/public/wasm/audio_processor.js` alias is
// mocked for every other test, and this one is about the real bytes.
import { A2Player, a2m_from_json, a2m_new_json, a2m_to_json, initSync } from '../../public/wasm/audio_processor.js';
import { a2mEntrySignature, type TrackerEntryData } from '@another-synth/tracker-playback';
import {
  a2mBytesFromSong,
  a2mSongFromBytes,
  a2mText,
  setA2mCodecBackend,
  type A2mSongJson,
} from 'src/audio/tracker/a2m-codec';
import {
  a2mCellToEntry,
  a2mEntryToCell,
  a2mGridOf,
  a2mLayout,
  compileA2mSong,
  parseA2mEffectColumn,
} from 'src/audio/tracker/a2m-grid';
import {
  decodeA2mFm,
  defaultA2mInstrument,
  encodeA2mFm,
  isEmptyA2mInstrument,
} from 'src/audio/tracker/a2m-instrument';
import { buildA2mTrackerSong, createNewA2mTrackerSong, upgradeLegacyA2mSongFile } from 'src/audio/tracker/a2m-import';
import { encodeA2mFile } from 'src/audio/tracker/a2m-file-codec';
import { a2mNoteOffRegisters, a2mNoteOnRegisters, a2mPitch } from 'src/audio/tracker/a2m-audition';
import { a2mExporter } from 'src/audio/tracker/song-export/a2m-exporter';
import { SONG_EXPORTERS, getSongExporter } from 'src/audio/tracker/song-export/registry';
import { useTrackerStore } from 'src/stores/tracker-store';

/**
 * Adlib Tracker II editing and export (the work after .ai/plan-opl.md O7):
 * the corpus survives the app's own import -> grid -> compile -> write path,
 * a song can be made from nothing, an instrument edit is heard, and what is
 * exported opens again as the same song.
 *
 * The Rust side has its own gates (`cargo test --lib opl::a2`: parse -> write
 * -> parse over the corpus, AdPlug-identical register traces, the register
 * writes of an edited instrument); this is the TypeScript half over the same
 * real wasm.
 */

const ROOT = resolve(__dirname, '../..');
const CORPUS = resolve(ROOT, 'src/tests/fixtures/opl/a2m');
const RATE = 48000;

function corpusFiles(dir = CORPUS): string[] {
  return readdirSync(dir)
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? corpusFiles(path) : [path];
    })
    .filter((p) => p.toLowerCase().endsWith('.a2m'))
    .sort();
}

beforeAll(() => {
  initSync({ module: new Uint8Array(readFileSync(resolve(ROOT, 'public/wasm/audio_processor_bg.wasm'))) });
  setA2mCodecBackend({ a2m_to_json, a2m_from_json, a2m_new_json });
});

/**
 * The song as a file stores it, but for what a rewrite normalises: v1/v5 become v4/v8, and the unused
 * space goes (spare patterns, and cells below the song's pattern length or past its track count, which
 * the player never reaches and AT2 does not show).
 */
function normalised(song: A2mSongJson): A2mSongJson {
  return {
    ...song,
    version: song.version === 1 ? 4 : song.version === 5 ? 8 : song.version,
    spare_patterns: [],
    patterns: song.patterns.map((p) => ({
      ...p,
      cells: p.cells.filter(([row, channel]) => row < song.pattern_len && channel < song.tracks),
    })),
  };
}

function render(bytes: Uint8Array, seconds = 2): { left: Float32Array; right: Float32Array } {
  const player = new A2Player(bytes, RATE);
  player.play();
  const left = new Float32Array(RATE * seconds);
  const right = new Float32Array(RATE * seconds);
  for (let at = 0; at < left.length; at += 4096) {
    player.render(left.subarray(at, at + 4096), right.subarray(at, at + 4096));
  }
  player.free();
  return { left, right };
}

const peak = (x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

describe('the corpus through the app: bytes -> song -> grid and doc -> compile -> bytes -> song', () => {
  const files = corpusFiles();

  it('finds the corpus', () => {
    expect(files.length).toBeGreaterThanOrEqual(279);
  });

  it('every file comes back as the same song', async () => {
    const differing: string[] = [];
    const refused: string[] = [];
    for (const path of files) {
      const bytes = new Uint8Array(readFileSync(path));
      const song = await a2mSongFromBytes(bytes);
      const display = buildA2mTrackerSong(song);
      const data = display.data;
      if (data.sequence.length === 0) {
        // An order list of jump markers only: the player refuses to open it (an instrument set, not a song).
        refused.push(relative(CORPUS, path));
        continue;
      }
      const compiled = compileA2mSong(data.a2mDoc!, data.patterns, data.sequence);
      const rewritten = { ...(await a2mSongFromBytes(await a2mBytesFromSong(compiled))), spare_patterns: [] };
      // The grid holds the file's patterns and any spare one the order names; the rest is unused space.
      const want = normalised(song);
      const kept = data.patterns.length;
      const equal =
        JSON.stringify({ ...rewritten, patterns: undefined }) === JSON.stringify({ ...want, patterns: undefined }) &&
        JSON.stringify(rewritten.patterns.slice(0, want.patterns.length)) === JSON.stringify(want.patterns) &&
        rewritten.patterns.length === kept;
      if (!equal) differing.push(relative(CORPUS, path));
    }
    expect(differing).toEqual([]);
    expect(refused).toEqual(["OxygenStar/oxygenstar's instrument set #001.a2m"]);
  }, 600_000);
});

describe('the rewritten corpus sounds like the original', () => {
  it('every file renders sample for sample as it did, from the module the app compiles', async () => {
    const dump = process.env.A2M_TS_DUMP_DIR;
    if (dump) mkdirSync(dump, { recursive: true });
    const differing: string[] = [];
    const refused: string[] = [];
    let compared = 0;
    for (const [index, path] of corpusFiles().entries()) {
      const original = new Uint8Array(readFileSync(path));
      const display = buildA2mTrackerSong(await a2mSongFromBytes(original)).data;
      if (display.sequence.length === 0) {
        refused.push(relative(CORPUS, path));
        continue;
      }
      const rewritten = await a2mBytesFromSong(compileA2mSong(display.a2mDoc!, display.patterns, display.sequence));
      if (dump) writeFileSync(join(dump, `${String(index).padStart(3, '0')}.a2m`), rewritten);
      // The same player on both; 4 seconds is a few hundred rows of most songs.
      const a = render(original, 4);
      const b = render(rewritten, 4);
      compared++;
      let same = true;
      for (let i = 0; i < a.left.length && same; i++) same = a.left[i] === b.left[i] && a.right[i] === b.right[i];
      if (!same) differing.push(relative(CORPUS, path));
    }
    expect(differing).toEqual([]);
    expect(compared).toBe(278);
    expect(refused).toHaveLength(1);
  }, 1_800_000);
});

describe('cells and effect columns', () => {
  it('reads and writes AT2 effect letters', () => {
    expect(parseA2mEffectColumn('A0F')).toEqual([0x0a, 0x0f]);
    expect(parseA2mEffectColumn('ZFF')).toEqual([0x23, 0xff]);
    expect(parseA2mEffectColumn('<01')).toEqual([0x2f, 0x01]);
    expect(parseA2mEffectColumn('')).toEqual([0, 0]);
    expect(parseA2mEffectColumn('nonsense')).toEqual([0, 0]);
  });

  it('a plain cell is its text, and edits to the text change the cell', () => {
    const entry = a2mCellToEntry(3, [49, 7, 0x0a, 0x0f, 0, 0])!;
    expect(entry).toMatchObject({ row: 3, note: 'C-4', instrument: '07', macro: 'A0F' });
    expect(entry.a2mCell).toBeUndefined();
    expect(a2mEntryToCell(entry)).toEqual([49, 7, 0x0a, 0x0f, 0, 0]);
    expect(a2mEntryToCell({ ...entry, note: 'D-4' })[0]).toBe(51);
    expect(a2mEntryToCell({ row: 0, note: '###' })[0]).toBe(255);
  });

  it('a fixed note keeps its flag while the row is untouched, and loses it when the row is edited', () => {
    const entry = a2mCellToEntry(0, [0x90 + 49, 1, 0, 0, 0, 0])!;
    expect(entry.note).toBe('C-4');
    expect(entry.a2mCell).toEqual([0x90 + 49, 1, 0, 0, 0, 0]);
    expect(a2mEntryToCell(entry)[0]).toBe(0x90 + 49);
    const edited: TrackerEntryData = { ...entry, note: 'D-4' };
    expect(a2mEntrySignature(edited)).not.toBe(entry.a2mSig);
    expect(a2mEntryToCell(edited)[0]).toBe(51);
  });
});

describe('the OPL instrument model', () => {
  it('decodes and encodes every instrument of the corpus to the same bytes', async () => {
    let seen = 0;
    for (const path of corpusFiles()) {
      const song = await a2mSongFromBytes(new Uint8Array(readFileSync(path)));
      for (const ins of song.instruments) {
        if (isEmptyA2mInstrument(ins)) continue;
        seen++;
        expect(encodeA2mFm(decodeA2mFm(ins.fm), ins.fm)).toEqual(ins.fm);
      }
    }
    expect(seen).toBeGreaterThan(1000);
  }, 600_000);

  it('names the fields', () => {
    const v = decodeA2mFm([0xe3, 0x31, 0x5a, 0x84, 0xf2, 0xa4, 0x35, 0x67, 0x05, 0x02, 0x0f]);
    expect(v.modulator).toMatchObject({
      tremolo: true,
      vibrato: true,
      sustain: true,
      ksr: false,
      multiplier: 3,
      keyScaleLevel: 1,
      totalLevel: 0x1a,
      attack: 15,
      decay: 2,
      sustainLevel: 3,
      release: 5,
      waveform: 5,
    });
    expect(v.carrier).toMatchObject({ tremolo: false, sustain: true, ksr: true, multiplier: 1, keyScaleLevel: 2, totalLevel: 4, waveform: 2 });
    expect(v.feedback).toBe(7);
    expect(v.connection).toBe('additive');
  });

  it('plays a note by loading the operators and keying the channel', () => {
    const ins = defaultA2mInstrument();
    const writes = a2mNoteOnRegisters(ins, 69);
    const reg = (r: number) => writes.filter((w) => w[0] === r).pop()?.[1];
    expect(reg(0x20)).toBe(ins.fm[0]);
    expect(reg(0x23)).toBe(ins.fm[1]);
    expect(reg(0x63)).toBe(ins.fm[5]);
    expect(reg(0xc0)! & 0x0f).toBe(0);
    // A4 = 440 Hz: block 4, F-number 0x241.
    const { block, fnum } = a2mPitch(69);
    expect(block).toBe(4);
    expect(fnum).toBe(580);
    expect(reg(0xb0)).toBe(0x20 | (block << 2) | (fnum >> 8));
    expect(a2mNoteOffRegisters(ins, 69)).toEqual([[0xb0, (block << 2) | (fnum >> 8)]]);
  });
});

describe('a song from scratch', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('a new OPL3 module is an empty, valid, playable song', async () => {
    const song = await createNewA2mTrackerSong(true);
    const data = song.data;
    expect(data.moduleFormat).toBe('a2m');
    expect(data.a2mDoc).toMatchObject({ version: 14, tracks: 18, tempo: 50, speed: 6, pattern_len: 64 });
    expect(data.patterns).toHaveLength(1);
    expect(data.patterns[0]!.tracks).toHaveLength(18);
    expect(data.patterns[0]!.rows).toBe(64);
    expect(data.sequence).toEqual([data.patterns[0]!.id]);
    // One usable instrument in slot 1; the other slots are empty.
    expect(data.instrumentSlots[0]!.instrumentName).toBe('New instrument');
    expect(data.instrumentSlots[1]!.instrumentName).toBe('');
    const bytes = await a2mBytesFromSong(compileA2mSong(data.a2mDoc!, data.patterns, data.sequence));
    expect(String.fromCharCode(...bytes.subarray(0, 10))).toBe('_A2module_');
    expect(bytes[14]).toBe(14);
    // The player takes it.
    expect(() => render(bytes, 1)).not.toThrow();
  });

  it('a new OPL2 module has nine tracks', async () => {
    const song = await createNewA2mTrackerSong(false);
    expect(song.data.a2mDoc!.tracks).toBe(9);
    expect(song.data.patterns[0]!.tracks).toHaveLength(9);
  });

  it('write notes, design an instrument, name the song, export it, and open it again', async () => {
    const store = useTrackerStore();
    store.initializeIfNeeded();
    store.loadSongFile(await createNewA2mTrackerSong(true));
    expect(store.isReadOnly).toBe(false);

    // A tune on track 1: four notes with instrument 1, then a key-off.
    const pattern = store.patterns[0]!;
    pattern.tracks[0]!.entries = [
      { row: 0, note: 'C-4', instrument: '01' },
      { row: 4, note: 'E-4', instrument: '01', macro: 'A3F' },
      { row: 8, note: 'G-4', instrument: '01' },
      { row: 12, note: '###' },
    ];

    // Our own instrument, in slot 2: a bell-ish FM voice with a name.
    const bell = defaultA2mInstrument('Bell');
    bell.fm = [0x21, 0x01, 0x12, 0x00, 0xf5, 0xf3, 0x45, 0x47, 0x02, 0x00, 0x06];
    bell.finetune = 3;
    store.setA2mInstrument(2, bell);
    expect(store.instrumentSlots[1]!.instrumentName).toBe('Bell');
    pattern.tracks[1]!.entries = [{ row: 0, note: 'C-5', instrument: '02' }];
    store.currentSong.title = 'From scratch';
    store.currentSong.author = 'Test';

    const exporter = getSongExporter('a2m')!;
    expect(SONG_EXPORTERS).toContain(exporter);
    const saved = store.serializeSong();
    expect(exporter.check(saved)).toEqual({ ok: true });
    await exporter.prepare?.();
    const bytes = exporter.serialize(saved);

    // Opening the file again gives the same song.
    const reopened = await a2mSongFromBytes(bytes);
    expect(a2mText(reopened.name)).toBe('From scratch');
    expect(a2mText(reopened.composer)).toBe('Test');
    expect(a2mText(reopened.instruments[1]!.name)).toBe('Bell');
    expect(reopened.instruments[1]!.fm).toEqual(bell.fm);
    expect(reopened.instruments[1]!.finetune).toBe(3);
    const cells = reopened.patterns[0]!.cells;
    expect(cells).toContainEqual([0, 0, 49, 1, 0, 0, 0, 0]);
    expect(cells).toContainEqual([4, 0, 53, 1, 0x0a, 0x3f, 0, 0]);
    expect(cells).toContainEqual([12, 0, 255, 0, 0, 0, 0, 0]);
    expect(cells).toContainEqual([0, 1, 61, 2, 0, 0, 0, 0]);

    // ... through the app's import path too, and it plays.
    const again = buildA2mTrackerSong(reopened);
    expect(again.data.currentSong.title).toBe('From scratch');
    expect(again.data.instrumentSlots[1]!.instrumentName).toBe('Bell');
    expect(again.data.patterns[0]!.tracks[0]!.entries.map((e) => e.note)).toEqual(['C-4', 'E-4', 'G-4', '###']);
    expect(peak(render(bytes, 2).left)).toBeGreaterThan(0.01);
  });

  it('an instrument edit changes what is heard, and survives export and re-import', async () => {
    const store = useTrackerStore();
    store.initializeIfNeeded();
    store.loadSongFile(await createNewA2mTrackerSong(true));
    store.patterns[0]!.tracks[0]!.entries = [{ row: 0, note: 'C-4', instrument: '01' }];
    const compile = () => compileA2mSong(store.a2mDoc!, store.patterns, store.sequence);

    const before = await a2mBytesFromSong(compile());
    const loud = render(before, 1);
    expect(peak(loud.left) + peak(loud.right)).toBeGreaterThan(0.01);

    // Silence the carrier (total level 63 = full attenuation): the song goes quiet.
    const voice = decodeA2mFm(store.a2mDoc!.instruments[0]!.fm);
    const quiet = { ...store.a2mDoc!.instruments[0]!, fm: encodeA2mFm({ ...voice, carrier: { ...voice.carrier, totalLevel: 63 } }, store.a2mDoc!.instruments[0]!.fm) };
    store.setA2mInstrument(1, quiet);
    const after = await a2mBytesFromSong(compile());
    expect(Array.from(after)).not.toEqual(Array.from(before));
    const muted = render(after, 1);
    expect(peak(muted.left)).toBeLessThan(peak(loud.left) * 0.05);

    // A different waveform on the carrier changes the sound without silencing it.
    store.setA2mInstrument(1, { ...store.a2mDoc!.instruments[0]!, fm: encodeA2mFm({ ...voice, carrier: { ...voice.carrier, waveform: 6 } }, store.a2mDoc!.instruments[0]!.fm) });
    const square = render(await a2mBytesFromSong(compile()), 1);
    expect(peak(square.left)).toBeGreaterThan(0.01);
    let difference = 0;
    for (let i = 0; i < square.left.length; i++) difference += Math.abs(square.left[i]! - loud.left[i]!);
    expect(difference).toBeGreaterThan(1);

    // The edit is in the file that comes out, and in the one that comes back in.
    const reread = await a2mSongFromBytes(after);
    expect(reread.instruments[0]!.fm).toEqual(quiet.fm);
    expect(decodeA2mFm(reread.instruments[0]!.fm).carrier.totalLevel).toBe(63);
  });

  it('refuses a song the format cannot hold, with a sentence', async () => {
    const store = useTrackerStore();
    store.initializeIfNeeded();
    store.loadSongFile(await createNewA2mTrackerSong(true));
    const layout = a2mLayout(14);
    const first = store.patterns[0]!;
    store.patterns.splice(0, store.patterns.length, ...Array.from({ length: layout.maxPatterns + 1 }, (_, i) => ({ ...first, id: `p${i}` })));
    const verdict = a2mExporter.check(store.serializeSong());
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/128 patterns at most/);
    // A song of another format is not exportable as an .a2m.
    store.loadSongFile({ ...(await createNewA2mTrackerSong(true)), data: { ...(await createNewA2mTrackerSong(true)).data, moduleFormat: 'native' } });
    expect(a2mExporter.check(store.serializeSong())).toEqual({ ok: false, reason: 'Only an Adlib Tracker II song can be saved as an .a2m.' });
  });
});

describe('songs saved before the editor', () => {
  it('an older .cmod (module bytes and a display grid) becomes an editable song', async () => {
    const bytes = new Uint8Array(readFileSync(resolve(CORPUS, 'NAB622/corridors of time.a2m')));
    const legacy = buildA2mTrackerSong(await a2mSongFromBytes(bytes));
    delete legacy.data.a2mDoc;
    legacy.data.a2mFile = encodeA2mFile(bytes);
    legacy.data.patterns = [];
    const upgraded = await upgradeLegacyA2mSongFile(legacy);
    expect(upgraded.data.a2mDoc?.instruments).toHaveLength(255);
    expect(upgraded.data.patterns.length).toBeGreaterThan(0);
    expect(upgraded.data.a2mFile).toBeUndefined();
    // A song that already has a doc is left alone.
    expect(await upgradeLegacyA2mSongFile(upgraded)).toBe(upgraded);
  });
});

describe('the grid of a module', () => {
  it('holds every pattern of the file and the order list up to its first marker', async () => {
    const song = await a2mSongFromBytes(new Uint8Array(readFileSync(resolve(CORPUS, 'NAB622/corridors of time.a2m'))));
    const { patterns, sequence } = a2mGridOf(song);
    expect(patterns).toHaveLength(song.patterns.length);
    expect(sequence.length).toBeGreaterThan(0);
    for (const id of sequence) expect(patterns.some((p) => p.id === id)).toBe(true);
    expect(patterns[0]!.tracks).toHaveLength(song.tracks);
    expect(patterns[0]!.rows).toBe(song.pattern_len);
  });
});

describe('song settings', () => {
  it('tempo and speed are kept in the doc, clamped, and compile into the module', async () => {
    setActivePinia(createPinia());
    const store = useTrackerStore();
    store.initializeIfNeeded();
    store.loadSongFile(await createNewA2mTrackerSong(false));
    store.setA2mTiming({ tempo: 70, speed: 4 });
    expect(store.a2mDoc).toMatchObject({ tempo: 70, speed: 4 });
    store.setA2mTiming({ speed: 999 });
    expect(store.a2mDoc?.speed).toBe(255);
    store.setA2mTiming({ tempo: 0 });
    expect(store.a2mDoc?.tempo).toBe(1);
    store.setA2mTiming({ tempo: 70, speed: 4 });
    const song = compileA2mSong(store.a2mDoc!, store.patterns, store.sequence);
    const reread = await a2mSongFromBytes(await a2mBytesFromSong(song));
    expect(reread).toMatchObject({ tempo: 70, speed: 4, tracks: 9 });
  });
});
