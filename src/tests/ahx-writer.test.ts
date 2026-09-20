// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  parseAhx,
  type AhxInstrument,
  type AhxPListEntry,
  type AhxSong,
  type AhxStep,
  type AhxTrack,
} from '@another-synth/tracker-playback';
import { AhxEncodeError, serializeAhx } from 'src/audio/tracker/song-export';

const step = (o: Partial<AhxStep> = {}): AhxStep => ({ note: 0, instrument: 0, fx: 0, fxParam: 0, fxb: 0, fxbParam: 0, ...o });
const blankTrack = (length: number): AhxTrack => Array.from({ length }, () => step());
const entry = (o: Partial<AhxPListEntry> = {}): AhxPListEntry => ({
  note: 0,
  waveform: 0,
  fixed: false,
  fx: [0, 0],
  fxParam: [0, 0],
  ...o,
});
const ins = (o: Partial<AhxInstrument> = {}): AhxInstrument => ({
  name: '',
  volume: 64,
  waveLength: 3,
  filterLowerLimit: 0,
  filterUpperLimit: 0,
  filterSpeed: 0,
  squareLowerLimit: 0,
  squareUpperLimit: 0,
  squareSpeed: 0,
  vibratoDelay: 0,
  vibratoSpeed: 0,
  vibratoDepth: 0,
  hardCutRelease: false,
  hardCutReleaseFrames: 0,
  envelope: { aFrames: 1, aVolume: 64, dFrames: 1, dVolume: 32, sFrames: 0, rFrames: 1, rVolume: 0 },
  plist: { speed: 1, entries: [] },
  ...o,
});
/** Index 0 of `instruments`: the placeholder the parser emits. */
const placeholder = (): AhxInstrument =>
  ins({
    volume: 0,
    waveLength: 0,
    envelope: { aFrames: 0, aVolume: 0, dFrames: 0, dVolume: 0, sFrames: 0, rFrames: 0, rVolume: 0 },
    plist: { speed: 0, entries: [] },
  });

/** 1 position, 2 tracks (track 0 blank), 1 instrument; the smallest interesting AHX. */
function ahxSong(o: Partial<AhxSong> = {}): AhxSong {
  return {
    format: 'ahx',
    version: 1,
    name: 'song',
    channels: 4,
    positionNr: 1,
    restart: 0,
    speedMultiplier: 1,
    trackLength: 2,
    trackNr: 1,
    instrumentNr: 1,
    subsongNr: 0,
    subsongs: [],
    positions: [{ track: [1, 1, 1, 1], transpose: [0, 0, 0, 0] }],
    tracks: [blankTrack(2), [step({ note: 13, instrument: 1, fx: 3, fxParam: 5 }), step()]],
    instruments: [placeholder(), ins({ name: 'lead' })],
    ...o,
  };
}

function hvlSong(o: Partial<AhxSong> = {}): AhxSong {
  return ahxSong({
    format: 'hvl',
    version: 1,
    channels: 6,
    positions: [{ track: [1, 1, 1, 1, 1, 1], transpose: [0, 0, 0, 0, 0, 0] }],
    mixgainRaw: 0x40,
    defstereo: 0x20,
    ...o,
  });
}

const positions = (count: number, channels = 4) =>
  Array.from({ length: count }, () => ({
    track: Array(channels).fill(0) as number[],
    transpose: Array(channels).fill(0) as number[],
  }));

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const nameOffsetOf = (bytes: Uint8Array): number => (bytes[4]! << 8) | bytes[5]!;

