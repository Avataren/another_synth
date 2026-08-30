import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseMod } from '../../packages/tracker-playback/src/mod-parser';
import { parseXm } from '../../packages/tracker-playback/src/formats/xm';
import { TOTAL_SLOTS } from 'src/stores/tracker-store';

/**
 * The demo modules are committed and served as-is, so nothing between the
 * download and the browser would notice a truncated or corrupt file -- it
 * would simply fail to load for whoever clicked it.
 *
 * They arrive by hand, dropped into public/demos and indexed, which is exactly
 * the path that has already produced a half-finished download and two
 * byte-identical duplicates. This walks the published collection and parses
 * every entry the way the app does.
 */

const DEMOS = path.resolve(__dirname, '../../public/demos');

interface Manifest {
  collections: Array<{
    id: string;
    songs: Array<{ file: string; title: string; format: string; bytes: number }>;
  }>;
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(DEMOS, 'index.json'), 'utf8'),
) as Manifest;

const songs = manifest.collections.flatMap((c) => c.songs);

describe('instrument slots', () => {
  /**
   * Running out of slots does not fail an import -- it drops the instrument,
   * and a note referencing a dropped instrument then carries no instrument at
   * all, so the channel keeps playing whatever sample it had. The song plays
   * on with the wrong sound and nothing says so.
   *
   * radix_-_yuki_satellites.xm references 98 instruments against a limit of
   * 65, and a third of its instruments came out as some other sample.
   */
  const xms = fs
    .readdirSync(path.join(DEMOS, 'ft2'))
    .filter((f) => /\.xm$/i.test(f))
    .map(
      (f) =>
        [
          f,
          parseXm(new Uint8Array(fs.readFileSync(path.join(DEMOS, 'ft2', f)))),
        ] as const,
    );

  it('holds every instrument the format allows', () => {
    // Sizing to the corpus is what failed before. XM's own maximum is 128.
    expect(TOTAL_SLOTS).toBeGreaterThanOrEqual(128);
  });

  it.each(xms)('has room for every instrument %s references', (_name, xm) => {
    const referenced = new Set<number>();
    for (const pattern of xm.patterns) {
      for (const row of pattern.rows) {
        for (const cell of row) {
          if (cell.instrument > 0) referenced.add(cell.instrument);
        }
      }
    }

    expect(referenced.size).toBeLessThanOrEqual(TOTAL_SLOTS);
  });
});

describe('the published demo collection', () => {
  it('lists something', () => {
    expect(songs.length).toBeGreaterThan(0);
  });

  it('lists every module that is on disk, and no module that is not', () => {
    const listed = new Set(songs.map((s) => s.file));
    const onDisk = new Set<string>();
    for (const collection of manifest.collections) {
      for (const file of fs.readdirSync(path.join(DEMOS, collection.id))) {
        // Only the formats the importer reads. Anything else is deliberately
        // left out of the manifest rather than published unreachable.
        if (!/\.(mod|xm)$/i.test(file)) continue;
        onDisk.add(`${collection.id}/${file}`);
      }
    }

    expect([...listed].sort()).toEqual([...onDisk].sort());
  });

  it('holds no byte-identical duplicates', () => {
    // A module downloaded twice lists the same song twice in the browser.
    const seen = new Map<string, string[]>();
    for (const song of songs) {
      const bytes = fs.readFileSync(path.join(DEMOS, song.file));
      // Length plus the header is enough to catch a re-download without
      // hashing ten megabytes of sample data on every run.
      const key = `${bytes.length}:${bytes.subarray(0, 1084).toString('base64')}`;
      seen.set(key, [...(seen.get(key) ?? []), song.file]);
    }

    const duplicates = [...seen.values()].filter((files) => files.length > 1);
    expect(duplicates).toEqual([]);
  });

  it.each(songs.map((song) => [song.file, song] as const))(
    'parses %s',
    (_file, song) => {
      const bytes = fs.readFileSync(path.join(DEMOS, song.file));

      // A truncated download is the failure this is really watching for, and
      // it shows up first as a size that disagrees with the manifest.
      expect(bytes.length).toBe(song.bytes);

      if (song.format === 'XM') {
        const xm = parseXm(new Uint8Array(bytes));
        expect(xm.patterns.length).toBeGreaterThan(0);
        expect(xm.numChannels).toBeGreaterThan(0);
        expect(xm.songLength).toBeGreaterThan(0);
      } else {
        const mod = parseMod(new Uint8Array(bytes));
        expect(mod.patterns.length).toBeGreaterThan(0);
        expect(mod.numChannels).toBeGreaterThan(0);
        expect(mod.songLength).toBeGreaterThan(0);
        expect(mod.samples.length).toBeGreaterThan(0);
      }
    },
  );
});
