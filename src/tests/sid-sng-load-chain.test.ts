import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { importGtSong, serializeSidFile } from 'src/audio/tracker/sid-doc';
import type { SidCommand } from 'src/audio/worklets/sid-core';
import { initSidWasm, peak, setupSidApp, sidWorkletNodes, teardownSidApp, until, type FakeSidWorkletNode } from './helpers/sid-worklet-harness';

/**
 * plan-sid-tracking.md S5: a GoatTracker `.sng` loads through the app's real
 * song-load path and PLAYS (the jt_letgo rule: the system is built the way
 * production builds it, no fixture shim in between). The bytes of a corpus
 * file go into the real song host exactly as a dropped file does
 * (`loadSongFromFile` -> `parseSongBuffer` dispatches on the GTS magic ->
 * `importGtSongToTrackerSong` -> `applySongFile` -> `loadSongFile` ->
 * `adoptSidFile`), then the real playback store plays it through the SID
 * transport and player client into the real SID core over the rebuilt wasm
 * (`helpers/sid-worklet-harness.ts`: only the render thread is stood in for).
 *
 * The proof song is Mch's "Alien Funk" (GTS5, 19 KB, filter-heavy, 3
 * subtunes). A GoatTracker 1 song (Cadaver's "Dojo") plays too, and the chip
 * tag a file name carries (`..._6581_...`) reaches the player's bytes.
 */

const FIXTURES = resolve(__dirname, 'fixtures/gt-songs');
const PROOF = 'mch/alien_funk.sng';
const ROW = 6 * 882;

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(resolve(FIXTURES, name)));
/** A dropped file. jsdom's `File` has no `arrayBuffer()` (browsers do), so it gets the browser's. */
const fileOf = (bytes: Uint8Array, name: string): File =>
  Object.assign(new File([bytes], name), { arrayBuffer: async () => bytes.slice().buffer });
const asFile = (name: string): File => fileOf(fixture(name), name.replace(/^.*\//, ''));

beforeAll(() => initSidWasm());
afterEach(() => teardownSidApp());

async function loadAndPlay(name: string) {
  const app = await setupSidApp();
  await app.host.loadSongFromFile(asFile(name));
  await app.host.play('song', 0);
  await until(() => sidWorkletNodes[0]?.received.some((c) => c.type === 'play') ?? false, 'play');
  return { ...app, node: sidWorkletNodes[0] as FakeSidWorkletNode };
}

describe('a GoatTracker .sng through the real load path', () => {
  it(`${PROOF}: loads as an editable SID song whose doc is the import's, with its instruments in the slots and a grid`, async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const app = await setupSidApp();
    await app.host.loadSongFromFile(asFile(PROOF));
    const store = app.trackerStore;
    expect(store.moduleFormat).toBe('sid');
    expect(store.isSidSong).toBe(true);
    expect(store.isSidEditable).toBe(true);
    const imported = importGtSong(fixture(PROOF));
    if (!imported.ok) throw new Error(imported.reason);
    // The doc crossed the song file (`data.sidFile`) and came back equal.
    expect(store.sidDoc).toEqual(imported.doc);
    expect(store.sidDoc?.chipModel).toBe('8580');
    expect(store.currentSong.title).toBe('Alien Funk');
    expect(store.currentSong.author).toBe('Michal Brzeski (Mch)');
    // The grid: positions, each three voices, notes in them.
    expect(store.patterns.length).toBeGreaterThan(10);
    expect(store.patterns.every((p) => p.tracks.length === 3)).toBe(true);
    expect(store.patterns.reduce((n, p) => n + p.tracks.reduce((m, t) => m + t.entries.length, 0), 0)).toBeGreaterThan(500);
    // The instruments, by name, tagged SID.
    const docInstruments = imported.doc.instruments;
    expect(docInstruments.length).toBe(19);
    docInstruments.forEach((ins, i) => {
      expect(store.instrumentSlots[i]?.instrumentName).toBe(ins.name);
      expect(store.instrumentSlots[i]?.instrumentFormat).toBe('sid');
    });
    expect(store.instrumentSlots[0]?.instrumentName).toBe('kick-wobset 26');
  }, 30000);

  it(`${PROOF}: plays through the playback store and the SID worklet: the doc's bytes, then audio on the voices`, async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { trackerStore, playbackStore, node } = await loadAndPlay(PROOF);
    expect(playbackStore.isPlaying).toBe(true);
    const load = node.received.find((c): c is Extract<SidCommand, { type: 'load-song' }> => c.type === 'load-song');
    expect(load).toBeDefined();
    expect(Array.from(new Uint8Array(load!.bytes as ArrayBuffer))).toEqual(Array.from(serializeSidFile(trackerStore.sidDoc!)));
    node.pump(ROW);
    const { mix, taps } = node.pump(64 * ROW);
    expect(peak(mix)).toBeGreaterThan(0.05);
    // Every voice of the chip is playing something in the first 64 rows.
    for (const tap of taps) expect(peak(tap)).toBeGreaterThan(0.01);
  }, 60000);

  it('a GoatTracker 1 song (cadaver/dojo.sng, GTS!) loads and plays', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { trackerStore, node } = await loadAndPlay('cadaver/dojo.sng');
    expect(trackerStore.sidDoc?.songName).toBe('Dojo');
    node.pump(ROW);
    expect(peak(node.pump(32 * ROW).mix)).toBeGreaterThan(0.05);
  }, 60000);

  it('the chip model a file name names reaches the doc and the player (stinsen/defunkt_final_fv_po_ro_6581_ffff.sng)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { trackerStore, node } = await loadAndPlay('stinsen/defunkt_final_fv_po_ro_6581_ffff.sng');
    expect(trackerStore.sidDoc?.chipModel).toBe('6581');
    const load = node.received.find((c): c is Extract<SidCommand, { type: 'load-song' }> => c.type === 'load-song');
    // ASID byte 5: the chip model, 1 = 6581 (sid-file-codec.ts).
    expect(new Uint8Array(load!.bytes as ArrayBuffer)[5]).toBe(1);
  }, 60000);

  it('the corrupt-as-published sleepwalk.sng is refused whole: the song loaded before stays', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = await setupSidApp();
    await app.host.loadSongFromFile(asFile(PROOF));
    const before = app.trackerStore.sidDoc;
    const bad = new Uint8Array(readFileSync(resolve(__dirname, 'fixtures/gt-songs-corrupt/sleepwalk.sng')));
    await expect(app.host.parseSongBuffer(bad.slice().buffer, 'sleepwalk.sng')).rejects.toThrow(/^Cannot import this GoatTracker song: /);
    await app.host.loadSongFromFile(fileOf(bad, 'sleepwalk.sng'));
    expect(error).toHaveBeenCalledWith('Failed to load song', expect.any(Error));
    expect(app.trackerStore.sidDoc).toBe(before);
    expect(app.trackerStore.currentSong.title).toBe('Alien Funk');
  }, 30000);
});
