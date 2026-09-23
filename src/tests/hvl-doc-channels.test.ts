import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { parseAhx, type AhxSong, type AhxStep } from '@another-synth/tracker-playback';
import { serializeAhx } from 'src/audio/tracker/song-export';
import { importAhxToTrackerSong } from 'src/audio/tracker/ahx-import';
import { currentAhxSource, setCurrentAhxSource } from 'src/audio/tracker/ahx-source';
import { docFromBytes, docFromSong, docToSong, HVL_MAX_CHANNELS, type AhxDoc, type HvlDoc } from 'src/audio/tracker/ahx-doc';
import { useTrackerStore } from 'src/stores/tracker-store';

/**
 * The structural guard P2 builds on (plan-hvl-editing.md §6 risk 2): channels
 * 1-4 test green while 5-16 silently drop, unless a test looks at every
 * channel. Every channel's track and every per-position, per-channel transpose
 * must survive parse -> docFromSong -> serialize -> parse, at 10 channels (the
 * corpus's widest, meltwater_10ch.hvl) and at 16 (the engine's cap, a song
 * synthesized with the writer since no demo is that wide).
 */
const DEMOS = path.resolve(__dirname, '../../public/demos/ahx');
const demo = (name: string): Uint8Array => new Uint8Array(fs.readFileSync(path.resolve(DEMOS, name)));
const toBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

const TRACK_LENGTH = 8;
const blankStep = (): AhxStep => ({ note: 0, instrument: 0, fx: 0, fxParam: 0, fxb: 0, fxbParam: 0 });

/**
 * A `channels`-wide HVL song where nothing repeats across channels: channel
 * `ch` of position `p` plays its own track `1 + p*channels + ch`, whose row 0
 * has note `1 + (ch % 60)` and whose row `ch % 8` has second-column effect
 * `ch % 16`, and its transpose is `ch*7 - 50 + p` (distinct per channel, both
 * signs). A lost, shifted or truncated channel changes some value.
 */
function wideSong(channels: number, positions = 3): AhxSong {
  const tracks: AhxStep[][] = [Array.from({ length: TRACK_LENGTH }, blankStep)];
  const positionList = [];
  for (let p = 0; p < positions; p++) {
    const track: number[] = [];
    const transpose: number[] = [];
    for (let ch = 0; ch < channels; ch++) {
      const steps = Array.from({ length: TRACK_LENGTH }, blankStep);
      steps[0] = { ...blankStep(), note: 1 + (ch % 60), instrument: 1, fx: 0xc, fxParam: 0x10 + ch };
      steps[ch % TRACK_LENGTH] = { ...steps[ch % TRACK_LENGTH]!, fxb: ch % 16, fxbParam: 0x40 + p };
      track.push(tracks.length);
      tracks.push(steps);
      transpose.push(ch * 7 - 50 + p);
    }
    positionList.push({ track, transpose });
  }
  const instrument = parseAhx(demo('sunspots.hvl')).instruments.slice(0, 2);
  return {
    format: 'hvl',
    version: 1,
    name: `${channels} channels`,
    channels,
    positionNr: positions,
    restart: 0,
    speedMultiplier: 1,
    trackLength: TRACK_LENGTH,
    trackNr: tracks.length - 1,
    instrumentNr: 1,
    subsongNr: 0,
    subsongs: [],
    positions: positionList,
    tracks,
    instruments: instrument,
    mixgainRaw: 0x55,
    defstereo: 3,
  };
}

/** Every channel of every position: its track's steps and its transpose, in `b` as in `a`. */
function expectEveryChannel(a: AhxSong | AhxDoc, b: AhxSong | AhxDoc, channels: number, what: string): void {
  expect(b.positions.length, what).toBe(a.positions.length);
  a.positions.forEach((position, p) => {
    const other = b.positions[p]!;
    expect(other.track.length, `${what} position ${p} width`).toBe(channels);
    expect(other.transpose.length, `${what} position ${p} width`).toBe(channels);
    for (let ch = 0; ch < channels; ch++) {
      const where = `${what} position ${p} channel ${ch + 1}`;
      expect(other.track[ch], `${where} track`).toBe(position.track[ch]);
      expect(other.transpose[ch], `${where} transpose`).toBe(position.transpose[ch]);
      expect(b.tracks[other.track[ch]!], `${where} steps`).toEqual(a.tracks[position.track[ch]!]);
    }
  });
}

/** parse -> docFromSong -> serialize -> parse, checked channel by channel at each step. */
function roundTrip(bytes: Uint8Array, channels: number, what: string): HvlDoc {
  const song = parseAhx(bytes);
  expect(song.channels, what).toBe(channels);
  const doc = docFromSong(song, bytes);
  if (doc.format !== 'hvl') throw new Error(`${what}: not an HVL doc`);
  expect(doc.channels, what).toBe(channels);
  expectEveryChannel(song, doc, channels, `${what} doc`);
  for (const base of [bytes, undefined]) {
    const out = serializeAhx(docToSong(doc, song.instruments), base === undefined ? {} : { base });
    const reparsed = parseAhx(out);
    expectEveryChannel(song, reparsed, channels, `${what} ${base ? 'base' : 'no base'}`);
    expect(reparsed, what).toEqual(song);
  }
  return doc;
}

