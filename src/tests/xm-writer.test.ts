import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseXm, writeXm } from '@another-synth/tracker-playback';

const DIR = resolve(__dirname, '../../public/demos/ft2');
// A spread of the corpus rather than all of it.
const files = readdirSync(DIR)
  .filter((f) => f.toLowerCase().endsWith('.xm'))
  .filter((_, i) => i % 6 === 0);

describe('writeXm', () => {
  it('has a corpus', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const file of files) {
    it(`round-trips ${file}`, () => {
      const song = parseXm(new Uint8Array(readFileSync(resolve(DIR, file))));
      const written = writeXm(song);
      const again = parseXm(written);
      expect(again.title).toBe(song.title);
      expect(again.numChannels).toBe(song.numChannels);
      expect(again.songLength).toBe(song.songLength);
      expect(again.restartPosition).toBe(song.restartPosition);
      expect(again.orders).toEqual(song.orders);
      expect(again.linearFrequency).toBe(song.linearFrequency);
      expect(again.defaultSpeed).toBe(song.defaultSpeed);
      expect(again.defaultBpm).toBe(song.defaultBpm);
      expect(JSON.stringify(again.patterns)).toBe(JSON.stringify(song.patterns));
      expect(again.instruments.length).toBe(song.instruments.length);
      song.instruments.forEach((ins, i) => {
        const t = again.instruments[i]!;
        expect(t.name).toBe(ins.name);
        expect(t.samples.length).toBe(ins.samples.length);
        if (ins.samples.length > 0) {
          expect(t.keymap).toEqual(ins.keymap);
          expect(t.volumeEnvelope).toEqual(ins.volumeEnvelope);
          expect(t.panningEnvelope).toEqual(ins.panningEnvelope);
          expect(t.volumeFadeout).toBe(ins.volumeFadeout);
          expect([t.vibratoType, t.vibratoSweep, t.vibratoDepth, t.vibratoRate]).toEqual([
            ins.vibratoType,
            ins.vibratoSweep,
            ins.vibratoDepth,
            ins.vibratoRate,
          ]);
        }
        ins.samples.forEach((s, j) => {
          const u = t.samples[j]!;
          expect(u.name).toBe(s.name);
          expect(u.bits).toBe(s.bits);
          expect([u.volume, u.finetune, u.panning, u.relativeNote, u.loopType]).toEqual([
            s.volume,
            s.finetune,
            s.panning,
            s.relativeNote,
            s.loopType,
          ]);
          expect([u.loopStart, u.loopLength]).toEqual([s.loopStart, s.loopLength]);
          expect(Buffer.from(u.data.buffer).equals(Buffer.from(s.data.buffer))).toBe(true);
        });
      });
      expect(writeXm(again)).toEqual(written);
    }, 30000);
  }
});

describe('writeXm details players depend on', () => {
  const base = () => parseXm(new Uint8Array(readFileSync(resolve(DIR, 'christms.xm'))));

  it('pads names with spaces and keeps the tracker name', () => {
    const song = base();
    const bytes = writeXm(song);
    expect(Buffer.from(bytes.subarray(38, 58)).toString('latin1')).toBe(song.trackerName.padEnd(20, ' '));
    expect(Buffer.from(bytes.subarray(0, 17)).toString('latin1')).toBe('Extended Module: ');
  });

  it('keeps an empty instrument header at the size the file had, and the sample header reserved byte', () => {
    const song = base();
    const empty = song.instruments.findIndex((i) => i.samples.length === 0);
    expect(song.instruments[empty]!.emptyHeaderSize).toBe(33);
    const short = { ...song, instruments: song.instruments.map((i, n) => (n === empty ? { ...i, emptyHeaderSize: 29 } : i)) };
    expect(writeXm(short).length).toBe(writeXm(song).length - 4);
    expect(parseXm(writeXm(short)).instruments[empty]!.emptyHeaderSize).toBe(29);
    const withReserved = song.instruments.find((i) => i.samples.some((s) => s.reserved !== undefined))!;
    const again = parseXm(writeXm(song));
    expect(again.instruments[song.instruments.indexOf(withReserved)]!.samples.map((s) => s.reserved)).toEqual(withReserved.samples.map((s) => s.reserved));
  });

  it('plays a sample with both loop bits set as ping-pong', () => {
    const song = base();
    const bytes = writeXm(song);
    // Find the first sample header (type byte at +14) and set both loop bits.
    const view = new DataView(bytes.buffer);
    let at = 336;
    for (let n = 0; n < song.patterns.length; n++) at += 9 + packedLength(bytes, at);
    const headerSize = view.getUint32(at, true);
    const type = at + headerSize + 14;
    bytes[type] = (bytes[type]! & ~3) | 3;
    expect(parseXm(bytes).instruments.find((i) => i.samples.length > 0)!.samples[0]!.loopType).toBe('pingpong');
  });
});

function packedLength(bytes: Uint8Array, at: number): number {
  return new DataView(bytes.buffer).getUint16(at + 7, true);
}
