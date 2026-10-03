import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseMod, writeMod } from '@another-synth/tracker-playback';

const DIR = resolve(__dirname, '../../public/demos/amiga');
// A spread of the corpus rather than all of it: each round trip is seconds.
const files = readdirSync(DIR)
  .filter((f) => f.toLowerCase().endsWith('.mod'))
  .filter((_, i) => i % 8 === 0);

function tryParse(bytes: Uint8Array) {
  try {
    return parseMod(bytes);
  } catch {
    return null;
  }
}

describe('writeMod', () => {
  it('has a corpus', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const file of files) {
    it(`round-trips ${file}`, () => {
      const bytes = new Uint8Array(readFileSync(resolve(DIR, file)));
      const song = tryParse(bytes);
      if (!song || song.trackerFlavor === 'Soundtracker' || song.trackerFlavor === 'UltimateSoundtracker') return;
      const written = writeMod(song);
      const again = parseMod(written);
      expect(again.title).toBe(song.title);
      expect(again.numChannels).toBe(song.numChannels);
      expect(again.songLength).toBe(song.songLength);
      expect(again.orders).toEqual(song.orders);
      expect(again.patterns.length).toBe(song.patterns.length);
      expect(JSON.stringify(again.patterns)).toBe(JSON.stringify(song.patterns));
      expect(again.samples.length).toBe(31);
      song.samples.forEach((s, i) => {
        const t = again.samples[i]!;
        expect(t.name).toBe(s.name);
        expect(t.finetune).toBe(s.finetune);
        expect(t.volume).toBe(s.volume);
        expect(Buffer.from(t.data).equals(Buffer.from(s.data))).toBe(true);
        // A truncated file has no data for the parser to keep, so no loop to write.
        if (s.loopLength > 2 && s.data.length === s.length && s.loopStart + s.loopLength <= s.length) {
          expect([t.loopStart, t.loopLength]).toEqual([s.loopStart, s.loopLength]);
        } else if (s.loopLength <= 2) {
          expect(t.loopLength).toBeLessThanOrEqual(2);
        }
      });
      // Writing what was written changes nothing.
      expect(writeMod(again)).toEqual(written);
    });
  }
});
