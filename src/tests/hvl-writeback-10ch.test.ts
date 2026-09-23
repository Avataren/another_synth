import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { parseAhx, type AhxSong, type AhxStep } from '@another-synth/tracker-playback';
import { serializeAhx } from 'src/audio/tracker/song-export';
import { importAhxToTrackerSong } from 'src/audio/tracker/ahx-import';
import { currentAhxSource, setCurrentAhxSource } from 'src/audio/tracker/ahx-source';
import { docChannels } from 'src/audio/tracker/ahx-doc';
import { useTrackerStore } from 'src/stores/tracker-store';
import type { TrackerEntryData } from 'src/components/tracker/tracker-types';

/**
 * P2's first commit (plan-hvl-editing.md §6 risk 2): the 10-channel write-back
 * test, written against the post-P2 behaviour. Every loop that says
 * `AHX_CHANNELS` is a silent-edit-loss bug for channels 5-16: channels 1-4
 * test green while the rest drop. So this edits channel 4 (the regression
 * guard), channel 5 and channel 10 of meltwater_10ch.hvl and looks for each
 * edit in the bytes the store builds and publishes, re-parsed.
 *
 * meltwater position 0 is tracks [1,2,41,4,40,6,0,0,0,0]: channel 4 writes
 * track 4 in place, channel 5 writes track 40 in place (a track every position
 * uses on channel 5, so the edit must reach all of them), and channel 10 is
 * the blank track 0, so its edit must get a track of its own at channel index 9.
 */
const DEMOS = path.resolve(__dirname, '../../public/demos/ahx');
const MELTWATER = new Uint8Array(fs.readFileSync(path.resolve(DEMOS, 'meltwater_10ch.hvl')));
const CHANNELS = 10;
const toBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

const blankStep = (): AhxStep => ({ note: 0, instrument: 0, fx: 0, fxParam: 0, fxb: 0, fxbParam: 0 });

/** The edit per channel index: a lone note on row 0 (C-3 = 25, D-3 = 27, E-3 = 29), instrument 01. */
const EDITS: readonly { channel: number; note: string; value: number }[] = [
  { channel: 3, note: 'C-3', value: 25 },
  { channel: 4, note: 'D-3', value: 27 },
  { channel: 9, note: 'E-3', value: 29 },
];

/** The track a cell holding only `value` on row 0 encodes to. */
function loneNoteTrack(song: AhxSong, value: number): AhxStep[] {
  const steps = Array.from({ length: song.trackLength }, blankStep);
  steps[0] = { ...blankStep(), note: value, instrument: 1 };
  return steps;
}

function load() {
  const store = useTrackerStore();
  store.loadSongFile(importAhxToTrackerSong(toBuffer(MELTWATER)));
  setCurrentAhxSource(MELTWATER);
  return store;
}

/** Replaces a grid cell's rows (the write-back's contract: a new `entries` array is an edit). */
function editCell(store: ReturnType<typeof useTrackerStore>, position: number, channel: number, entries: TrackerEntryData[]): void {
  const cell = store.patterns[position]?.tracks[channel];
  if (!cell) throw new Error(`no grid cell at position ${position} channel index ${channel}`);
  cell.entries = entries;
}

/** Edits `channels` at position 0, forces the write-back and returns the bytes the store builds, re-parsed. */
function editAndBuild(store: ReturnType<typeof useTrackerStore>, channels: readonly number[]): { bytes: Uint8Array; song: AhxSong } {
  for (const edit of EDITS.filter((e) => channels.includes(e.channel))) {
    editCell(store, 0, edit.channel, [{ row: 0, note: edit.note, instrument: '01' }]);
  }
  store.syncAhxWriteBack();
  const bytes = store.currentAhxBytes();
  expect(bytes, 'currentAhxBytes() for the edited HVL song').not.toBeNull();
  return { bytes: bytes!, song: parseAhx(bytes!) };
}

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => setCurrentAhxSource(null));

