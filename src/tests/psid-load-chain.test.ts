import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { importPsid } from 'src/audio/tracker/psid';
import { hasSongFileExtension } from 'src/composables/useTrackerFileIO';
import type { SidCommand } from 'src/audio/worklets/sid-core';
import { SID_CYCLES_PER_FRAME, SID_PAL_CLOCK_HZ } from 'src/audio/tracker/sid-instrument-visuals';
import { initSidWasm, peak, setupSidApp, sidWorkletNodes, teardownSidApp, until, type FakeSidWorkletNode } from './helpers/sid-worklet-harness';

/**
 * A C64 `.sid` dropped on the app takes the real song-load path
 * (`loadSongFromFile` -> `parseSongBuffer` -> `openPsidAsTune` -> `applySongFile`)
 * and is kept as the file it is, played by running its code in the SID worklet
 * (.ai/plan-psid-playback.md); "convert" makes the editable GoatTracker song
 * (plan-psid-import.md). Over the real SID core (`helpers/sid-worklet-harness.ts`).
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

  it(`${PROOF}: loads as a tune played as it is: no doc, no editable grid, the .sid kept, its header on the song`, async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = await setupSidApp();
    await app.host.loadSongFromFile(fileOf(fixture(PROOF), 'Commando.sid'));
    const store = app.trackerStore;
    expect(store.moduleFormat).toBe('sid');
    expect(store.isPsidSong).toBe(true);
    expect(store.sidDoc).toBeNull();
    expect(store.isSidEditable).toBe(false);
    expect(store.isReadOnly).toBe(true);
    expect(store.currentSong.title).toBe('Commando');
    expect(store.currentSong.author).toBe('Rob Hubbard');
    expect(Array.from(store.psidTune!.bytes)).toEqual(Array.from(fixture(PROOF)));
    expect(store.psidTune!.subsong).toBe(store.psidTune!.file.startSong - 1);
  }, 60000);

  it(`${PROOF}: plays through the playback store and the SID worklet, running the tune's own code`, async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = await setupSidApp();
    await app.host.loadSongFromFile(fileOf(fixture(PROOF), 'Commando.sid'));
    await app.host.play('song', 0);
    await until(() => sidWorkletNodes[0]?.received.some((c) => c.type === 'play') ?? false, 'play');
    const node = sidWorkletNodes[0] as FakeSidWorkletNode;
    const load = node.received.find((c): c is Extract<SidCommand, { type: 'load-psid' }> => c.type === 'load-psid');
    expect(load).toBeDefined();
    expect(Array.from(new Uint8Array(load!.bytes as ArrayBuffer))).toEqual(Array.from(fixture(PROOF)));
    expect(load!.subsong).toBe(app.trackerStore.psidTune!.subsong);
    node.pump(ROW);
    const { mix, taps } = node.pump(64 * ROW);
    expect(peak(mix)).toBeGreaterThan(0.05);
    for (const tap of taps) expect(peak(tap)).toBeGreaterThan(0.01);
  }, 60000);

  it('another subsong restarts the playing tune on it; stop then play starts the tune afresh', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = await setupSidApp();
    await app.host.loadSongFromFile(fileOf(fixture(PROOF), 'Commando.sid'));
    await app.host.play('song', 0);
    await until(() => sidWorkletNodes[0]?.received.some((c) => c.type === 'play') ?? false, 'play');
    const node = sidWorkletNodes[0] as FakeSidWorkletNode;
    const loads = () => node.received.filter((c): c is Extract<SidCommand, { type: 'load-psid' }> => c.type === 'load-psid');
    expect(loads()).toHaveLength(1);
    app.trackerStore.selectPsidSubsong(2);
    await until(() => loads().length === 2, 'the reload');
    expect(loads()[1]!.subsong).toBe(2);
    app.playbackStore.stop();
    await app.host.play('song', 0);
    await until(() => loads().length === 3, 'a fresh load after stop');
    expect(loads()[2]!.subsong).toBe(2);
  }, 60000);

  it('is saved and restored as the .sid it is (a .cmod round trip keeps the tune and its subsong)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = await setupSidApp();
    await app.host.loadSongFromFile(fileOf(fixture(PROOF), 'Commando.sid'));
    app.trackerStore.selectPsidSubsong(3);
    const saved = JSON.parse(JSON.stringify(app.trackerStore.serializeSong()));
    expect(saved.data.psidSubsong).toBe(3);
    expect(saved.data.sidFile).toBeUndefined();
    app.trackerStore.resetToNewSong();
    expect(app.trackerStore.isPsidSong).toBe(false);
    app.trackerStore.loadSongFile(saved);
    expect(app.trackerStore.isPsidSong).toBe(true);
    expect(app.trackerStore.psidTune!.subsong).toBe(3);
    expect(Array.from(app.trackerStore.psidTune!.bytes)).toEqual(Array.from(fixture(PROOF)));
  }, 60000);

  it('"convert to a GoatTracker song" replaces the tune with the importer\'s editable doc and says what it is', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // No toast in the harness: the notice goes to the log.
    const told = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = await setupSidApp();
    await app.host.loadSongFromFile(fileOf(fixture(PROOF), 'Commando.sid'));
    await app.host.convertPsidTune();
    const store = app.trackerStore;
    expect(store.isPsidSong).toBe(false);
    expect(store.isSidEditable).toBe(true);
    const r = importPsid(fixture(PROOF));
    if (!r.ok) throw new Error(r.reason);
    expect(store.sidDoc).toEqual(r.doc);
    const notice = told.mock.calls.map((c) => String(c[0])).find((m) => m.startsWith('Commando by Rob Hubbard'));
    expect(notice).toMatch(/transcribed from its own C64 player into a GoatTracker song \(19 of 19 subsongs\)/);
  }, 120000);

  it('a .sid this player cannot run is refused whole, with the reason: the song loaded before stays', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = await setupSidApp();
    await app.host.loadSongFromFile(fileOf(fixture(PROOF), 'Commando.sid'));
    const before = app.trackerStore.psidTune;
    // Compute!'s Sidplayer data (the MUS flag): nothing to run.
    const mus = fixture(PROOF).slice();
    mus[0x77] = mus[0x77]! | 1;
    await expect(app.host.parseSongBuffer(mus.slice().buffer, 'mus.sid')).rejects.toThrow(/^Cannot open this SID file: it holds Compute!'s Sidplayer \(MUS\) data/);
    await app.host.loadSongFromFile(fileOf(mus, 'mus.sid'));
    expect(error).toHaveBeenCalledWith('Failed to load song', expect.any(Error));
    expect(app.trackerStore.psidTune).toBe(before);
    expect(app.trackerStore.currentSong.title).toBe('Commando');
  }, 60000);
});