describe('serializeAhx: AHX header', () => {
  const out = serializeAhx(ahxSong());
  it('lays the whole small song out byte for byte', () => {
    // header 14 + 1 position (8) + track 1 (6; track 0 omitted, flag set) + instrument (22) = 50 = nameOffset
    expect([...out.subarray(0, 14)]).toEqual([0x54, 0x48, 0x58, 1, 0, 50, 0x80, 1, 0, 0, 2, 1, 1, 0]);
    expect([...out.subarray(14, 22)]).toEqual([1, 0, 1, 0, 1, 0, 1, 0]);
    expect([...out.subarray(22, 28)]).toEqual([13 << 2, (1 << 4) | 3, 5, 0, 0, 0]);
    expect(out.length).toBe(50 + ascii('song').length + 1 + ascii('lead').length + 1);
    expect([...out.subarray(50)]).toEqual([...ascii('song'), 0, ...ascii('lead'), 0]);
  });

  it('writes the version byte', () => {
    for (const version of [0, 1, 2]) expect(serializeAhx(ahxSong({ version }))[3]).toBe(version);
  });

  it('packs speedMultiplier 1..4 into bits 6..5 of byte 6', () => {
    for (const speedMultiplier of [1, 2, 3, 4]) {
      const b6 = serializeAhx(ahxSong({ speedMultiplier }))[6]!;
      expect((b6 >> 5) & 3, `speed ${speedMultiplier}`).toBe(speedMultiplier - 1);
      expect(b6 & 0x10, 'bit 4 stays clear').toBe(0);
    }
  });

  it('splits positionNr across the low nibble of byte 6 and byte 7', () => {
    for (const [n, hi, lo] of [
      [0, 0, 0],
      [1, 0, 1],
      [255, 0, 255],
      [256, 1, 0],
      [1000, 3, 232],
    ] as const) {
      const bytes = serializeAhx(ahxSong({ positionNr: n, positions: positions(n), tracks: [blankTrack(2), blankTrack(2)] }));
      expect(bytes[6]! & 0x0f, `positionNr ${n}`).toBe(hi);
      expect(bytes[7], `positionNr ${n}`).toBe(lo);
      expect(parseAhx(bytes).positionNr).toBe(n);
    }
  });

  it('writes restart big-endian in bytes 8..9, as given (no clamp)', () => {
    const bytes = serializeAhx(ahxSong({ restart: 0x1234 }));
    expect([bytes[8], bytes[9]]).toEqual([0x12, 0x34]);
  });

  it('places trackLength, trackNr (last index), instrumentNr and subsongNr at 10..13', () => {
    const bytes = serializeAhx(
      ahxSong({
        trackLength: 3,
        trackNr: 2,
        instrumentNr: 2,
        subsongNr: 1,
        subsongs: [0x0102],
        tracks: [blankTrack(3), blankTrack(3), blankTrack(3)],
        instruments: [placeholder(), ins({ name: 'a' }), ins({ name: 'b' })],
      }),
    );
    expect([...bytes.subarray(10, 14)]).toEqual([3, 2, 2, 1]);
    expect([...bytes.subarray(14, 16)]).toEqual([1, 2]);
  });

  it('computes nameOffset as the byte length before the string table', () => {
    const bytes = serializeAhx(ahxSong({ instruments: [placeholder(), ins({ name: 'a much longer instrument name' })] }));
    expect(nameOffsetOf(bytes)).toBe(50);
    expect(bytes.length - 50).toBe('song'.length + 1 + 'a much longer instrument name'.length + 1);
  });
});

