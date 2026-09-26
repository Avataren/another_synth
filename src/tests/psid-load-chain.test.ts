import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { importPsid } from 'src/audio/tracker/psid';
import { serializeSidFile, sidDocForSubsong } from 'src/audio/tracker/sid-doc';
import { hasSongFileExtension } from 'src/composables/useTrackerFileIO';
import type { SidCommand } from 'src/audio/worklets/sid-core';
import { SID_CYCLES_PER_FRAME, SID_PAL_CLOCK_HZ } from 'src/audio/tracker/sid-instrument-visuals';
import { initSidWasm, peak, setupSidApp, sidWorkletNodes, teardownSidApp, until, type FakeSidWorkletNode } from './helpers/sid-worklet-harness';

/**
 * plan-psid-import.md phase 5: a C64 `.sid` dropped on the app takes the real
 * song-load path (`loadSongFromFile` -> `parseSongBuffer` dispatches on the
 * PSID/RSID magic -> `importPsidToTrackerSong` -> `applySongFile`), becomes
 * an editable SID song (the doc the importer made, its instruments in the
 * slots), tells the user what they got, and plays through the real SID core
 * (`helpers/sid-worklet-harness.ts`).
 */

const FIXTURES = resolve(__dirname, 'fixtures/psid');
const PROOF = 'hubbard_rob/commando.sid';
/** One row, tempo 6 PAL frames. */
const ROW = Math.round((6 * 44_100 * SID_CYCLES_PER_FRAME) / SID_PAL_CLOCK_HZ);

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(resolve(FIXTURES, name)));
/** A dropped file. jsdom's `File` has no `arrayBuffer()` (browsers do), so it gets the browser's. */
const fileOf = (bytes: Uint8Array, name: string): File =>
  Object.assign(new File([bytes], name), { arrayBuffer: async () => bytes.slice().buffer });

beforeAll(() => initSidWasm());
afterEach(() => teardownSidApp());

describe('a C64 .sid through the real load path', () => {
  it('is a song file the app opens', () => {
    expect(hasSongFileExtension('Commando.sid')).toBe(true);
    expect(hasSongFileExtension('COMMANDO.SID')).toBe(true);
  });

  it(`${PROOF}: loads as an editable SID song, the importer's doc, its instruments in the slots; the user is told what it is`, async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // No toast in the harness: the notice goes to the log.
    const told = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = await setupSidApp();
    await app.host.loadSongFromFile(fileOf(fixture(PROOF), 'Commando.sid'));
    const store = app.trackerStore;
    expect(store.moduleFormat).toBe('sid');
    expect(store.isSidSong).toBe(true);
    expect(store.isSidEditable).toBe(true);
    const r = importPsid(fixture(PROOF));
    if (!r.ok) throw new Error(r.reason);
    expect(store.sidDoc).toEqual(r.doc);
    expect(store.currentSong.title).toBe('Commando');
    expect(store.currentSong.author).toBe('Rob Hubbard');
    r.doc.instruments.forEach((ins, i) => {
      expect(store.instrumentSlots[i]?.instrumentName).toBe(ins.name);
      expect(store.instrumentSlots[i]?.instrumentFormat).toBe('sid');
    });
    const notice = told.mock.calls.map((c) => String(c[0])).find((m) => m.startsWith('Commando by Rob Hubbard'));
    expect(notice).toMatch(
      /^Commando by Rob Hubbard: transcribed from its own C64 player into a GoatTracker song \(19 of 19 subsongs\)\. Its first subsong plays \d+% like the original, frame by frame\.$/,
    );
  }, 60000);

  it(`${PROOF}: plays through the playback store and the SID worklet`, async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = await setupSidApp();
    await app.host.loadSongFromFile(fileOf(fixture(PROOF), 'Commando.sid'));
    await app.host.play('song', 0);
    await until(() => sidWorkletNodes[0]?.received.some((c) => c.type === 'play') ?? false, 'play');
    const node = sidWorkletNodes[0] as FakeSidWorkletNode;
    const load = node.received.find((c): c is Extract<SidCommand, { type: 'load-song' }> => c.type === 'load-song');
    // The worklet plays the subsong the grid shows: the start song, the doc's first.
    expect(Array.from(new Uint8Array(load!.bytes as ArrayBuffer))).toEqual(Array.from(serializeSidFile(sidDocForSubsong(app.trackerStore.sidDoc!, 0))));
    node.pump(ROW);
    const { mix, taps } = node.pump(64 * ROW);
    expect(peak(mix)).toBeGreaterThan(0.05);
    for (const tap of taps) expect(peak(tap)).toBeGreaterThan(0.01);
  }, 60000);

  it('a .sid the importer cannot run is refused whole, with the reason: the song loaded before stays', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = await setupSidApp();
    await app.host.loadSongFromFile(fileOf(fixture(PROOF), 'Commando.sid'));
    const before = app.trackerStore.sidDoc;
    // Compute!'s Sidplayer data (the MUS flag): nothing to run.
    const mus = fixture(PROOF).slice();
    mus[0x77] = mus[0x77]! | 1;
    await expect(app.host.parseSongBuffer(mus.slice().buffer, 'mus.sid')).rejects.toThrow(/^Cannot import this SID file: it holds Compute!'s Sidplayer \(MUS\) data/);
    await app.host.loadSongFromFile(fileOf(mus, 'mus.sid'));
    expect(error).toHaveBeenCalledWith('Failed to load song', expect.any(Error));
    expect(app.trackerStore.sidDoc).toBe(before);
    expect(app.trackerStore.currentSong.title).toBe('Commando');
  }, 60000);
});
