import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
// Relative on purpose: the alias is mocked for other tests; this one renders on the real bytes.
import { AhxPlayer, initSync } from '../../public/wasm/audio_processor.js';
import { ahxInstrumentProblem, parseAhx, type AhxInstrument, type AhxSongFormat } from '@another-synth/tracker-playback';
import {
  AHX_MAX_INSTRUMENTS,
  buildAhxFile,
  createNewAhxDoc,
  makeAhxDoc,
  setStep,
  type AhxDoc,
} from 'src/audio/tracker/ahx-doc';
import { ahxEnvelopeNeverRises, defaultAhxInstrument } from 'src/audio/tracker/ahx-instrument-edit';
import {
  AHX_PRESETS,
  AHX_PRESET_CATEGORIES,
  AHX_PRESET_MAX_NAME_LENGTH,
  ahxPresetFits,
  ahxPresetOptions,
  ahxPresetsFor,
  type AhxPreset,
} from 'src/audio/tracker/ahx-presets';
import { importAhxToTrackerSong } from 'src/audio/tracker/ahx-import';
import { setCurrentAhxSource } from 'src/audio/tracker/ahx-source';
import { ahxEditNotice, clearAhxEditNotice } from 'src/audio/tracker/ahx-edit-notice';
import { useTrackerStore } from 'src/stores/tracker-store';
import { nearFullSong } from './helpers/ahx-near-full';

/**
 * The AHX/HVL preset library (`ahx-presets.ts`): every preset is an
 * instrument the format can hold, the right ones are offered for each format
 * and version, the store adds and replaces them as one undo step within the
 * format's limits, a song holding them exports and reads back the same, and
 * every one SOUNDS on the real player and ends by itself.
 */

const ROOT = resolve(__dirname, '../..');
const RATE = 44100;

const HVL_ONLY = ['keys-ring-bell', 'lead-ring', 'arp-pingpong'];
/** The presets that toggle the filter sweep (PList command 4 with a high nibble): a version-0 AHX file drops that. */
const sweepsFilter = (p: AhxPreset) => p.instrument.plist.entries.some((e) => e.fx.some((fx, i) => fx === 4 && (e.fxParam[i]! & 0xf0) !== 0));

const toBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/** A new song file of `format` with one instrument (the editor's default), as the file would be opened. */
function newSongBytes(format: AhxSongFormat, instruments: AhxInstrument[] = [defaultAhxInstrument()]): Uint8Array {
  const ahx = createNewAhxDoc({ trackLength: 64 });
  if (format === 'ahx') return buildAhxFile({ doc: ahx, slots: instruments.map((ahxData) => ({ ahxData })), title: ahx.songName }).bytes;
  const doc = makeAhxDoc({ ...ahx, format: 'hvl', channels: 4, mixgainRaw: 0x40, defstereo: 2, instruments });
  return buildAhxFile({ doc, slots: [], title: ahx.songName }).bytes;
}

/** The store with `bytes` loaded through the real import path, and the engine's bytes current. */
function load(bytes: Uint8Array, format: AhxSongFormat) {
  const store = useTrackerStore();
  store.loadSongFile(importAhxToTrackerSong(toBuffer(bytes)));
  setCurrentAhxSource(bytes, { format, version: parseAhx(bytes).version, edits: [] });
  return store;
}

/** The song's instruments as the file the store writes holds them (what export writes and the engine plays). */
function fileInstrumentsOf(store: ReturnType<typeof useTrackerStore>): AhxInstrument[] {
  const bytes = store.currentAhxBytes();
  if (!bytes) throw new Error('no bytes');
  return parseAhx(bytes).instruments.slice(1);
}

const plain = (ins: Readonly<AhxInstrument>): AhxInstrument => JSON.parse(JSON.stringify(ins)) as AhxInstrument;