describe('serializeAhx: AHX packing', () => {
  it('splits the instrument across two step bytes (2 + 4 bits) and packs note/fx/param', () => {
    for (const note of [0, 1, 60, 63]) {
      for (const instrument of [0, 15, 16, 63]) {
        const track = [step({ note, instrument, fx: 15, fxParam: 255 }), step({ note: 1, instrument: 1 })];
        const bytes = serializeAhx(ahxSong({ tracks: [blankTrack(2), track] }));
        expect([...bytes.subarray(22, 25)], `note ${note} instrument ${instrument}`).toEqual([
          (note << 2) | (instrument >> 4),
          ((instrument & 15) << 4) | 15,
          255,
        ]);
        expect(parseAhx(bytes).tracks[1]![0]).toEqual(track[0]);
      }
    }
  });

  it('writes fx 0 and param 0', () => {
    const bytes = serializeAhx(ahxSong({ tracks: [blankTrack(2), [step({ note: 5, instrument: 2 }), step()]] }));
    expect([...bytes.subarray(22, 25)]).toEqual([5 << 2, 2 << 4, 0]);
  });

  it('writes transpose as two’s complement bytes', () => {
    const bytes = serializeAhx(ahxSong({ positions: [{ track: [1, 1, 1, 1], transpose: [-128, -1, 0, 127] }] }));
    expect([...bytes.subarray(14, 22)]).toEqual([1, 0x80, 1, 0xff, 1, 0, 1, 0x7f]);
    expect(parseAhx(bytes).positions[0]!.transpose).toEqual([-128, -1, 0, 127]);
  });

  it('writes subsong starts as two bytes each', () => {
    const bytes = serializeAhx(ahxSong({ subsongNr: 2, subsongs: [0, 0xffff] }));
    expect([...bytes.subarray(14, 18)]).toEqual([0, 0, 0xff, 0xff]);
  });

  it('remaps PList commands 12 and 15 to the 3-bit codes 6 and 7', () => {
    const plist = {
      speed: 1,
      entries: [entry({ fx: [12, 15], fxParam: [9, 8] }), entry({ fx: [5, 0], waveform: 5, note: 60, fixed: true })],
    };
    const bytes = serializeAhx(ahxSong({ instruments: [placeholder(), ins({ plist })] }));
    const core = 14 + 8 + 6; // header, position, track 1
    expect(nameOffsetOf(bytes)).toBe(core + 22 + 8);
    expect([...bytes.subarray(core + 22, core + 26)]).toEqual([(7 << 5) | (6 << 2), 0, 9, 8]);
    expect(parseAhx(bytes).instruments[1]!.plist.entries).toEqual(plist.entries);
  });

  it('strips the high nibble of a version-0 filter-toggle parameter, as the loader does', () => {
    const plist = { speed: 1, entries: [entry({ fx: [4, 4], fxParam: [0x35, 0xa2] })] };
    const v0 = serializeAhx(ahxSong({ version: 0, instruments: [placeholder(), ins({ plist })] }));
    expect(parseAhx(v0).instruments[1]!.plist.entries[0]!.fxParam).toEqual([0x05, 0x02]);
    const v1 = serializeAhx(ahxSong({ version: 1, instruments: [placeholder(), ins({ plist })] }));
    expect(parseAhx(v1).instruments[1]!.plist.entries[0]!.fxParam).toEqual([0x35, 0xa2]);
  });
});

describe('serializeAhx: blank-first-track flag', () => {
  const blank0 = ahxSong();
  const content0 = ahxSong({ tracks: [[step({ note: 1, instrument: 1 }), step()], blankTrack(2)] });

  it('without a base, sets the flag and omits track 0 iff track 0 is all zero', () => {
    const blank = serializeAhx(blank0);
    expect(blank[6]! & 0x80).toBe(0x80);
    const content = serializeAhx(content0);
    expect(content[6]! & 0x80).toBe(0);
    expect(content.length).toBe(blank.length + 2 * 3); // track 0 written in full
    expect(parseAhx(content)).toEqual(content0);
  });

  it('with a base, takes the flag from the base: clear keeps an all-zero track 0', () => {
    const baseClear = serializeAhx(content0);
    const out = serializeAhx(blank0, { base: baseClear });
    expect(out[6]! & 0x80).toBe(0);
    expect(out.length).toBe(serializeAhx(blank0).length + 6);
    expect(parseAhx(out)).toEqual(blank0);
  });

  it('with a base, takes the flag from the base: set omits an all-zero track 0', () => {
    const baseSet = serializeAhx(blank0);
    const out = serializeAhx(blank0, { base: baseSet });
    expect(out[6]! & 0x80).toBe(0x80);
    expect(out).toEqual(baseSet);
  });

  it('refuses a set flag over a track 0 with content: the file would drop real rows', () => {
    const baseSet = serializeAhx(blank0);
    expect(() => serializeAhx(content0, { base: baseSet })).toThrow(AhxEncodeError);
    expect(() => serializeAhx(content0, { base: baseSet })).toThrow(/blank-first-track/);
  });
});

