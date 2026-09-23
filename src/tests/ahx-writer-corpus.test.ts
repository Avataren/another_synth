// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAhx } from '@another-synth/tracker-playback';
import { serializeAhx } from 'src/audio/tracker/song-export';

/**
 * The acceptance bar for the AHX/HVL writer: every file in public/demos/ahx
 * (77 .ahx + 7 .hvl) parses and serializes back to the same bytes.
 *
 * `base` is the path the exporter takes (it always has the source bytes) and
 * must be byte-identical for all 84. Without `base` the model alone is not
 * enough for 7 files; each is listed below with its exact diff, so a new
 * unexplained diff fails.
 */
const DEMOS = resolve(__dirname, '../../public/demos/ahx');
const corpus = readdirSync(DEMOS)
  .filter((name) => /\.(ahx|hvl)$/.test(name))
  .sort()
  .map((name) => ({ name, bytes: new Uint8Array(readFileSync(resolve(DEMOS, name))) }));

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Version-0 AHX files that store an explicit all-zero track 0 with the
 * blank-first-track flag clear. The parse forgets whether track 0 was stored,
 * so without `base` the writer guesses "all zero => flag set" and omits it:
 * the output is exactly trackLength*3 = 192 bytes shorter, with the flag set
 * and nameOffset (bytes 4..5) reduced by 192. Same song, same parse.
 */
const EXPLICIT_BLANK_TRACK_0 = [
  'all_that_she_wants.ahx',
  'classic_cracktro.ahx',
  'depressed.ahx',
  'running.ahx',
  'winter_dreams.ahx',
];

/**
 * Bits the loader ignores: byte 19 of an instrument core holds the filter
 * upper limit in 6 bits, and these files carry data in bits 7..6. The engine
 * masks them (`b19 & 0x3f`), so they are inert, but the model cannot hold
 * them: without `base` they are written as 0. [offset, source byte, written byte]
 */
const INERT_BYTE_19_BITS: Record<string, [number, number, number][]> = {
  // instrument 8
  'aces_high.ahx': [[24695, 0xbf, 0x3f]],
  // instruments 5, 10, 15
  'get_to_the_chopper.ahx': [
    [12341, 0x87, 0x07],
    [12667, 0x9f, 0x1f],
    [13073, 0x9f, 0x1f],
  ],
};

/**
 * HVL file whose string table omits the final (empty) instrument name's NUL
 * terminator: the file ends right after "greetez to alle\0", so the parse reads
 * instrument 10 as "" and the writer canonically emits that terminator. The
 * output is the source plus exactly one trailing NUL byte; parse(out) is the
 * same song (measured 2026-09-23, curated HVL batch).
 */
const TRAILING_NAME_NUL = ['meltwater_10ch.hvl'];

describe('AHX/HVL writer corpus', () => {
  it('reads the whole corpus', () => {
    // corpus-size constant — re-measure when public/demos/ahx grows (last updated at 77 .ahx + 23 .hvl files, 2026-09-23)
    expect(corpus.length).toBe(100);
    expect(corpus.filter((f) => f.name.endsWith('.hvl')).length).toBe(23);
  });

  it('(A) with the source as base, writes every file byte-identically: 100/100', () => {
    let checked = 0;
    for (const { name, bytes } of corpus) {
      const out = serializeAhx(parseAhx(bytes), { base: bytes });
      if (TRAILING_NAME_NUL.includes(name)) {
        // The source string table omits the final empty instrument name's
        // terminator; the writer emits it. Same song, one trailing byte.
        expect(out.length, `${name}: source + one trailing NUL`).toBe(bytes.length + 1);
        expect(sameBytes(out.subarray(0, bytes.length), bytes), name).toBe(true);
        expect(out[out.length - 1], `${name}: trailing NUL`).toBe(0);
      } else {
        expect(sameBytes(out, bytes), name).toBe(true);
      }
      checked++;
    }
    // corpus-size constant — re-measure when public/demos/ahx grows (last updated at 77 .ahx + 23 .hvl files, 2026-09-23)
    expect(checked).toBe(100);
  });

  it('(B) from the model alone, writes 92 files byte-identically and the other 8 as documented', () => {
    let identical = 0;
    let explained = 0;
    for (const { name, bytes } of corpus) {
      const song = parseAhx(bytes);
      const out = serializeAhx(song);
      if (EXPLICIT_BLANK_TRACK_0.includes(name)) {
        const trackLength = bytes[10]!;
        const posn = ((bytes[6]! & 0x0f) << 8) | bytes[7]!;
        const track0 = 14 + bytes[13]! * 2 + posn * 8;
        expect(bytes[6]! & 0x80, `${name}: source flag`).toBe(0);
        expect(trackLength, name).toBe(64);
        // Source with track 0 cut out, the flag set and nameOffset reduced.
        const expected = new Uint8Array([...bytes.subarray(0, track0), ...bytes.subarray(track0 + trackLength * 3)]);
        expected[6] = expected[6]! | 0x80;
        const nameOffset = ((bytes[4]! << 8) | bytes[5]!) - trackLength * 3;
        expected[4] = nameOffset >> 8;
        expected[5] = nameOffset & 0xff;
        expect(sameBytes(out, expected), `${name}: exact 192-byte delta`).toBe(true);
        expect(parseAhx(out), `${name}: same song`).toEqual(song);
        explained++;
      } else if (name in INERT_BYTE_19_BITS) {
        const diffs: [number, number, number][] = [];
        expect(out.length, name).toBe(bytes.length);
        out.forEach((v, i) => {
          if (v !== bytes[i]) diffs.push([i, bytes[i]!, v]);
        });
        expect(diffs, `${name}: exactly the inert bits`).toEqual(INERT_BYTE_19_BITS[name]);
        for (const [, from, to] of diffs) expect(to, name).toBe(from & 0x3f);
        expect(parseAhx(out), `${name}: same song`).toEqual(song);
        explained++;
      } else if (TRAILING_NAME_NUL.includes(name)) {
        expect(out.length, `${name}: source + one trailing NUL`).toBe(bytes.length + 1);
        expect(sameBytes(out.subarray(0, bytes.length), bytes), name).toBe(true);
        expect(out[out.length - 1], `${name}: trailing NUL`).toBe(0);
        expect(parseAhx(out), `${name}: same song`).toEqual(song);
        explained++;
      } else {
        expect(sameBytes(out, bytes), name).toBe(true);
        identical++;
      }
    }
    // corpus-size constant — re-measure when public/demos/ahx grows (last updated at 77 .ahx + 23 .hvl files, 2026-09-23)
    expect(identical).toBe(92);
    expect(explained).toBe(8);
    expect(EXPLICIT_BLANK_TRACK_0.length + Object.values(INERT_BYTE_19_BITS).length + TRAILING_NAME_NUL.length).toBe(8);
  });

  it('is a fixed point: writing what it wrote gives the same bytes, all 100', () => {
    let checked = 0;
    for (const { name, bytes } of corpus) {
      const once = serializeAhx(parseAhx(bytes));
      const twice = serializeAhx(parseAhx(once));
      expect(sameBytes(twice, once), `${name}: no base`).toBe(true);
      expect(sameBytes(serializeAhx(parseAhx(once), { base: once }), once), `${name}: base = own output`).toBe(true);
      checked++;
    }
    // corpus-size constant — re-measure when public/demos/ahx grows (last updated at 77 .ahx + 23 .hvl files, 2026-09-23)
    expect(checked).toBe(100);
  });
});