describe('the AHX preset library', () => {
  it('has every category, unique ids and names an instrument list can hold, and says what each one is', () => {
    expect(new Set(AHX_PRESETS.map((p) => p.category))).toEqual(new Set(AHX_PRESET_CATEGORIES));
    expect(new Set(AHX_PRESETS.map((p) => p.id)).size).toBe(AHX_PRESETS.length);
    expect(new Set(AHX_PRESETS.map((p) => p.name)).size).toBe(AHX_PRESETS.length);
    for (const p of AHX_PRESETS) {
      expect(p.name.length, p.id).toBeLessThanOrEqual(AHX_PRESET_MAX_NAME_LENGTH);
      expect(p.instrument.name, p.id).toBe(p.name);
      expect(p.description.length, p.id).toBeGreaterThan(20);
    }
    // Every preset fits one HVL song, which holds 63 instruments.
    expect(AHX_PRESETS.length).toBeLessThanOrEqual(AHX_MAX_INSTRUMENTS);
  });

  it('every preset is an instrument the format holds, starts on a note and rises', () => {
    for (const p of AHX_PRESETS) {
      const ins = plain(p.instrument);
      expect(ahxInstrumentProblem(ins, 'hvl'), p.id).toBeNull();
      if (!HVL_ONLY.includes(p.id)) expect(ahxInstrumentProblem(ins, 'ahx'), p.id).toBeNull();
      // Row 0 sets the pitch: a fresh voice would otherwise play a semitone flat (voice.rs calc_period).
      expect(ins.plist.entries[0]!.note, p.id).toBeGreaterThan(0);
      expect(ahxEnvelopeNeverRises(ins), p.id).toBe(false);
      expect(ins.waveLength, p.id).toBe(3);
      for (const e of ins.plist.entries) {
        // A relative step played from C-4 (37) stays within the pitch table's B-5 (60).
        if (!e.fixed) expect(e.note, `${p.id} relative note`).toBeLessThanOrEqual(24);
        expect(e.waveform, p.id).toBeLessThanOrEqual(4);
      }
    }
  });

  it('offers each format and version the presets it plays as written', () => {
    const all = AHX_PRESETS.map((p) => p.id);
    expect(ahxPresetsFor('hvl', 0).map((p) => p.id)).toEqual(all);
    expect(ahxPresetsFor('hvl', 1).map((p) => p.id)).toEqual(all);
    const ahx = all.filter((id) => !HVL_ONLY.includes(id));
    expect(ahxPresetsFor('ahx', 1).map((p) => p.id)).toEqual(ahx);
    expect(ahxPresetsFor('ahx', 2).map((p) => p.id)).toEqual(ahx);
    const v0 = AHX_PRESETS.filter((p) => !HVL_ONLY.includes(p.id) && !sweepsFilter(p)).map((p) => p.id);
    expect(ahxPresetsFor('ahx', 0).map((p) => p.id)).toEqual(v0);
    expect(v0.length).toBeLessThan(ahx.length);
    expect(ahxPresetFits('nope', 'hvl', 1)).toBe(false);
    expect(ahxPresetOptions('ahx', 1)).toHaveLength(ahx.length);
    expect(ahxPresetOptions('hvl', 1)[0]!.bankName).toBe('HVL presets');
  });
});