describe('serializeAhx: string table', () => {
  it('writes an empty name as a lone NUL and no trailing padding', () => {
    const bytes = serializeAhx(ahxSong({ name: '', instruments: [placeholder(), ins({ name: '' })] }));
    expect([...bytes.subarray(nameOffsetOf(bytes))]).toEqual([0, 0]);
    expect(parseAhx(bytes).name).toBe('');
  });

  it('writes 8-bit characters as one byte each', () => {
    const name = 'Café ÿ';
    const bytes = serializeAhx(ahxSong({ name, instruments: [placeholder(), ins({ name: 'åäö' })] }));
    const at = nameOffsetOf(bytes);
    expect([...bytes.subarray(at, at + 7)]).toEqual([0x43, 0x61, 0x66, 0xe9, 0x20, 0xff, 0x80]);
    const back = parseAhx(bytes);
    expect(back.name).toBe(name);
    expect(back.instruments[1]!.name).toBe('åäö');
  });

  it('refuses a NUL or a character above U+00FF in any name', () => {
    expect(() => serializeAhx(ahxSong({ name: `a${String.fromCharCode(0)}b` }))).toThrow(/NUL/);
    expect(() => serializeAhx(ahxSong({ name: 'aĀ' }))).toThrow(/above U\+00FF/);
    expect(() => serializeAhx(ahxSong({ instruments: [placeholder(), ins({ name: '☃' })] }))).toThrow(/instrument 1 name/);
  });
});

describe('serializeAhx: normalizations that stay normalized', () => {
  it('the parse clamps restart >= positionNr and an AHX subsong start >= positionNr; the writer then writes the clamped values', () => {
    const raw = serializeAhx(
      ahxSong({ positionNr: 2, positions: positions(2), restart: 5, subsongNr: 1, subsongs: [9], tracks: [blankTrack(2), blankTrack(2)] }),
    );
    expect([raw[8], raw[9]]).toEqual([0, 5]); // the writer does not clamp
    const song = parseAhx(raw);
    expect(song.restart).toBe(1);
    expect(song.subsongs).toEqual([0]);
    const again = serializeAhx(song);
    expect([again[8], again[9]]).toEqual([0, 1]);
    expect([again[14], again[15]]).toEqual([0, 0]);
  });

  it('HVL: subsong starts are not clamped (the writer writes them as given); the parse clamps restart, as in AHX', () => {
    const raw = serializeAhx(
      hvlSong({ positionNr: 2, positions: positions(2, 6), restart: 7, subsongNr: 1, subsongs: [0x0200], tracks: [blankTrack(2), blankTrack(2)] }),
    );
    expect(raw[9]).toBe(7); // the writer does not clamp
    const song = parseAhx(raw);
    expect(song.subsongs).toEqual([0x0200]);
    expect(song.restart).toBe(1);
    expect([...serializeAhx(song).subarray(16, 18)]).toEqual([2, 0]);
  });
});