describe('HVL docs keep every channel (10 and 16)', () => {
  it('meltwater_10ch.hvl: all 10 channels survive the round trip, and channels 5-10 carry real data', () => {
    const doc = roundTrip(demo('meltwater_10ch.hvl'), 10, 'meltwater');
    // Not a vacuous pass: channels 5-10 address tracks with notes in them. (The
    // file only transposes channel 2, so the 16-channel song below is what
    // guards the upper channels' transposes.)
    const upper = doc.positions.flatMap((p) => p.track.slice(4));
    expect(upper.some((t) => t !== 0 && doc.tracks[t]!.some((s) => s.note !== 0))).toBe(true);
    expect(new Set(doc.positions.map((p) => p.track[9])).size).toBeGreaterThan(1);
  });

  it('a synthesized 16-channel song: all 16 channels, their tracks and transposes, and the mix bytes survive', () => {
    const song = wideSong(HVL_MAX_CHANNELS);
    const bytes = serializeAhx(song);
    expect((bytes[8]! >> 2) + 4).toBe(16);
    const doc = roundTrip(bytes, 16, '16ch');
    expectEveryChannel(song, doc, 16, '16ch against the source model');
    expect([doc.mixgainRaw, doc.defstereo]).toEqual([0x55, 3]);
    // Channel 16's own content, by value.
    expect(doc.positions[2]!.transpose[15]).toBe(15 * 7 - 50 + 2);
    expect(doc.tracks[doc.positions[2]!.track[15]!]![0]!.fxParam).toBe(0x10 + 15);
  });

  it('an HVL song wider than the engine plays has no doc (17 channels)', () => {
    const bytes = serializeAhx(wideSong(17, 1));
    expect(parseAhx(bytes).channels).toBe(17);
    expect(() => docFromBytes(bytes)).toThrow(/4 to 16 channels/);
  });
});

describe('the store attaches the HVL doc at load, read-only', () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => setCurrentAhxSource(null));

  for (const [label, bytes, channels] of [
    ['meltwater_10ch.hvl', demo('meltwater_10ch.hvl'), 10],
    ['16 channels', serializeAhx(wideSong(16)), 16],
  ] as const) {
    it(`${label}: hvlDoc holds all ${channels} channels, the grid is its projection, nothing opens for editing`, () => {
      const store = useTrackerStore();
      const song = parseAhx(bytes);
      setCurrentAhxSource(bytes);
      store.loadSongFile(importAhxToTrackerSong(toBuffer(bytes)));

      const doc = store.hvlDoc;
      expect(doc).not.toBeNull();
      expectEveryChannel(song, doc!, channels, label);
      expect(doc!.base).toEqual(bytes);
      // The gates are where they were: read-only, not editable, no edit doc.
      expect([store.isAhxSong, store.isAhxEditable, store.isReadOnly]).toEqual([true, false, true]);
      expect(store.ahxDoc).toBeNull();
      // The engine's bytes are untouched (no publish).
      expect(currentAhxSource()).toBe(bytes);
      // The grid: one pattern per position, every channel a track, stable ids, the transposes beside it.
      expect(store.patterns.length).toBe(song.positions.length);
      expect(store.sequence).toEqual(store.patterns.map((p) => p.id));
      expect(store.currentPatternId).toBe('ahx-pos-0');
      store.patterns.forEach((pattern, p) => {
        expect(pattern.tracks.length, `${label} position ${p}`).toBe(channels);
        expect(pattern.positionTranspose, `${label} position ${p}`).toEqual(song.positions[p]!.transpose);
      });
      // A save embeds no rebuilt file for it, and history stays refused.
      expect(store.serializeSong().data.ahxFile).toBeUndefined();
      store.pushHistory();
      expect(store.undoStack).toEqual([]);
    });
  }

  it('a new load clears the HVL doc', () => {
    const store = useTrackerStore();
    store.loadSongFile(importAhxToTrackerSong(toBuffer(demo('meltwater_10ch.hvl'))));
    expect(store.hvlDoc).not.toBeNull();
    store.loadSongFile(importAhxToTrackerSong(toBuffer(demo('karma.ahx'))));
    expect(store.hvlDoc).toBeNull();
    expect(store.ahxDoc?.format).toBe('ahx');
    store.loadSongFile(importAhxToTrackerSong(toBuffer(demo('sunspots.hvl'))));
    expect(store.hvlDoc?.format).toBe('hvl');
    expect(store.ahxDoc).toBeNull();
    store.resetToNewSong();
    expect(store.hvlDoc).toBeNull();
  });

  it('an HVL song too wide for a doc keeps its imported display', () => {
    const store = useTrackerStore();
    store.loadSongFile(importAhxToTrackerSong(toBuffer(serializeAhx(wideSong(17, 1)))));
    expect(store.hvlDoc).toBeNull();
    expect(store.isReadOnly).toBe(true);
    // The import caps the grid at the engine's 16 channels.
    expect(store.patterns[0]!.tracks.length).toBe(16);
  });
});
