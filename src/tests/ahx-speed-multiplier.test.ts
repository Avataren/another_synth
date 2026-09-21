// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAhx } from '@another-synth/tracker-playback';
import { ahxSpeedMultiplierOf } from 'src/audio/tracker/ahx-source';

/**
 * The playhead clock's tick length comes from the song's speed multiplier, read
 * from the header byte the playback store has in hand. The parser is the
 * reference: they must agree on every song of the demo corpus (AHX and HVL).
 */
describe('ahxSpeedMultiplierOf', () => {
  const dir = resolve(__dirname, '../../public/demos/ahx');
  const files = readdirSync(dir).filter((f) => /\.(ahx|hvl)$/i.test(f));

  it('agrees with the parser on every corpus song, and the corpus has all of x1, x2 and x3', () => {
    const seen = new Set<number>();
    let checked = 0;
    for (const file of files) {
      const bytes = new Uint8Array(readFileSync(resolve(dir, file)));
      const song = parseAhx(bytes);
      expect(ahxSpeedMultiplierOf(bytes), file).toBe(song.speedMultiplier);
      seen.add(song.speedMultiplier);
      checked += 1;
    }
    expect(checked).toBe(files.length);
    expect(checked).toBeGreaterThanOrEqual(69);
    for (const m of [1, 2, 3]) expect(seen.has(m)).toBe(true);
  });

  it('reads bits 5-6 of header byte 6 (1..4), and 1 for a header too short to have one', () => {
    expect(ahxSpeedMultiplierOf(new Uint8Array([0x54, 0x48, 0x58, 0, 0, 0, 0x00]))).toBe(1);
    expect(ahxSpeedMultiplierOf(new Uint8Array([0x54, 0x48, 0x58, 0, 0, 0, 0x20]))).toBe(2);
    expect(ahxSpeedMultiplierOf(new Uint8Array([0x54, 0x48, 0x58, 0, 0, 0, 0x40]))).toBe(3);
    expect(ahxSpeedMultiplierOf(new Uint8Array([0x54, 0x48, 0x58, 0, 0, 0, 0x60]))).toBe(4);
    // Bit 7 (blank first track) and the low nibble (the position count's high bits) are not the multiplier.
    expect(ahxSpeedMultiplierOf(new Uint8Array([0x54, 0x48, 0x58, 0, 0, 0, 0x8f]))).toBe(1);
    expect(ahxSpeedMultiplierOf(new Uint8Array([0x54, 0x48, 0x58]))).toBe(1);
  });
});