describe('HVL write-back at 10 channels (meltwater_10ch.hvl)', () => {
  it('loads editable: the doc is in the edit slot (ahxDoc, hvl, 10 channels), the gates open, the grid is 10 tracks wide', () => {
    const store = load();
    const doc = store.ahxDoc;
    expect(doc?.format).toBe('hvl');
    expect(doc === null ? null : docChannels(doc)).toBe(CHANNELS);
    expect([store.isAhxSong, store.isAhxEditable, store.isReadOnly]).toEqual([true, true, false]);
    const source = parseAhx(MELTWATER);
    expect(store.patterns.length).toBe(source.positions.length);
    store.patterns.forEach((pattern, p) => {
      expect(pattern.tracks.length, `position ${p} track cells`).toBe(CHANNELS);
    });
  });

  it('a channel-4 edit (index 3) still lands in the built bytes (regression guard)', () => {
    const store = load();
    const source = parseAhx(MELTWATER);
    const { song } = editAndBuild(store, [3]);
    expect(song.format).toBe('hvl');
    expect(song.channels).toBe(CHANNELS);
    expect(song.tracks[song.positions[0]!.track[3]!]).toEqual(loneNoteTrack(source, 25));
  });

  it('channel-5 and channel-10 edits (indices 4 and 9) land in the built and the published bytes', () => {
    const store = load();
    const source = parseAhx(MELTWATER);
    const { bytes, song } = editAndBuild(store, [3, 4, 9]);
    expect(song.format).toBe('hvl');
    expect(song.channels).toBe(CHANNELS);
    expect(song.positions.length).toBe(source.positions.length);

    // Every edit, reached through position 0's own track reference.
    for (const { channel, value } of EDITS) {
      expect(song.tracks[song.positions[0]!.track[channel]!], `channel index ${channel} at position 0`).toEqual(
        loneNoteTrack(source, value),
      );
    }
    // Channel 5: a shared track written in place, so every position that played it plays the edit.
    source.positions.forEach((position, p) => {
      if (position.track[4] !== source.positions[0]!.track[4]) return;
      expect(song.tracks[song.positions[p]!.track[4]!], `channel index 4 at position ${p}`).toEqual(loneNoteTrack(source, 27));
    });
    // Channel 10: was the blank track 0, now a track of its own; track 0 and the other blank cells stay blank.
    expect(source.positions[0]!.track[9]).toBe(0);
    expect(song.positions[0]!.track[9]).not.toBe(0);
    expect(song.tracks[0]!.every((s) => s.note === 0 && s.instrument === 0 && s.fx === 0 && s.fxb === 0)).toBe(true);
    source.positions.forEach((position, p) => {
      if (p === 0 || position.track[9] !== 0) return;
      expect(song.positions[p]!.track[9], `channel index 9 at position ${p}`).toBe(0);
    });
    // The untouched channels of position 0 and every transpose are as they were.
    for (const channel of [0, 1, 2, 5, 6, 7, 8]) {
      expect(song.tracks[song.positions[0]!.track[channel]!], `channel index ${channel} at position 0`).toEqual(
        source.tracks[source.positions[0]!.track[channel]!],
      );
    }
    expect(song.positions.map((p) => p.transpose)).toEqual(source.positions.map((p) => p.transpose));

    // What the engine plays is the same song.
    const published = currentAhxSource();
    expect(published).not.toBeNull();
    expect(published).not.toEqual(MELTWATER);
    expect(published).toEqual(bytes);
  });

  it('the edited song round-trips through serializeAhx with all 10 channels', () => {
    const store = load();
    const { song } = editAndBuild(store, [3, 4, 9]);
    const again = parseAhx(serializeAhx(song));
    expect(again.channels).toBe(CHANNELS);
    expect(again).toEqual(song);
    for (const { channel, value } of EDITS) {
      expect(again.tracks[again.positions[0]!.track[channel]!]![0], `channel index ${channel}`).toMatchObject({ note: value, instrument: 1 });
    }
  });
});