describe('serializeAhx: HVL', () => {
  it('writes the 16-byte header: channels and restart share byte 8, mixgain and defstereo follow', () => {
    const bytes = serializeAhx(hvlSong());
    expect([...bytes.subarray(0, 4)]).toEqual([0x48, 0x56, 0x4c, 1]);
    expect(bytes[8]).toBe((6 - 4) << 2);
    expect([bytes[14], bytes[15]]).toEqual([0x40, 0x20]);
    expect(bytes[6]! & 0x80).toBe(0x80); // blank track 0 -> flag
  });

  it('accepts 4, 7, 16 and up to 67 channels, each position carrying that many', () => {
    for (const channels of [4, 7, 16, 67]) {
      const song = hvlSong({ channels, positions: [{ track: Array(channels).fill(1) as number[], transpose: Array(channels).fill(0) as number[] }] });
      const bytes = serializeAhx(song);
      expect(bytes[8]! >> 2, `channels ${channels}`).toBe(channels - 4);
      expect(parseAhx(bytes)).toEqual(song);
    }
    expect(() => serializeAhx(hvlSong({ channels: 68, positions: positions(1, 68) }))).toThrow(AhxEncodeError);
    expect(() => serializeAhx(hvlSong({ channels: 3, positions: positions(1, 3) }))).toThrow(AhxEncodeError);
  });

  it('writes the restart across 10 bits (low 2 bits of byte 8 + byte 9)', () => {
    const bytes = serializeAhx(hvlSong({ restart: 0x3ff }));
    expect(bytes[8]! & 3).toBe(3);
    expect(bytes[9]).toBe(0xff);
    expect([...serializeAhx(hvlSong({ restart: 0x102 })).subarray(8, 10)]).toEqual([(2 << 2) | 1, 0x02]);
    expect(() => serializeAhx(hvlSong({ restart: 0x400 }))).toThrow(AhxEncodeError);
  });

  it('writes a wholly zero step as the single byte 0x3f and any other step as five bytes', () => {
    const track = [step(), step({ note: 61, instrument: 200, fx: 9, fxParam: 0x12, fxb: 7, fxbParam: 0x34 })];
    const bytes = serializeAhx(hvlSong({ tracks: [blankTrack(2), track] }));
    const at = 16 + 12; // header + 1 position (6 channels)
    expect([...bytes.subarray(at, at + 6)]).toEqual([0x3f, 61, 200, (9 << 4) | 7, 0x12, 0x34]);
    expect(parseAhx(bytes).tracks[1]).toEqual(track);
  });

  it('keeps note and instrument as full bytes', () => {
    const track = [step({ note: 255, instrument: 255, fx: 15, fxParam: 255, fxb: 15, fxbParam: 255 }), step({ note: 0x3e, instrument: 0x80 })];
    const song = hvlSong({ tracks: [blankTrack(2), track] });
    expect(parseAhx(serializeAhx(song))).toEqual(song);
  });

  it('refuses a non-blank step whose note is 0x3f (the blank-step escape)', () => {
    const track = [step({ note: 0x3f, instrument: 1 }), step()];
    expect(() => serializeAhx(hvlSong({ tracks: [blankTrack(2), track] }))).toThrow(/reserves/);
  });

  it('writes PList entries five bytes wide with 4-bit commands', () => {
    const plist = { speed: 2, entries: [entry({ fx: [9, 14], fxParam: [1, 2], waveform: 7, note: 63, fixed: true })] };
    const song = hvlSong({ instruments: [placeholder(), ins({ plist })] });
    expect(parseAhx(serializeAhx(song)).instruments[1]!.plist.entries).toEqual(plist.entries);
    // the same command is not codable in AHX
    expect(() => serializeAhx(ahxSong({ instruments: [placeholder(), ins({ plist })] }))).toThrow(/instrument 1/);
  });

  it('requires mixgainRaw and defstereo bytes; AHX refuses to carry them', () => {
    const missing = hvlSong();
    delete missing.mixgainRaw;
    expect(() => serializeAhx(missing)).toThrow(AhxEncodeError);
    expect(() => serializeAhx(hvlSong({ defstereo: 256 }))).toThrow(AhxEncodeError);
    expect(() => serializeAhx(ahxSong({ mixgainRaw: 1 }))).toThrow(AhxEncodeError);
  });
});

