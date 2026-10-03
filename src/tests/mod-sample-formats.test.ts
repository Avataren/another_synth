import { describe, expect, it } from 'vitest';
import { emptyModSample } from 'src/audio/tracker/mod-sample-codec';
import { withLoop } from 'src/audio/tracker/mod-sample-ops';
import { amigaFormatOf, looksLike8svx, parse8svx, parseAiff, parseRaw, write8svx, writeAiff, writeRaw } from 'src/audio/tracker/mod-sample-formats';

const sample = () =>
  withLoop(
    { ...emptyModSample(40), name: 'bass', data: Int8Array.from({ length: 100 }, (_, i) => (i * 5) % 200 - 100), length: 100 },
    20,
    60,
  );

describe('IFF 8SVX', () => {
  it('round-trips data, loop, name and volume', () => {
    const bytes = write8svx(sample());
    expect(looksLike8svx(bytes)).toBe(true);
    expect(bytes.length % 2).toBe(0);
    const back = parse8svx(bytes);
    // Bytes past the loop end are not part of an 8SVX body.
    expect(Array.from(back.data)).toEqual(Array.from(sample().data.subarray(0, 80)));
    expect([back.loopStart, back.loopLength]).toEqual([20, 60]);
    expect(back.name).toBe('bass');
    expect(back.volume).toBe(40);
  });

  it('writes an unlooped sample with no repeat part', () => {
    const back = parse8svx(write8svx({ ...sample(), loopStart: 0, loopLength: 0 }));
    expect(back.loopLength).toBe(0);
  });

  it('decodes Fibonacci-delta bodies', () => {
    // header (pad, start value 0), then deltas +1,+1 / 0,-1 -> 1,2,2,1
    const body = Uint8Array.from([0, 0, 0x99, 0x87]);
    const file = new Uint8Array(12 + 28 + 8 + body.length);
    const v = new DataView(file.buffer);
    const put = (at: number, t: string) => [...t].forEach((c, i) => (file[at + i] = c.charCodeAt(0)));
    put(0, 'FORM');
    v.setUint32(4, file.length - 8, false);
    put(8, '8SVX');
    put(12, 'VHDR');
    v.setUint32(16, 20, false);
    v.setUint32(20, 4, false);
    file[12 + 8 + 14] = 1; // one octave
    file[12 + 8 + 15] = 1; // Fibonacci-delta
    v.setUint32(12 + 8 + 16, 0x10000, false);
    put(40, 'BODY');
    v.setUint32(44, body.length, false);
    file.set(body, 48);
    expect(Array.from(parse8svx(file).data)).toEqual([1, 2, 2, 1]);
  });

  it('refuses a file with no body', () => {
    expect(() => parse8svx(write8svx(sample()).slice(0, 40))).toThrow();
  });
});

describe('raw', () => {
  it('round-trips and is chosen by extension', () => {
    expect(Array.from(parseRaw(writeRaw(sample())).data)).toEqual(Array.from(sample().data));
    expect(amigaFormatOf(new Uint8Array(4), 'kick.RAW')).toBe('raw');
    expect(amigaFormatOf(write8svx(sample()), 'x.bin')).toBe('8svx');
    expect(amigaFormatOf(new Uint8Array(4), 'x.wav')).toBeNull();
  });
});

describe('AIFF', () => {
  it('round-trips 8-bit data, rate, name and loop', () => {
    const bytes = writeAiff(sample());
    expect(amigaFormatOf(bytes, 'x.bin')).toBe('aiff');
    const back = parseAiff(bytes);
    expect(back.rate).toBeCloseTo(8287, 3);
    expect(back.bits).toBe(8);
    expect(Array.from(back.data8!)).toEqual(Array.from(sample().data));
    expect(back.name).toBe('bass');
    expect([back.loopStart, back.loopLength]).toEqual([20, 60]);
  });

  it('writes an unlooped sample without loop chunks', () => {
    const back = parseAiff(writeAiff({ ...sample(), loopStart: 0, loopLength: 0 }));
    expect(back.loopLength).toBeUndefined();
  });

  it('reads 16-bit stereo as mono float', () => {
    const file = new Uint8Array(12 + 26 + 16 + 8);
    const v = new DataView(file.buffer);
    const put = (at: number, t: string) => [...t].forEach((c, i) => (file[at + i] = c.charCodeAt(0)));
    put(0, 'FORM');
    v.setUint32(4, file.length - 8, false);
    put(8, 'AIFF');
    put(12, 'COMM');
    v.setUint32(16, 18, false);
    v.setUint16(20, 2, false);
    v.setUint32(22, 2, false);
    v.setUint16(26, 16, false);
    v.setUint16(28, 0x400e, false); // 80-bit float: 44100 = 0xAC44 * 2^-48 * 2^15
    v.setBigUint64(30, 0xac44000000000000n, false);
    put(38, 'SSND');
    v.setUint32(42, 16, false); // 8 bytes of offset/block size + 8 of audio
    [16384, -16384, 32767, 0].forEach((x, i) => v.setInt16(54 + i * 2, x, false));
    const back = parseAiff(file);
    expect(back.rate).toBeCloseTo(44100, 3);
    expect(back.channels).toBe(2);
    expect(back.pcm.length).toBe(2);
    expect(back.pcm[0]).toBeCloseTo(0, 5);
    expect(back.pcm[1]).toBeCloseTo(0.5, 3);
  });
});