describe('AHX presets from the store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    clearAhxEditNotice();
  });
  afterEach(() => {
    setCurrentAhxSource(null);
  });

  it('every AHX preset adds to a new AHX song, each as one undo step, and the file holds them all', () => {
    const store = load(newSongBytes('ahx'), 'ahx');
    const doc = store.ahxDoc;
    const presets = ahxPresetsFor('ahx', 1);
    presets.forEach((p, i) => {
      expect(store.addAhxPresetInstrument(p.id), p.id).toBe(i + 2);
    });
    expect(store.ahxDoc).toBe(doc);
    expect(store.instrumentSlots.slice(1, presets.length + 1).map((s) => s.instrumentName)).toEqual(presets.map((p) => p.name));
    expect(store.instrumentSlots[1]!.bankName).toBe('AHX presets');
    // The file (what export writes and the engine plays) holds each preset as it is.
    const written = fileInstrumentsOf(store);
    expect(written.slice(1)).toEqual(presets.map((p) => plain(p.instrument)));
    expect(written[0]).toEqual(defaultAhxInstrument());
    store.undo();
    expect(fileInstrumentsOf(store)).toHaveLength(presets.length);
    expect(store.instrumentSlots[presets.length]!.ahxData).toBeUndefined();
  });

  it('every preset adds to a new HVL song (the doc keeps them, the slots mirror them) and reads back from the .hvl', () => {
    const store = load(newSongBytes('hvl'), 'hvl');
    // Instrument 1 becomes the first preset, so all of them fit the 63 a song holds.
    expect(store.applyAhxPresetTo(1, AHX_PRESETS[0]!.id)).toBe(true);
    for (const p of AHX_PRESETS.slice(1)) expect(store.addAhxPresetInstrument(p.id), p.id).not.toBeNull();
    const doc = store.ahxDoc!;
    expect(doc.format).toBe('hvl');
    if (doc.format !== 'hvl') return;
    expect(doc.instruments.map(plain)).toEqual(AHX_PRESETS.map((p) => plain(p.instrument)));
    expect(store.instrumentSlots.slice(0, AHX_PRESETS.length).map((s) => s.ahxData?.name)).toEqual(AHX_PRESETS.map((p) => p.name));
    const bytes = store.currentAhxBytes()!;
    const song = parseAhx(bytes);
    expect(song.format).toBe('hvl');
    expect(song.instruments.slice(1)).toEqual(AHX_PRESETS.map((p) => plain(p.instrument)));
  });

  it('replaces an instrument in place, name and all; the others stay as they were, and undo puts it back', () => {
    const store = load(newSongBytes('ahx'), 'ahx');
    store.addAhxPresetInstrument('bass-saw');
    store.addAhxPresetInstrument('drum-kick');
    const before = fileInstrumentsOf(store);
    const docBefore = store.ahxDoc;
    expect(store.applyAhxPresetTo(2, 'lead-pwm')).toBe(true);
    const after = fileInstrumentsOf(store);
    expect(after[1]!.name).toBe('PWM Lead');
    expect(after[1]).toEqual(plain(AHX_PRESETS.find((p) => p.id === 'lead-pwm')!.instrument));
    expect(store.instrumentSlots[1]!.instrumentName).toBe('PWM Lead');
    expect(after[0]).toEqual(before[0]);
    expect(after[2]).toEqual(before[2]);
    store.undo();
    expect(fileInstrumentsOf(store)).toEqual(before);
    expect(store.instrumentSlots[1]!.instrumentName).toBe('Saw Bass');
    expect(store.ahxDoc).toBe(docBefore);
  });

  it('in an HVL song, replacing writes the doc copy-on-write and undo restores the very doc', () => {
    const store = load(newSongBytes('hvl', [defaultAhxInstrument(), defaultAhxInstrument()]), 'hvl');
    const doc = store.ahxDoc!;
    expect(store.applyAhxPresetTo(2, 'keys-ring-bell')).toBe(true);
    const next = store.ahxDoc!;
    expect(next).not.toBe(doc);
    if (next.format !== 'hvl' || doc.format !== 'hvl') throw new Error('not hvl');
    expect(next.instruments[1]!.name).toBe('Ring Bell');
    expect(next.instruments[0]).toEqual(doc.instruments[0]);
    store.undo();
    expect(store.ahxDoc).toBe(doc);
  });

  it('refuses, saying why, what the song cannot hold, and changes nothing', () => {
    const store = load(newSongBytes('ahx'), 'ahx');
    const undo = store.undoStack.length;
    expect(store.addAhxPresetInstrument('no-such')).toBeNull();
    expect(ahxEditNotice.value?.message).toMatch(/no AHX preset "no-such"/);
    // Ring modulation is HVL's only.
    expect(store.addAhxPresetInstrument('keys-ring-bell')).toBeNull();
    expect(store.applyAhxPresetTo(1, 'lead-ring')).toBe(false);
    expect(store.applyAhxPresetTo(9, 'bass-saw')).toBe(false);
    expect(store.undoStack.length).toBe(undo);
    expect(fileInstrumentsOf(store)).toHaveLength(1);
  });

  it('a version-0 AHX song is not given a preset that sweeps the filter', () => {
    const bytes = newSongBytes('ahx');
    bytes[3] = 0; // the version byte
    const store = load(bytes, 'ahx');
    expect(store.ahxDoc!.version).toBe(0);
    expect(store.addAhxPresetInstrument('bass-squelch')).toBeNull();
    expect(store.addAhxPresetInstrument('bass-saw')).toBe(2);
  });

  it('stops at 63 instruments', () => {
    const store = load(newSongBytes('ahx'), 'ahx');
    for (let n = 2; n <= AHX_MAX_INSTRUMENTS; n++) expect(store.addAhxPresetInstrument('drum-hat')).toBe(n);
    expect(store.addAhxPresetInstrument('drum-hat')).toBeNull();
    expect(ahxEditNotice.value?.message).toMatch(/63 instruments at most/);
    expect(fileInstrumentsOf(store)).toHaveLength(AHX_MAX_INSTRUMENTS);
  });

  it('refuses a preset the file has no room for (the 16-bit size limit)', () => {
    const { doc, slots } = nearFullSong('karma.ahx', 4);
    const full = buildAhxFile({ doc, slots, title: 'full' }).bytes;
    const store = load(full, 'ahx');
    const count = fileInstrumentsOf(store).length;
    expect(store.addAhxPresetInstrument('bass-saw')).toBeNull();
    expect(ahxEditNotice.value?.message).toMatch(/needs/);
    expect(fileInstrumentsOf(store)).toHaveLength(count);
  });
});