describe('serializeAhx: base', () => {
  /** The core of the last instrument sits right before the string table (when it has no PList entries). */
  const lastCore = (bytes: Uint8Array): number => nameOffsetOf(bytes) - 22;
  const inert = (bytes: Uint8Array, at: number) => [bytes[at + 9], bytes[at + 10], bytes[at + 11], bytes[at + 19]! & 0xc0];

  it('copies the loader-ignored instrument bits from the base and never overrides the model', () => {
    for (const make of [ahxSong, hvlSong]) {
      const song = make();
      const base = serializeAhx(song);
      const at = lastCore(base);
      base[at + 9] = 0x11;
      base[at + 10] = 0x22;
      base[at + 11] = 0x33;
      base[at + 19] = 0xc0 | 0x05; // 0x05 is the filter upper limit; the model says 0
      const out = serializeAhx(song, { base });
      expect(inert(out, at), song.format).toEqual([0x11, 0x22, 0x33, 0xc0]);
      expect(out[at + 19]! & 0x3f, 'model value wins').toBe(0);
    }
  });

  it('copies them onto the right instruments by walking the base (HVL steps and PList widths included), also after an edit that changes lengths', () => {
    const track = [step(), step({ note: 5, instrument: 1, fx: 1, fxParam: 2 })];
    for (const make of [ahxSong, hvlSong]) {
      const width = make === hvlSong ? 5 : 4;
      const plist = { speed: 1, entries: [entry({ fx: [1, 2] }), entry()] };
      const song = make({
        tracks: [blankTrack(2), track],
        instrumentNr: 2,
        instruments: [placeholder(), ins({ name: 'a', plist }), ins({ name: 'b' })],
      });
      const base = serializeAhx(song);
      const second = lastCore(base);
      const first = second - (22 + 2 * width);
      base[first + 10] = 0x77;
      base[second + 10] = 0x88;
      const edited = clone(song);
      edited.instruments[1]!.plist.entries.push(entry({ note: 9 })); // the first instrument grows by one entry
      const out = serializeAhx(edited, { base });
      expect(out[first + 10], `${song.format} first`).toBe(0x77);
      expect(out[second + width + 10], `${song.format} second, shifted by the growth`).toBe(0x88);
    }
  });

  it('writes zero inert bits for an instrument the base does not have', () => {
    const base = serializeAhx(ahxSong());
    base[lastCore(base) + 9] = 0x55;
    const bigger = ahxSong({ instrumentNr: 2, instruments: [placeholder(), ins({ name: 'lead' }), ins({ name: 'extra' })] });
    const out = serializeAhx(bigger, { base });
    const second = lastCore(out);
    expect(out[second - 22 + 9]).toBe(0x55);
    expect([out[second + 9], out[second + 10], out[second + 11]]).toEqual([0, 0, 0]);
  });

  it('refuses a base of the other format, and a base that is not an AHX/HVL file', () => {
    expect(() => serializeAhx(ahxSong(), { base: serializeAhx(hvlSong()) })).toThrow(/HVL file but the song is AHX/);
    expect(() => serializeAhx(hvlSong(), { base: serializeAhx(ahxSong()) })).toThrow(/AHX file but the song is HVL/);
    expect(() => serializeAhx(ahxSong(), { base: new Uint8Array(40) })).toThrow(/not an AHX/);
    expect(() => serializeAhx(ahxSong(), { base: new Uint8Array(3) })).toThrow(/not an AHX/);
  });

  it('tolerates a truncated base: instruments it cannot hold get zero inert bits', () => {
    const song = ahxSong();
    const full = serializeAhx(song);
    const truncated = full.subarray(0, lastCore(full) + 10);
    expect(serializeAhx(song, { base: truncated })).toEqual(full);
  });
});

