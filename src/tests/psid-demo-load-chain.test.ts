import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { demoSongUrl, type DemoCollection } from 'src/composables/useDemoManifest';
import { SID_CYCLES_PER_FRAME, SID_PAL_CLOCK_HZ } from 'src/audio/tracker/sid-instrument-visuals';
import { initSidWasm, peak, setupSidApp, sidWorkletNodes, teardownSidApp, until, type FakeSidWorkletNode } from './helpers/sid-worklet-harness';

/**
 * The C64 SID demo collection (plan-psid-import.md): a `.sid` picked in the
 * demo browser takes the same road as a dropped one. The tracker page hands
 * the browser's URL (`demos/<manifest file>`) to `loadSongFromUrl`, which
 * fetches it and goes through `parseSongBuffer`'s PSID/RSID dispatch; the
 * jukebox queues the manifest entry and plays it through `parseSongBuffer`
 * -> `applySongFile` -> `play`. Both run here against the published files in
 * `public/demos`, served by a stand-in `fetch`, over the real SID core.
 */

const PUBLIC = resolve(__dirname, '../../public');
/** One row, tempo 6 PAL frames. */
const ROW = Math.round((6 * 44_100 * SID_CYCLES_PER_FRAME) / SID_PAL_CLOCK_HZ);

beforeAll(() => initSidWasm());
afterEach(() => teardownSidApp());

describe('the C64 SID demo collection', () => {
  const manifest = JSON.parse(readFileSync(resolve(PUBLIC, 'demos/index.json'), 'utf8')) as { collections: DemoCollection[] };
  const sids = manifest.collections.find((c) => c.id === 'sid');

  /** `fetch` over `public/`, the way the dev server and the deploy serve it. */
  const serveFromPublic = (): void => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => new Response(readFileSync(resolve(PUBLIC, String(url).replace(/^\//, ''))), { status: 200 })),
    );
  };

  it('is published: the demo browser lists the tunes by name and composer, as three-voice PSID/RSID songs', () => {
    expect(sids?.name).toBe('C64 SID');
    expect(sids?.songs.length).toBeGreaterThanOrEqual(16);
    for (const song of sids?.songs ?? []) {
      expect(song.file).toMatch(/^sid\/[^/]+\/[^/]+\.sid$/);
      expect(['PSID', 'RSID']).toContain(song.format);
      expect(song.channels).toBe(3);
    }
    expect(sids?.songs.map((s) => s.title)).toContain('Commando · Rob Hubbard');
    expect(sids?.songs.map((s) => s.title)).toContain('Golden Axe · Jeroen Tel');
  });

  it('a tune picked in the browser loads through loadSongFromUrl as an editable SID song and plays', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const song = sids?.songs.find((s) => s.file === 'sid/hubbard_rob/commando.sid');
    if (!song) throw new Error('commando.sid is not in the manifest');
    const app = await setupSidApp();
    serveFromPublic();
    await app.host.loadSongFromUrl(demoSongUrl(song));
    expect(app.trackerStore.moduleFormat).toBe('sid');
    expect(app.trackerStore.isSidEditable).toBe(true);
    expect(app.trackerStore.currentSong.title).toBe('Commando');
    await app.host.play('song', 0);
    await until(() => sidWorkletNodes[0]?.received.some((c) => c.type === 'play') ?? false, 'play');
    const node = sidWorkletNodes[0] as FakeSidWorkletNode;
    node.pump(ROW);
    expect(peak(node.pump(32 * ROW).mix)).toBeGreaterThan(0.05);
  }, 60000);

  it('a tune queued in the jukebox plays through the jukebox player', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const song = sids?.songs.find((s) => s.file === 'sid/tel_jeroen/robocop_3.sid');
    if (!song) throw new Error('robocop_3.sid is not in the manifest');
    const app = await setupSidApp();
    serveFromPublic();
    const { useJukeboxPlayer } = await import('src/composables/useJukeboxPlayer');
    const player = useJukeboxPlayer(app.host);
    const index = player.addSong(song);
    await player.playIndex(index);
    expect(app.trackerStore.sidDoc?.songName).toBe('RoboCop 3');
    expect(app.trackerStore.sidDoc?.chipModel).toBe('8580');
    expect(app.playbackStore.isPlaying).toBe(true);
    await until(() => sidWorkletNodes[0]?.received.some((c) => c.type === 'play') ?? false, 'play');
    const node = sidWorkletNodes[0] as FakeSidWorkletNode;
    node.pump(ROW);
    expect(peak(node.pump(32 * ROW).mix)).toBeGreaterThan(0.05);
    await player.dispose();
  }, 60000);
});
