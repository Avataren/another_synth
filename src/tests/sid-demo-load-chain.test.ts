import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DemoCollection } from 'src/composables/useDemoManifest';
import { demoSongUrl } from 'src/composables/useDemoManifest';
import { initSidWasm, peak, setupSidApp, sidWorkletNodes, teardownSidApp, until, type FakeSidWorkletNode } from './helpers/sid-worklet-harness';
import { SID_CYCLES_PER_FRAME, SID_PAL_CLOCK_HZ } from 'src/audio/tracker/sid-instrument-visuals';

/**
 * The GoatTracker demo collection: a `.sng` picked in the demo browser takes
 * the same road as a dropped one. The tracker page hands the browser's URL
 * (`demos/<manifest file>`) to `loadSongFromUrl` (`handleDemoSelect`), which
 * fetches it and goes through `parseSongBuffer`'s GTS dispatch; the jukebox
 * queues the manifest entry (`addSong`) and plays it through
 * `parseSongBuffer` -> `applySongFile` -> `play`. Both are run here against
 * the published files in `public/demos`, served by a stand-in `fetch`, over
 * the real SID core (`helpers/sid-worklet-harness.ts`).
 *
 * The same stand-in records the init of the wasm fetch: the player asks for
 * it revalidated (`cache: 'no-cache'`), so a deploy's new wasm is not shadowed
 * by the browser's cached copy.
 */

const ROOT = resolve(__dirname, '../..');
const PUBLIC = resolve(ROOT, 'public');
/** One row, tempo 6 PAL frames (879.8 samples each at 44.1 kHz; GT-parity 0925b, was 6 x 882 at 50 Hz). */
const ROW = Math.round((6 * 44_100 * SID_CYCLES_PER_FRAME) / SID_PAL_CLOCK_HZ);

const manifest = JSON.parse(readFileSync(resolve(PUBLIC, 'demos/index.json'), 'utf8')) as {
  collections: DemoCollection[];
};
const goattracker = manifest.collections.find((c) => c.id === 'goattracker');

/** `fetch` over `public/`, the way the dev server and the deploy serve it. */
function serveFromPublic() {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    const bytes = readFileSync(resolve(PUBLIC, String(url).replace(/^\//, '')));
    return new Response(bytes, { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeAll(() => initSidWasm());
afterEach(() => teardownSidApp());

describe('the GoatTracker demo collection', () => {
  it('is published: the demo browser lists its songs as three-voice SID songs', () => {
    expect(goattracker?.name).toBe('GoatTracker');
    expect(goattracker?.songs.length).toBeGreaterThan(0);
    for (const song of goattracker?.songs ?? []) {
      expect(song.file).toMatch(/^goattracker\/[^/]+\/[^/]+\.sng$/);
      expect(['GT1', 'GT2']).toContain(song.format);
      expect(song.channels).toBe(3);
    }
  });

  it('a song picked in the browser loads through loadSongFromUrl and plays; the wasm is fetched revalidated', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const song = goattracker?.songs.find((s) => s.file === 'goattracker/mch/alien_funk.sng');
    if (!song) throw new Error('alien_funk.sng is not in the manifest');
    const app = await setupSidApp();
    const fetchMock = serveFromPublic();

    // What DemoSongBrowser emits and TrackerPage's handleDemoSelect loads.
    const url = demoSongUrl(song);
    expect(url).toBe('demos/goattracker/mch/alien_funk.sng');
    await app.host.loadSongFromUrl(url);
    expect(app.trackerStore.moduleFormat).toBe('sid');
    expect(app.trackerStore.isSidEditable).toBe(true);
    expect(app.trackerStore.currentSong.title).toBe(song.title);

    await app.host.play('song', 0);
    await until(() => sidWorkletNodes[0]?.received.some((c) => c.type === 'play') ?? false, 'play');
    const node = sidWorkletNodes[0] as FakeSidWorkletNode;
    node.pump(ROW);
    expect(peak(node.pump(32 * ROW).mix)).toBeGreaterThan(0.05);

    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/wasm\/audio_processor_bg\.wasm$/), { cache: 'no-cache' });
  }, 60000);

  it('a GoatTracker 1 song queued in the jukebox plays through the jukebox player', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const song = goattracker?.songs.find((s) => s.file === 'goattracker/cadaver/dojo.sng');
    if (!song) throw new Error('dojo.sng is not in the manifest');
    expect(song.format).toBe('GT1');
    const app = await setupSidApp();
    serveFromPublic();
    const { useJukeboxPlayer } = await import('src/composables/useJukeboxPlayer');
    const player = useJukeboxPlayer(app.host);

    const index = player.addSong(song);
    await player.playIndex(index);
    expect(app.trackerStore.sidDoc?.songName).toBe('Dojo');
    expect(app.playbackStore.isPlaying).toBe(true);
    await until(() => sidWorkletNodes[0]?.received.some((c) => c.type === 'play') ?? false, 'play');
    const node = sidWorkletNodes[0] as FakeSidWorkletNode;
    node.pump(ROW);
    expect(peak(node.pump(32 * ROW).mix)).toBeGreaterThan(0.05);
    await player.dispose();
  }, 60000);
});