describe('serializeAhx: refusals', () => {
  const cases: [string, () => AhxSong][] = [
    ['positionNr > 1000', () => ahxSong({ positionNr: 1001, positions: positions(1001) })],
    ['trackLength > 64', () => ahxSong({ trackLength: 65, tracks: [blankTrack(65), blankTrack(65)] })],
    ['instrumentNr > 64', () => ahxSong({ instrumentNr: 65, instruments: Array.from({ length: 66 }, () => ins()) })],
    ['trackNr against tracks.length', () => ahxSong({ trackNr: 2 })],
    ['instrumentNr against instruments.length', () => ahxSong({ instrumentNr: 2 })],
    ['positionNr against positions.length', () => ahxSong({ positionNr: 2 })],
    ['subsongNr against subsongs.length', () => ahxSong({ subsongNr: 1 })],
    ['a track of the wrong length', () => ahxSong({ tracks: [blankTrack(2), blankTrack(3)] })],
    ['a position with 3 channels', () => ahxSong({ positions: [{ track: [1, 1, 1], transpose: [0, 0, 0] }] })],
    ['a position with 5 channels', () => ahxSong({ positions: [{ track: [1, 1, 1, 1, 1], transpose: [0, 0, 0, 0, 0] }] })],
    ['a position with mismatched transpose', () => ahxSong({ positions: [{ track: [1, 1, 1, 1], transpose: [0, 0, 0] }] })],
    ['AHX with 5 channels', () => ahxSong({ channels: 5 })],
    ['a second effect column in AHX', () => ahxSong({ tracks: [blankTrack(2), [step({ fxb: 1 }), step()]] })],
    ['a second effect parameter in AHX', () => ahxSong({ tracks: [blankTrack(2), [step({ fxbParam: 1 }), step()]] })],
    ['AHX note 64', () => ahxSong({ tracks: [blankTrack(2), [step({ note: 64 }), step()]] })],
    ['AHX instrument 64', () => ahxSong({ tracks: [blankTrack(2), [step({ instrument: 64 }), step()]] })],
    ['fx 16', () => ahxSong({ tracks: [blankTrack(2), [step({ fx: 16 }), step()]] })],
    ['fx parameter 256', () => ahxSong({ tracks: [blankTrack(2), [step({ fxParam: 256 }), step()]] })],
    ['a negative note', () => ahxSong({ tracks: [blankTrack(2), [step({ note: -1 }), step()]] })],
    ['a fractional note', () => ahxSong({ tracks: [blankTrack(2), [step({ note: 1.5 }), step()]] })],
    ['a NaN parameter', () => ahxSong({ tracks: [blankTrack(2), [step({ fxParam: NaN }), step()]] })],
    ['transpose 128', () => ahxSong({ positions: [{ track: [1, 1, 1, 1], transpose: [128, 0, 0, 0] }] })],
    ['transpose -129', () => ahxSong({ positions: [{ track: [1, 1, 1, 1], transpose: [-129, 0, 0, 0] }] })],
    ['a track index above 255', () => ahxSong({ positions: [{ track: [256, 1, 1, 1], transpose: [0, 0, 0, 0] }] })],
    ['a subsong start above 65535', () => ahxSong({ subsongNr: 1, subsongs: [0x10000] })],
    ['restart above 65535', () => ahxSong({ restart: 0x10000 })],
    ['AHX version 3', () => ahxSong({ version: 3 })],
    ['HVL version 2', () => hvlSong({ version: 2 })],
    ['speedMultiplier 0', () => ahxSong({ speedMultiplier: 0 })],
    ['speedMultiplier 5', () => ahxSong({ speedMultiplier: 5 })],
    ['an unknown format', () => ahxSong({ format: 'mod' as unknown as 'ahx' })],
    ['a PList command AHX cannot hold', () => ahxSong({ instruments: [placeholder(), ins({ plist: { speed: 1, entries: [entry({ fx: [7, 0] })] } })] })],
    ['an instrument field out of range', () => ahxSong({ instruments: [placeholder(), ins({ waveLength: 8 })] })],
    [
      'a PList of 256 entries',
      () => ahxSong({ instruments: [placeholder(), ins({ plist: { speed: 1, entries: Array.from({ length: 256 }, () => entry()) } })] }),
    ],
    ['a body past the 16-bit nameOffset', () => oversizeSong()],
    ['HVL note 256', () => hvlSong({ tracks: [blankTrack(2), [step({ note: 256 }), step()]] })],
    ['HVL fxb 16', () => hvlSong({ tracks: [blankTrack(2), [step({ fxb: 16 }), step()]] })],
    ['HVL position with the wrong channel count', () => hvlSong({ positions: [{ track: [1, 1, 1, 1], transpose: [0, 0, 0, 0] }] })],
  ];

  function oversizeSong(): AhxSong {
    const big = ins({ plist: { speed: 1, entries: Array.from({ length: 255 }, () => entry()) } });
    return ahxSong({ instrumentNr: 64, instruments: [placeholder(), ...Array.from({ length: 64 }, () => clone(big))] });
  }

  it.each(cases)('refuses %s with AhxEncodeError, returns nothing and leaves its input untouched', (_name, make) => {
    const song = make();
    const before = clone(song);
    let out: Uint8Array | undefined;
    expect(() => {
      out = serializeAhx(song);
    }).toThrow(AhxEncodeError);
    expect(out).toBeUndefined();
    expect(clone(song)).toEqual(before);
  });

  it('refuses late: a bad last instrument after valid patterns still produces no output', () => {
    const song = ahxSong({ instrumentNr: 2, instruments: [placeholder(), ins({ name: 'ok' }), ins({ volume: 999 })] });
    expect(() => serializeAhx(song)).toThrow(/instrument 2/);
  });

  it('the size limit is a clear error, not a wrapped nameOffset', () => {
    expect(() => serializeAhx(oversizeSong())).toThrow(/song too large/);
  });
});