describe('every preset sounds (the Rust player, the keyboard preview and a song)', () => {
  beforeAll(() => {
    initSync({ module: new Uint8Array(readFileSync(resolve(ROOT, 'public/wasm/audio_processor_bg.wasm'))) });
  });

  // One HVL song holding them all: the preview plays instrument n of it.
  const allPresets: AhxDoc = makeAhxDoc({
    ...createNewAhxDoc({ trackLength: 64 }),
    format: 'hvl',
    channels: 4,
    mixgainRaw: 0x40,
    defstereo: 2,
    instruments: AHX_PRESETS.map((p) => plain(p.instrument)),
  });
  const bytes = buildAhxFile({ doc: allPresets, slots: [], title: 'x' }).bytes;
  const noteFor = (p: AhxPreset) => (p.category === 'Bass' ? 25 : 37);

  /** RMS per 100 ms of a mono mix. */
  function windows(out: Float32Array): number[] {
    const w = RATE / 10;
    const levels: number[] = [];
    for (let at = 0; at + w <= out.length; at += w) {
      let sum = 0;
      for (let i = at; i < at + w; i++) sum += out[i]! * out[i]!;
      levels.push(Math.sqrt(sum / w));
    }
    return levels;
  }

  function render(player: AhxPlayer, ms: number, offAtMs = Infinity): Float32Array {
    const q = 128;
    const l = new Float32Array(q);
    const r = new Float32Array(q);
    const total = Math.floor((ms / 1000) * RATE);
    const out = new Float32Array(total);
    const offAt = Math.floor((offAtMs / 1000) * RATE);
    for (let at = 0; at < total; at += q) {
      if (at <= offAt && offAt < at + q) player.preview_note_off();
      player.render(l, r);
      for (let i = 0; i < q && at + i < total; i++) out[at + i] = (l[i]! + r[i]!) / 2;
    }
    player.free();
    return out;
  }

  it.each(AHX_PRESETS.map((p, i) => [p.id, p, i + 1] as const))('%s is heard, and is silent once released', (id, p, instrument) => {
    const player = new AhxPlayer(bytes, RATE, 0);
    player.set_hifi(false);
    player.enable_preview();
    expect(player.preview_note_on(instrument, noteFor(p), 127)).toBe(true);
    const levels = windows(render(player, 3500, 500));
    expect(levels.every(Number.isFinite)).toBe(true);
    expect(Math.max(...levels.slice(0, 5)), id).toBeGreaterThan(0.05);
    // Every preset has died away within 3 s of its release.
    expect(levels[levels.length - 1]!, id).toBeLessThan(0.002);
  });

  it.each(AHX_PRESETS.map((p, i) => [p.id, p, i + 1] as const))('%s played once in a song ends by itself', (id, p, instrument) => {
    // A song has no key-off: the envelope alone ends the note (attack, decay, sustain, release ticks).
    const step = setStep(allPresets, 1, 0, { note: noteFor(p), instrument, fx: 0, fxParam: 0, fxb: 0, fxbParam: 0 });
    if (!step.ok) throw new Error(step.reason);
    const player = new AhxPlayer(buildAhxFile({ doc: step.doc, slots: [], title: 'x' }).bytes, RATE, 0);
    player.set_hifi(false);
    player.play();
    // 64 rows at speed 6 is 7.68 s: the note plays again after that.
    const levels = windows(render(player, 7500));
    expect(Math.max(...levels.slice(0, 5)), id).toBeGreaterThan(0.05);
    expect(Math.max(...levels.slice(65)), id).toBeLessThan(0.002);
  });
});