// ---------------------------------------------------------------------------------------------
// Read-back property: for random valid songs, parse(serialize(s)) deep-equals s.

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomSong(rand: () => number, format: 'ahx' | 'hvl'): AhxSong {
  const int = (n: number): number => Math.floor(rand() * n);
  const chance = (p: number): boolean => rand() < p;
  const isAhx = format === 'ahx';
  const version = int(isAhx ? 3 : 2);
  const channels = isAhx ? 4 : chance(0.1) ? 67 : 4 + int(13);
  const positionNr = chance(0.05) ? 250 + int(20) : int(6);
  const trackLength = 1 + int(6);
  const trackNr = int(5);
  const instrumentNr = int(4);
  const subsongNr = int(3);
  const name = (): string => Array.from({ length: int(8) }, () => String.fromCharCode(1 + int(255))).join('');

  const randomStep = (): AhxStep => {
    if (chance(0.4)) return step();
    if (isAhx) return step({ note: int(64), instrument: int(64), fx: int(16), fxParam: int(256) });
    const note = int(256);
    return step({ note: note === 0x3f ? 0x3e : note, instrument: int(256), fx: int(16), fxParam: int(256), fxb: int(16), fxbParam: int(256) });
  };
  const commands = isAhx ? [0, 1, 2, 3, 4, 5, 12, 15] : Array.from({ length: 16 }, (_, i) => i);
  const randomEntry = (): AhxPListEntry => {
    const fx: [number, number] = [commands[int(commands.length)]!, commands[int(commands.length)]!];
    // A version-0 AHX file's loader drops the high nibble of a filter-toggle parameter.
    const param = (slot: 0 | 1): number => (isAhx && version === 0 && fx[slot] === 4 ? int(16) : int(256));
    return entry({ note: int(64), waveform: int(8), fixed: chance(0.5), fx, fxParam: [param(0), param(1)] });
  };
  const randomIns = (): AhxInstrument =>
    ins({
      name: name(),
      volume: int(256),
      waveLength: int(8),
      filterLowerLimit: int(128),
      filterUpperLimit: int(64),
      filterSpeed: int(64),
      squareLowerLimit: int(256),
      squareUpperLimit: int(256),
      squareSpeed: int(256),
      vibratoDelay: int(256),
      vibratoSpeed: int(256),
      vibratoDepth: int(16),
      hardCutRelease: chance(0.5),
      hardCutReleaseFrames: int(8),
      envelope: {
        aFrames: int(256),
        aVolume: int(256),
        dFrames: int(256),
        dVolume: int(256),
        sFrames: int(256),
        rFrames: int(256),
        rVolume: int(256),
      },
      plist: { speed: int(256), entries: Array.from({ length: int(6) }, randomEntry) },
    });

  const tracks: AhxTrack[] = Array.from({ length: trackNr + 1 }, (_, i) =>
    i === 0 && chance(0.5) ? blankTrack(trackLength) : Array.from({ length: trackLength }, randomStep),
  );
  return {
    format,
    version,
    name: name(),
    channels,
    positionNr,
    restart: positionNr > 0 ? int(positionNr) : 0,
    speedMultiplier: 1 + int(4),
    trackLength,
    trackNr,
    instrumentNr,
    subsongNr,
    subsongs: Array.from({ length: subsongNr }, () => (isAhx ? (positionNr > 0 ? int(positionNr) : 0) : int(2000))),
    positions: Array.from({ length: positionNr }, () => ({
      track: Array.from({ length: channels }, () => int(trackNr + 1)),
      transpose: Array.from({ length: channels }, () => int(256) - 128),
    })),
    tracks,
    instruments: [placeholder(), ...Array.from({ length: instrumentNr }, randomIns)],
    ...(isAhx ? {} : { mixgainRaw: int(256), defstereo: int(256) }),
  };
}

describe('serializeAhx: read-back property', () => {
  it.each(['ahx', 'hvl'] as const)('parse(serialize(s)) deep-equals s for 150 seeded random %s songs', (format) => {
    const rand = mulberry32(format === 'ahx' ? 0xa11c : 0x11d5);
    for (let i = 0; i < 150; i++) {
      const song = randomSong(rand, format);
      const bytes = serializeAhx(song);
      expect(parseAhx(bytes), `${format} #${i}`).toEqual(song);
      // and it is a fixed point, with and without the bytes as base
      expect(serializeAhx(parseAhx(bytes)), `${format} #${i} fixed point`).toEqual(bytes);
      expect(serializeAhx(parseAhx(bytes), { base: bytes }), `${format} #${i} fixed point with base`).toEqual(bytes);
    }
  });
});
